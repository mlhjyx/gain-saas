import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { EngineTokenSigner } from './engine-token.signer.js';
import { EventConsumerService } from './event-consumer.service.js';

const WORKSPACE = '33fe8b32-e417-4355-af91-96fc042d59e0';
const OTHER_WORKSPACE = '22578ceb-26b4-4fbc-b814-8e8cf5b70048';
const FIRST = '47dfb9b2-cdca-490f-b36b-bab68e019a50';
const SECOND = '46ecb9d9-1d64-46de-8a14-26bbcae3f311';
const RUN = '21f3c0a1-e005-4d8f-9d06-75224ed4abc3';
const OCCURRED_AT = new Date('2026-10-01T08:30:00.000Z');

function completion(eventId: string, fields: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    workspace_id: WORKSPACE,
    event_type: 'DiscoveryRunCompleted',
    aggregate_id: RUN,
    schema_version: 1,
    occurred_at: OCCURRED_AT.toISOString(),
    payload: { status: 'DONE', cost: 0.42 },
    ...fields,
  };
}

interface InboxRow {
  eventId: string;
  workspaceId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  aggregateId?: string | null;
  schemaVersion?: number | null;
  projectionStatus?: 'PENDING' | 'APPLIED' | 'QUARANTINED' | null;
  projectionAttempts?: number;
  projectionNextAttemptAt?: Date | null;
  projectionError?: string | null;
  ackedAt?: Date | null;
}

function worker(seed: InboxRow[] = []) {
  const rows = new Map(seed.map((row) => [row.eventId, row]));
  const notifications: unknown[] = [];
  const costs = new Map<string, unknown>();
  let failNotification = false;
  let cursor: string | null = null;
  let delivered: unknown[] = [];
  let failedAck = false;
  const acknowledged: string[][] = [];
  const create = async ({ data }: { data: InboxRow }) => {
    rows.set(data.eventId, { ...data });
    return data;
  };
  type Where = {
    eventId?: string | { in: string[] };
    workspaceId?: string;
    projectionStatus?: InboxRow['projectionStatus'];
    projectionAttempts?: number;
    projectionNextAttemptAt?: { lte: Date };
    ackedAt?: null;
  };
  const matches = (row: InboxRow, where: Where) => {
    const eventId = where.eventId;
    return (!eventId || (typeof eventId === 'string' ? row.eventId === eventId : eventId.in.includes(row.eventId))) &&
      (where.workspaceId === undefined || row.workspaceId === where.workspaceId) &&
      (where.projectionStatus === undefined || row.projectionStatus === where.projectionStatus) &&
      (where.projectionAttempts === undefined || row.projectionAttempts === where.projectionAttempts) &&
      (where.ackedAt !== null || row.ackedAt == null) &&
      (!where.projectionNextAttemptAt ||
        (row.projectionNextAttemptAt != null && row.projectionNextAttemptAt <= where.projectionNextAttemptAt.lte));
  };
  const inbox = {
    findUnique: async ({ where }: { where: { eventId: string } }) => rows.get(where.eventId) ?? null,
    findMany: async ({ where, take }: { where: Where; take: number }) =>
      [...rows.values()].filter((row) => matches(row, where)).slice(0, take),
    create,
    createMany: async ({ data }: { data: InboxRow }) => {
      if (rows.has(data.eventId)) return { count: 0 };
      await create({ data });
      return { count: 1 };
    },
    updateMany: async ({ where, data }: { where: Where; data: Partial<InboxRow> }) => {
      let count = 0;
      for (const row of rows.values()) {
        if (!matches(row, where)) continue;
        rows.set(row.eventId, { ...row, ...data });
        count += 1;
      }
      return { count };
    },
  };
  const prisma = {
    workspaceRegistry: {
      findMany: async () => [{ workspaceId: WORKSPACE, cursor }],
      update: async ({ data }: { data: { cursor: string | null } }) => { cursor = data.cursor; },
    },
    eventInbox: inbox,
    $transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const before = new Map(rows);
      const stagedNotifications: unknown[] = [];
      const stagedCosts: Array<{ sourceEventId: string; occurredAt: Date }> = [];
      try {
        await fn({
          eventInbox: inbox,
          taskRun: { updateMany: async () => ({ count: 1 }) },
          notification: { create: async ({ data }: { data: unknown }) => {
            if (failNotification) {
              failNotification = false;
              throw new Error('synthetic temporary failure');
            }
            stagedNotifications.push(data);
          } },
          costLedger: { createMany: async ({ data }: { data: typeof stagedCosts }) => { stagedCosts.push(...data); } },
        });
      } catch (error) {
        rows.clear();
        for (const [id, row] of before) rows.set(id, row);
        throw error;
      }
      notifications.push(...stagedNotifications);
      for (const cost of stagedCosts) {
        if (!costs.has(cost.sourceEventId)) costs.set(cost.sourceEventId, cost);
      }
    },
  } as unknown as PrismaService;
  const config = {
    EVENT_CONSUMER_ENABLED: true,
    EVENT_CONSUMER_PAGE_LIMIT: 100,
    ENGINE_ORIGIN: 'http://engine.test',
  } as AppConfig;
  const signer = { mint: async () => 'synthetic' } as unknown as EngineTokenSigner;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/ack')) {
      const ids = JSON.parse(init.body as string).event_ids as string[];
      acknowledged.push(ids);
      if (failedAck) throw new Error('synthetic ACK timeout');
      return Response.json({ data: { acked: ids.length } });
    }
    const page = new URL(url).searchParams.get('cursor') === '42' ? [] : delivered;
    return Response.json({
      data: page,
      page: { next_cursor: page.length ? '42' : null, has_more: page.length > 0 },
    });
  });
  return {
    tick: () => new EventConsumerService(config, signer, prisma).consumeOnce(),
    receive: (events: unknown[]) => { delivered = events; },
    failNextProjection: () => { failNotification = true; },
    timeoutAck: (timeout: boolean) => { failedAck = timeout; },
    cursor: () => cursor,
    acknowledged,
    rows,
    notifications,
    costs,
  };
}

function pending(eventId: string, workspaceId = WORKSPACE): InboxRow {
  return {
    eventId,
    workspaceId,
    type: 'DiscoveryRunCompleted',
    payload: { status: 'DONE', cost: 0.42 },
    occurredAt: OCCURRED_AT,
    aggregateId: RUN,
    schemaVersion: 1,
    projectionStatus: 'PENDING',
    projectionAttempts: 0,
    projectionNextAttemptAt: OCCURRED_AT,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('recoverable event projections', () => {
  it('resumes committed pending work after restart without engine redelivery and without crossing tenants', async () => {
    const h = worker([pending(FIRST), pending(SECOND, OTHER_WORKSPACE)]);
    await h.tick();
    await h.tick();

    expect(h.rows.get(FIRST)?.projectionStatus).toBe('APPLIED');
    expect(h.rows.get(SECOND)?.projectionStatus).toBe('PENDING');
    expect(h.acknowledged).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    expect([...h.costs.values()]).toEqual([expect.objectContaining({ occurredAt: OCCURRED_AT })]);
  });

  it('rolls back a failed projection, advances after ACK and retries independently without duplicating cost', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    const h = worker();
    h.failNextProjection();
    h.receive([completion(FIRST), completion(SECOND)]);
    await h.tick();

    expect(h.rows.get(FIRST)?.projectionStatus).toBe('PENDING');
    expect(h.rows.get(SECOND)?.projectionStatus).toBe('APPLIED');
    expect(h.acknowledged[0]).toEqual([FIRST, SECOND]);
    expect(h.cursor()).toBe('42');
    expect(h.costs.has(FIRST)).toBe(false);
    expect(h.notifications).toHaveLength(1);

    h.receive([]);
    vi.setSystemTime(new Date('2026-11-11T12:10:00Z'));
    await h.tick();
    await h.tick();

    expect(h.rows.get(FIRST)?.projectionStatus).toBe('APPLIED');
    expect(h.notifications).toHaveLength(2);
    expect(h.costs.size).toBe(2);
  });

  it('leaves the cursor in place after ACK timeout and does not repeat committed effects on redelivery', async () => {
    const h = worker();
    h.receive([completion(FIRST)]);
    h.timeoutAck(true);
    await h.tick();
    expect(h.cursor()).toBe(null);

    h.timeoutAck(false);
    await h.tick();
    expect(h.cursor()).toBe('42');
    expect(h.rows.get(FIRST)?.projectionStatus).toBe('APPLIED');
    expect(h.notifications).toHaveLength(1);
    expect(h.costs.size).toBe(1);
  });

  it('ACKs only valid tenant events and quarantines an unknown terminal state without projecting it', async () => {
    const h = worker();
    h.receive([
      completion('invalid'),
      completion(FIRST, { workspace_id: OTHER_WORKSPACE }),
      completion(SECOND, { payload: { status: 'UNKNOWN', cost: 0.42 } }),
    ]);
    await h.tick();

    expect(h.acknowledged[0]).toEqual([SECOND]);
    expect([...h.rows.keys()]).toEqual([SECOND]);
    expect(h.rows.get(SECOND)?.projectionStatus).toBe('QUARANTINED');
    expect(h.costs.size).toBe(0);
    expect(h.notifications).toHaveLength(0);
  });

  it('keeps an unsupported schema version and does not ACK a receipt owned by another workspace', async () => {
    const h = worker([pending(FIRST, OTHER_WORKSPACE)]);
    h.receive([completion(FIRST), completion(SECOND, { schema_version: 99 })]);
    await h.tick();

    expect(h.acknowledged[0]).toEqual([SECOND]);
    expect(h.rows.get(FIRST)).toMatchObject({ workspaceId: OTHER_WORKSPACE, projectionStatus: 'PENDING' });
    expect(h.rows.get(SECOND)).toMatchObject({
      schemaVersion: 99,
      projectionStatus: 'QUARANTINED',
      projectionError: 'UNSUPPORTED_SCHEMA_VERSION',
    });
    expect(h.notifications).toHaveLength(0);
  });

  it('quarantines a repeatedly failing event after the fifth failed projection and stops retrying it', async () => {
    const h = worker([{ ...pending(FIRST), projectionAttempts: 4 }]);
    h.failNextProjection();
    await h.tick();
    await h.tick();

    expect(h.rows.get(FIRST)).toMatchObject({
      projectionStatus: 'QUARANTINED',
      projectionAttempts: 5,
      projectionNextAttemptAt: null,
      projectionError: 'PROJECTION_FAILED',
    });
    expect(h.notifications).toHaveLength(0);
    expect(h.costs.size).toBe(0);
  });

  it('retains pre-migration rows without assuming that their projection can be replayed', async () => {
    const h = worker([{ ...pending(FIRST), projectionStatus: null, projectionNextAttemptAt: null }]);
    h.receive([completion(FIRST)]);
    await h.tick();

    expect(h.acknowledged[0]).toEqual([FIRST]);
    expect(h.rows.get(FIRST)?.projectionStatus).toBe(null);
    expect(h.notifications).toHaveLength(0);
    expect(h.costs.size).toBe(0);
  });
});
