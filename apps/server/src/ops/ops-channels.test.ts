import { HttpException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { OPS_ENGINE_WORKSPACE } from '../service/engine-token.signer.js';
import { OpsChannelsService } from './ops-channels.service.js';
import { OpsEngineClient } from './ops-engine.client.js';

function makeService(results: Record<string, { status: number; body: unknown }> = {}) {
  const calls: Array<{ actorId: string; method: string; path: string; body?: unknown }> = [];
  const engine = {
    call: vi.fn(async (actorId: string, method: string, path: string, options: { body?: unknown } = {}) => {
      calls.push({ actorId, method, path, body: options.body });
      return results[path] ?? { status: 200, body: { data: { id: '11111111-1111-4111-8111-111111111111', name: 'import-pump' } } };
    }),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new OpsChannelsService(engine as never, audit as never);
  return { service, engine, audit, calls };
}

describe('OpsChannelsService（P3 数据源归属）', () => {
  it('list 解包 data 并对引擎错误透传状态码与错误码', async () => {
    const { service } = makeService({
      '/source-channels': { status: 200, body: { data: [{ id: '11111111-1111-4111-8111-111111111111' }] } },
    });
    await expect(service.list('op-1')).resolves.toEqual([{ id: '11111111-1111-4111-8111-111111111111' }]);

    const denied = makeService({
      '/source-channels': { status: 403, body: { error: { code: 'SCOPE_REQUIRED', message: 'missing ops:read' } } },
    });
    const error = await denied.service.list('op-1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(403);
    expect((error as HttpException).getResponse()).toEqual({
      error: { code: 'SCOPE_REQUIRED', message: 'missing ops:read' },
    });
  });

  it('records 透传 GET /source-channels/:id/records 并夹取 limit（不写审计）', async () => {
    const { service, calls, audit } = makeService({
      '/source-channels/11111111-1111-4111-8111-111111111111/records?limit=50': {
        status: 200,
        body: { data: { channelId: '11111111-1111-4111-8111-111111111111', records: [{ id: 'rec-1', name: 'Acme' }] } },
      },
    });
    await expect(service.records('op-1', '11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      channelId: '11111111-1111-4111-8111-111111111111',
      records: [{ id: 'rec-1', name: 'Acme' }],
    });
    expect(calls[0]).toMatchObject({ actorId: 'op-1', method: 'GET', path: '/source-channels/11111111-1111-4111-8111-111111111111/records?limit=50' });
    expect(audit.record).not.toHaveBeenCalled();

    // 非法 limit 回退为默认 50，不进入 path 注入。
    const second = makeService();
    await second.service.records('op-1', '11111111-1111-4111-8111-111111111111', '99999; DROP');
    expect(second.calls[0]!.path).toBe('/source-channels/11111111-1111-4111-8111-111111111111/records?limit=50');

    // 支持按 reviewStatus 过滤，非法值 400 拒绝。
    const filtered = makeService();
    await filtered.service.records('op-1', '11111111-1111-4111-8111-111111111111', '20', 'PENDING');
    expect(filtered.calls[0]!.path).toBe(
      '/source-channels/11111111-1111-4111-8111-111111111111/records?limit=20&reviewStatus=PENDING',
    );
    const badStatus = await filtered.service
      .records('op-1', '11111111-1111-4111-8111-111111111111', '20', 'INVALID_STATUS')
      .catch((err: unknown) => err);
    expect(badStatus).toBeInstanceOf(HttpException);
    expect((badStatus as HttpException).getStatus()).toBe(400);
  });

  it('reviewRecords 校验 UUID 与 body，成功后透传并落 ops 审计，冲突时也留审计并抛原状态码', async () => {
    const channelId = '11111111-1111-4111-8111-111111111111';
    const rec1 = '22222222-2222-4222-8222-222222222222';
    const rec2 = '33333333-3333-4333-8333-333333333333';
    const hash1 = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);

    // 1. 非法 channelId / 空 recordIds / 重复 recordIds / 不匹配的 expectedContentHashes 均 400 且不发引擎调用
    const invalid = makeService();
    for (const [cid, payload] of [
      ['../escape', { recordIds: [rec1], verdict: 'APPROVED' }],
      [channelId, { recordIds: [], verdict: 'APPROVED' }],
      [channelId, { recordIds: [rec1, rec1], verdict: 'APPROVED' }],
      [channelId, { recordIds: [rec1], verdict: 'MAYBE' }],
      [channelId, { recordIds: [rec1, rec2], verdict: 'APPROVED', expectedContentHashes: { [rec1]: hash1 } }],
    ] as const) {
      const err = await invalid.service.reviewRecords('op-1', cid, payload).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(400);
    }
    expect(invalid.engine.call).not.toHaveBeenCalled();

    // 2. 正常批量通过
    const ok = makeService({
      [`/source-channels/${channelId}/records/review`]: {
        status: 200,
        body: {
          data: {
            channelId,
            reviewed: 2,
            verdict: 'APPROVED',
            counts: { PENDING: 0, APPROVED: 2, REJECTED: 0 },
            autoDisabled: false,
          },
        },
      },
    });
    const res = await ok.service.reviewRecords('op-1', channelId, {
      recordIds: [rec1, rec2],
      verdict: 'APPROVED',
      expectedContentHashes: { [rec1]: hash1, [rec2]: hash2 },
    });
    expect(res).toMatchObject({ channelId, reviewed: 2, verdict: 'APPROVED', autoDisabled: false });
    expect(ok.engine.call).toHaveBeenCalledWith(
      'op-1',
      'POST',
      `/source-channels/${channelId}/records/review`,
      {
        body: {
          recordIds: [rec1, rec2],
          verdict: 'APPROVED',
          expectedContentHashes: { [rec1]: hash1, [rec2]: hash2 },
        },
      },
    );
    expect(ok.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        realm: 'ops',
        actorId: 'op-1',
        action: 'channel.records.review',
        target: channelId,
        detail: expect.objectContaining({
          verdict: 'APPROVED',
          recordCount: 2,
          engineStatus: 200,
          reviewed: 2,
          autoDisabled: false,
        }),
      }),
    );

    // 3. 引擎返回 409 版本冲突：仍写审计并原样抛出 409
    const conflict = makeService({
      [`/source-channels/${channelId}/records/review`]: {
        status: 409,
        body: { error: { code: 'CHANNEL_RECORD_VERSION_CONFLICT', message: 'reload and retry' } },
      },
    });
    const err = await conflict.service
      .reviewRecords('op-1', channelId, { recordIds: [rec1], verdict: 'REJECTED' })
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(409);
    expect(conflict.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'channel.records.review',
        target: channelId,
        detail: expect.objectContaining({
          verdict: 'REJECTED',
          recordCount: 1,
          engineStatus: 409,
          engineCode: 'CHANNEL_RECORD_VERSION_CONFLICT',
        }),
      }),
    );
  });

  it('create 先做形状校验（缺 name 不发引擎调用），成功后写 ops 审计', async () => {
    const { service, engine, audit } = makeService();
    const invalid = await service.create('op-1', { mode: 'import', category: 'directory' }).catch((err: unknown) => err);
    expect(invalid).toBeInstanceOf(HttpException);
    expect((invalid as HttpException).getStatus()).toBe(400);
    expect(engine.call).not.toHaveBeenCalled();

    const created = await service.create('op-1', {
      name: 'import-pump',
      mode: 'import',
      category: 'directory',
    });
    expect(created).toEqual({ id: '11111111-1111-4111-8111-111111111111', name: 'import-pump' });
    expect(engine.call).toHaveBeenCalledWith('op-1', 'POST', '/source-channels', {
      body: { name: 'import-pump', mode: 'import', category: 'directory', config: {} },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ realm: 'ops', actorId: 'op-1', action: 'channel.create', target: '11111111-1111-4111-8111-111111111111' }),
    );
  });

  it('patch 拒绝空更新，成功后审计字段清单', async () => {
    const { service, engine, audit } = makeService();
    const empty = await service.patch('op-1', '11111111-1111-4111-8111-111111111111', {}).catch((err: unknown) => err);
    expect(empty).toBeInstanceOf(HttpException);
    expect(engine.call).not.toHaveBeenCalled();

    await service.patch('op-1', '11111111-1111-4111-8111-111111111111', { status: 'ENABLED', license: 'L-1' });
    expect(engine.call).toHaveBeenCalledWith('op-1', 'PATCH', '/source-channels/11111111-1111-4111-8111-111111111111', {
      body: { status: 'ENABLED', license: 'L-1' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'channel.patch',
        target: '11111111-1111-4111-8111-111111111111',
        detail: { fields: ['status', 'license'], status: 'ENABLED' },
      }),
    );
  });

  it('manifest 创建：name 可省略（引擎从 manifest.meta 派生），审计带 manifestSha256', async () => {
    const { service, engine, audit } = makeService({
      '/source-channels': { status: 201, body: { data: { id: 'ch-9', name: 'SAM.gov', manifestSha256: 'a'.repeat(64) } } },
    });
    const created = await service.create('op-1', { manifest: { meta: { name: 'SAM.gov' }, transport: {} } });
    expect(created).toEqual({ id: 'ch-9', name: 'SAM.gov', manifestSha256: 'a'.repeat(64) });
    expect(engine.call).toHaveBeenCalledWith('op-1', 'POST', '/source-channels', {
      body: { manifest: { meta: { name: 'SAM.gov' }, transport: {} } },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'channel.create',
        target: 'ch-9',
        detail: expect.objectContaining({ name: 'SAM.gov', mode: 'api', manifestSha256: 'a'.repeat(64) }),
      }),
    );
  });

  it('patch 接受 manifest 重存（字段清单含 manifest）', async () => {
    const { service, engine, audit } = makeService();
    await service.patch('op-1', '11111111-1111-4111-8111-111111111111', { manifest: { meta: { name: 'X' } } });
    expect(engine.call).toHaveBeenCalledWith('op-1', 'PATCH', '/source-channels/11111111-1111-4111-8111-111111111111', {
      body: { manifest: { meta: { name: 'X' } } },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'channel.patch', detail: { fields: ['manifest'], status: undefined } }),
    );
  });

  it('detail 透传 GET /source-channels/:id（只读不写审计）', async () => {
    const { service, calls, audit } = makeService({
      '/source-channels/11111111-1111-4111-8111-111111111111': { status: 200, body: { data: { id: '11111111-1111-4111-8111-111111111111', auth: { type: 'apiKey', secrets: [] } } } },
    });
    await expect(service.detail('op-1', '11111111-1111-4111-8111-111111111111')).resolves.toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      auth: { type: 'apiKey', secrets: [] },
    });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/source-channels/11111111-1111-4111-8111-111111111111' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('test（保存即测试）：成功与 fail-closed 都写 channel.probe 审计', async () => {
    const ok = makeService({
      '/source-channels/11111111-1111-4111-8111-111111111111/test': {
        status: 200,
        body: { data: { probeId: 'p-1', status: 'SUCCEEDED', recordsFound: 3, errorCode: null } },
      },
    });
    await expect(ok.service.test('op-1', '11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({ status: 'SUCCEEDED', recordsFound: 3 });
    expect(ok.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'channel.probe',
        target: '11111111-1111-4111-8111-111111111111',
        detail: expect.objectContaining({ engineStatus: 200, probeStatus: 'SUCCEEDED', recordsFound: 3 }),
      }),
    );

    const unavailable = makeService({
      '/source-channels/11111111-1111-4111-8111-111111111111/test': {
        status: 503,
        body: { error: { code: 'CHANNEL_TEST_EGRESS_UNAVAILABLE', message: 'not wired' } },
      },
    });
    const error = await unavailable.service.test('op-1', '11111111-1111-4111-8111-111111111111').catch((err: unknown) => err);
    expect((error as HttpException).getStatus()).toBe(503);
    expect(unavailable.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'channel.probe',
        detail: expect.objectContaining({ engineStatus: 503, engineCode: 'CHANNEL_TEST_EGRESS_UNAVAILABLE' }),
      }),
    );
  });

  it('preview/run 的引擎 fail-closed 也留审计并原样抛出 409', async () => {
    const { service, audit } = makeService({
      '/source-channels/11111111-1111-4111-8111-111111111111/preview': {
        status: 409,
        body: { error: { code: 'CHANNEL_CRAWL_REQUIRES_PLATFORM_AUTHORITY', message: 'pending' } },
      },
      '/source-channels/11111111-1111-4111-8111-111111111111/run': {
        status: 409,
        body: { error: { code: 'CHANNEL_CRAWL_REQUIRES_PLATFORM_AUTHORITY', message: 'pending' } },
      },
    });
    for (const action of ['preview', 'run'] as const) {
      const error = await service[action]('op-1', '11111111-1111-4111-8111-111111111111').catch((err: unknown) => err);
      expect((error as HttpException).getStatus()).toBe(409);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: `channel.${action}`,
          target: '11111111-1111-4111-8111-111111111111',
          detail: { engineStatus: 409, engineCode: 'CHANNEL_CRAWL_REQUIRES_PLATFORM_AUTHORITY' },
        }),
      );
    }
  });
});

describe('OpsEngineClient（saas-ops 身份）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('用 saas-ops 角色与哨兵 workspace 铸币，并原样返回引擎响应', async () => {
    const minted: Array<Record<string, unknown>> = [];
    const signer = {
      mint: vi.fn(async (input: Record<string, unknown>) => {
        minted.push(input);
        return 'engine-token';
      }),
    };
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ data: [{ id: '11111111-1111-4111-8111-111111111111' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new OpsEngineClient({ ENGINE_ORIGIN: 'http://engine.test' } as AppConfig, signer as never);
    const result = await client.call('op-9', 'GET', '/source-channels');
    expect(result.status).toBe(200);
    expect(minted[0]).toEqual({
      subjectId: 'op-9',
      workspaceId: OPS_ENGINE_WORKSPACE,
      roles: ['saas-ops'],
    });
    expect(String(requests[0]!.url)).toBe('http://engine.test/api/v1/source-channels');
    expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer engine-token');
  });
});
