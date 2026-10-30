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
    costLedger: { create: vi.fn(async () => ({})) },
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
  return { service: new EventConsumerService(config, signer, prisma), update };
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
