import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import type { EngineTokenSigner } from './engine-token.signer.js';

const WORKSPACE = '33fe8b32-e417-4355-af91-96fc042d59e0';
const EVENT_ID = '47dfb9b2-cdca-490f-b36b-bab68e019a50';

function createService(cursor: string | null) {
  const update = vi.fn(async () => ({}));
  const tx = {
    eventInbox: { create: vi.fn(async () => ({})) },
    notification: { create: vi.fn(async () => ({})) },
    qualifiedLead: { create: vi.fn(async () => ({})) },
    costLedger: { createMany: vi.fn(async () => ({ count: 1 })) },
    taskRun: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  const prisma = {
    workspaceRegistry: {
      findMany: vi.fn(async () => [{ workspaceId: WORKSPACE, cursor }]),
      update,
    },
    eventInbox: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const config = {
    EVENT_CONSUMER_ENABLED: true,
    EVENT_CONSUMER_PAGE_LIMIT: 100,
    ENGINE_ORIGIN: 'http://engine.test',
  } as AppConfig;
  const signer = { mint: vi.fn(async () => 'token') } as unknown as EngineTokenSigner;
  return { service: new EventConsumerService(config, signer, prisma), update, tx };
}

function pageBody(nextCursor: string | null) {
  return {
    data: [
      {
        event_id: EVENT_ID,
        event_type: 'DiscoveryRunCompleted',
        workspace_id: WORKSPACE,
        occurred_at: new Date().toISOString(),
        payload: {},
      },
    ],
    page: { next_cursor: nextCursor, has_more: nextCursor !== null },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EventConsumerService 游标(引擎 page.next_cursor)', () => {
  it('把 page.next_cursor 写进 registry.cursor,下一轮从该位置继续', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pageBody('42')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { acked: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, update } = createService(null);

    const result = await service.consumeOnce();

    expect(result).toEqual({ workspaces: 1, pulled: 1, acked: 1 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE }, data: expect.objectContaining({ cursor: '42' }) }),
    );
    const listUrl = String(fetchMock.mock.calls[0][0]);
    expect(listUrl).toContain('/api/v1/events?');
    expect(listUrl).not.toContain('cursor=');
    const ackUrl = String(fetchMock.mock.calls[1][0]);
    expect(ackUrl).toContain('/api/v1/events/ack');
  });

  it('next_cursor=null 时保留旧游标,不回到开头重放', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pageBody(null)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { acked: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, update } = createService('7');

    await service.consumeOnce();

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE }, data: expect.objectContaining({ cursor: '7' }) }),
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain('cursor=7');
  });

  it('ACK 失败时不推进游标，下一轮重拉同一页', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(pageBody('42')), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, update } = createService('7');

    const result = await service.consumeOnce();

    expect(result.acked).toBe(0);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE }, data: expect.objectContaining({ cursor: '7' }) }),
    );
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cursor: '42' }) }),
    );
  });
});

describe('1b 花费维度：成本落账', () => {
  function eventPage(eventType: string, payload: Record<string, unknown>, occurredAt = '2026-10-01T08:30:00.000Z') {
    return {
      data: [
        {
          event_id: EVENT_ID,
          event_type: eventType,
          workspace_id: WORKSPACE,
          occurred_at: occurredAt,
          payload,
        },
      ],
      page: { next_cursor: null, has_more: false },
    };
  }

  async function consumeSingle(eventType: string, payload: Record<string, unknown>) {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(eventPage(eventType, payload)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { acked: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, tx } = createService(null);
    await service.consumeOnce();
    return tx;
  }

  it('DiscoveryRunCompleted 携带 cost 也会落账（分支早退不再吞掉成本）', async () => {
    const tx = await consumeSingle('DiscoveryRunCompleted', { status: 'DONE', cost: 0.42 });
    expect(tx.costLedger.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          workspaceId: WORKSPACE,
          sourceEventId: EVENT_ID,
          amountMicros: 420_000,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('其它类型事件带 cost 同样落账（落账先于类型分支）', async () => {
    const tx = await consumeSingle('LeadQualified', { lead_id: 'l1', cost_usd: 0.02 });
    expect(tx.costLedger.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ amountMicros: 20_000 })] }),
    );
  });

  it('cost 缺失或非正数不落账', async () => {
    const tx = await consumeSingle('DiscoveryRunCompleted', { status: 'DONE', cost: 0 });
    expect(tx.costLedger.createMany).not.toHaveBeenCalled();
  });

  it('occurredAt 用事件信封的 occurred_at，积压补消费不挤进当前窗口', async () => {
    const tx = await consumeSingle('DiscoveryRunCompleted', { status: 'DONE', cost: 0.42 });
    expect(tx.costLedger.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ occurredAt: new Date('2026-10-01T08:30:00.000Z') })],
      }),
    );
  });

  it('超大 cost 钳到 int4 上限而不是抛错卡死事件流', async () => {
    const tx = await consumeSingle('DiscoveryRunCompleted', { status: 'DONE', cost: 3000 });
    expect(tx.costLedger.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ amountMicros: 2_147_483_647 })] }),
    );
    // 事件本身照常派生（通知），游标可推进。
    expect(tx.notification.create).toHaveBeenCalled();
  });

  it('非有限 cost（Infinity/NaN 字符串转换产物）不落账', async () => {
    const tx = await consumeSingle('DiscoveryRunCompleted', { status: 'DONE', cost: Number.POSITIVE_INFINITY });
    expect(tx.costLedger.createMany).not.toHaveBeenCalled();
  });
});

describe('P1：完成事件回填与停止文案', () => {
  it('backfills engineRunId from payload.taskRef and mirrors CANCELLED', async () => {
    const TASK_RUN_ID = '55555555-5555-4555-8555-555555555555';
    const RUN_ID = '77777777-7777-4777-8777-777777777777';
    const body = {
      data: [
        {
          event_id: EVENT_ID,
          event_type: 'DiscoveryRunCompleted',
          workspace_id: WORKSPACE,
          occurred_at: new Date().toISOString(),
          aggregate_id: RUN_ID,
          payload: { status: 'CANCELLED', taskRef: { taskRunId: TASK_RUN_ID } },
        },
      ],
      page: { next_cursor: null, has_more: false },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { acked: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, tx } = createService(null);

    await service.consumeOnce();

    expect(tx.taskRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: TASK_RUN_ID, engineRunId: null }),
        data: expect.objectContaining({ engineRunId: RUN_ID, status: 'CANCELLED' }),
      }),
    );
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: expect.stringContaining('已停止') }) }),
    );
  });
});

describe('P5：制裁 hold 通知（LeadsScored）', () => {
  async function consumeLeadsScored(payload: Record<string, unknown>) {
    const body = {
      data: [
        {
          event_id: EVENT_ID,
          event_type: 'LeadsScored',
          workspace_id: WORKSPACE,
          occurred_at: new Date().toISOString(),
          aggregate_id: '99999999-9999-4999-8999-999999999999',
          payload,
        },
      ],
      page: { next_cursor: null, has_more: false },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { acked: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, tx } = createService(null);
    await service.consumeOnce();
    return tx;
  }

  it('queues.sanctions_hold > 0 时产生隔离提醒（含计数与 ICP 引用）', async () => {
    const tx = await consumeLeadsScored({ scored: 12, queues: { recommended: 9, sanctions_hold: 3 } });
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE,
        type: 'SanctionsHoldDetected',
        refId: '99999999-9999-4999-8999-999999999999',
        title: expect.stringContaining('3 家'),
      }),
    });
  });

  it('没有命中时不产生制裁通知', async () => {
    const tx = await consumeLeadsScored({ scored: 5, queues: { recommended: 5, sanctions_hold: 0 } });
    expect(tx.notification.create).not.toHaveBeenCalled();
  });
});

describe('P5：配额告警（80% 预警 / 100% 耗尽，每窗口每档一条）', () => {
  function createQuotaService(options: {
    policy?: { windowDays: number; maxRuns: number; maxSpendMicros: bigint; enabled: boolean } | null;
    spentMicros?: number;
    usedRuns?: number;
    existing?: boolean;
    enforce?: boolean;
  }) {
    const notificationCreate = vi.fn(async () => ({}));
    const notificationFindFirst = vi.fn(async () => (options.existing ? { id: 'n1' } : null));
    const prisma = {
      workspaceRegistry: {
        findMany: vi.fn(async () => [{ workspaceId: WORKSPACE, cursor: null }]),
        update: vi.fn(async () => ({})),
      },
      eventInbox: {
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      workspaceBudgetPolicy: { findUnique: vi.fn(async () => options.policy ?? null) },
      costLedger: { aggregate: vi.fn(async () => ({ _sum: { amountMicros: options.spentMicros ?? 0 } })) },
      discoveryRunLink: { count: vi.fn(async () => options.usedRuns ?? 0) },
      notification: { findFirst: notificationFindFirst, create: notificationCreate },
    } as unknown as PrismaService;
    const config = {
      EVENT_CONSUMER_ENABLED: true,
      EVENT_CONSUMER_PAGE_LIMIT: 100,
      ENGINE_ORIGIN: 'http://engine.test',
      WORKSPACE_QUOTA_ENFORCE: options.enforce ?? true,
    } as AppConfig;
    const signer = { mint: vi.fn(async () => 'token') } as unknown as EngineTokenSigner;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [], page: { next_cursor: null, has_more: false } }), { status: 200 }),
      ),
    );
    return { service: new EventConsumerService(config, signer, prisma), notificationCreate, notificationFindFirst };
  }

  const POLICY = { windowDays: 30, maxRuns: 30, maxSpendMicros: 15_000_000n, enabled: true };

  it('花费达到 80% 产生 WorkspaceQuotaWarning（标题带百分比与明细）', async () => {
    const { service, notificationCreate } = createQuotaService({ policy: POLICY, spentMicros: 12_000_000 });
    await service.consumeOnce();
    expect(notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE,
        type: 'WorkspaceQuotaWarning',
        title: expect.stringContaining('80%'),
      }),
    });
  });

  it('运行次数用到上限产生 WorkspaceQuotaExceeded', async () => {
    const { service, notificationCreate } = createQuotaService({ policy: POLICY, usedRuns: 30 });
    await service.consumeOnce();
    expect(notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'WorkspaceQuotaExceeded' }),
    });
  });

  it('同窗口已有同类通知时不重复写入', async () => {
    const { service, notificationCreate } = createQuotaService({
      policy: POLICY,
      spentMicros: 16_000_000,
      existing: true,
    });
    await service.consumeOnce();
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('豁免空间（policy.enabled=false）与未强制（enforce=false）都不发', async () => {
    const exempt = createQuotaService({ policy: { ...POLICY, enabled: false }, spentMicros: 16_000_000 });
    await exempt.service.consumeOnce();
    expect(exempt.notificationCreate).not.toHaveBeenCalled();

    const unenforced = createQuotaService({ policy: POLICY, spentMicros: 16_000_000, enforce: false });
    await unenforced.service.consumeOnce();
    expect(unenforced.notificationCreate).not.toHaveBeenCalled();
  });

  it('低于阈值不发', async () => {
    const { service, notificationCreate } = createQuotaService({
      policy: POLICY,
      spentMicros: 6_000_000,
      usedRuns: 3,
    });
    await service.consumeOnce();
    expect(notificationCreate).not.toHaveBeenCalled();
  });
});
