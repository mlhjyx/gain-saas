import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { OpsDatabase } from '../ops/ops-database.service.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { AdminGuard } from '../tenant/admin.guard.js';
import { WalletController } from './wallet.controller.js';
import { WalletService } from './wallet.service.js';
import {
  InsufficientCreditsError,
  MAX_PG_BIGINT,
  WalletFrozenError,
} from './wallet.types.js';

interface InMemoryWalletDb {
  accounts: Map<string, {
    workspaceId: string;
    currency: string;
    availableCredits: bigint;
    heldCredits: bigint;
    lifetimeToppedUp: bigint;
    lifetimeSpent: bigint;
    status: string;
    version: bigint;
    updatedAt: Date;
  }>;
  lots: Array<{
    id: string;
    workspaceId: string;
    sourceType: string;
    initialCredits: bigint;
    remainingCredits: bigint;
    unitPriceMicros: bigint;
    priority: number;
    expiresAt: Date | null;
    externalOrderId: string | null;
    note: string | null;
    actorId: string | null;
    createdAt: Date;
  }>;
  holds: Array<{
    id: string;
    workspaceId: string;
    idempotencyKey: string;
    actionCode: string;
    refType: string;
    refId: string;
    heldCredits: bigint;
    settledCredits: bigint;
    releasedCredits: bigint;
    status: string;
    expiresAt: Date;
    createdAt: Date;
    settledAt: Date | null;
  }>;
  ledgers: Array<{
    id: string;
    workspaceId: string;
    idempotencyKey: string;
    entryType: string;
    deltaAvailable: bigint;
    deltaHeld: bigint;
    balanceAvailable: bigint;
    balanceHeld: bigint;
    revenueMicros: bigint;
    holdId: string | null;
    lotId: string | null;
    actionCode: string | null;
    refType: string | null;
    refId: string | null;
    billableUnits: number | null;
    note: string | null;
    actorId: string | null;
    createdAt: Date;
  }>;
  priceCards: Array<{
    id: string;
    actionCode: string;
    displayName: string;
    pricingMode: string;
    creditsPerUnit: bigint;
    defaultHoldUnits: number;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

function createMockWalletEnv(options?: {
  billingEnabled?: boolean;
  engineCostRows?: Array<{ workspace_id: string; cost_usd: string | number }>;
  engineUnavailable?: boolean;
}) {
  const db: InMemoryWalletDb = {
    accounts: new Map(),
    lots: [],
    holds: [],
    ledgers: [],
    priceCards: [
      {
        id: randomUUID(),
        actionCode: 'DISCOVERY_QUALIFIED_LEAD',
        displayName: '有效买家线索',
        pricingMode: 'PER_UNIT_OUTCOME',
        creditsPerUnit: 10n,
        defaultHoldUnits: 20,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        active: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: randomUUID(),
        actionCode: 'CONTACT_VALID_EMAIL',
        displayName: '验真有效邮箱',
        pricingMode: 'PER_UNIT_OUTCOME',
        creditsPerUnit: 2n,
        defaultHoldUnits: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        active: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: randomUUID(),
        actionCode: 'FREE_ACTION',
        displayName: '免费动作',
        pricingMode: 'FLAT_ACTION',
        creditsPerUnit: 0n,
        defaultHoldUnits: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        active: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
  };

  const makeTx = (wsId: string) => ({
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      if (sql.includes('INSERT INTO public.wallet_account')) {
        const id = String(values[0]);
        if (!db.accounts.has(id)) {
          db.accounts.set(id, {
            workspaceId: id,
            currency: 'CREDITS',
            availableCredits: 0n,
            heldCredits: 0n,
            lifetimeToppedUp: 0n,
            lifetimeSpent: 0n,
            status: 'ACTIVE',
            version: 1n,
            updatedAt: new Date(),
          });
        }
      }
      return 1;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      if (sql.includes('FROM public.wallet_account') && sql.includes('FOR UPDATE')) {
        const acc = db.accounts.get(String(values[0]));
        if (!acc) return [];
        return [
          {
            workspace_id: acc.workspaceId,
            currency: acc.currency,
            available_credits: acc.availableCredits,
            held_credits: acc.heldCredits,
            lifetime_topped_up: acc.lifetimeToppedUp,
            lifetime_spent: acc.lifetimeSpent,
            status: acc.status,
            version: acc.version,
            updated_at: acc.updatedAt,
          },
        ];
      }
      if (sql.includes('FROM public.wallet_hold') && sql.includes('FOR UPDATE')) {
        const holdId = String(values[0]);
        const found = db.holds.find((h) => h.id === holdId && h.workspaceId === wsId);
        if (!found) return [];
        return [
          {
            id: found.id,
            workspace_id: found.workspaceId,
            idempotency_key: found.idempotencyKey,
            action_code: found.actionCode,
            ref_type: found.refType,
            ref_id: found.refId,
            held_credits: found.heldCredits,
            settled_credits: found.settledCredits,
            released_credits: found.releasedCredits,
            status: found.status,
            expires_at: found.expiresAt,
            created_at: found.createdAt,
            settled_at: found.settledAt,
          },
        ];
      }
      if (sql.includes('FROM public.wallet_credit_lot') && sql.includes('FOR UPDATE')) {
        const targetWs = String(values[0]);
        const isExpiredQuery = sql.includes('expires_at <= ');
        const now = values[1] instanceof Date ? values[1] : new Date();
        const matching = db.lots
          .filter((l) => {
            if (l.workspaceId !== targetWs || l.remainingCredits <= 0n) return false;
            if (isExpiredQuery) {
              return l.expiresAt !== null && l.expiresAt.getTime() <= now.getTime();
            }
            return l.expiresAt === null || l.expiresAt.getTime() > now.getTime();
          })
          .sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            const aExp = a.expiresAt ? a.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
            const bExp = b.expiresAt ? b.expiresAt.getTime() : Number.MAX_SAFE_INTEGER;
            if (aExp !== bExp) return aExp - bExp;
            return a.createdAt.getTime() - b.createdAt.getTime();
          });
        return matching.map((l) => ({
          id: l.id,
          workspace_id: l.workspaceId,
          source_type: l.sourceType,
          initial_credits: l.initialCredits,
          remaining_credits: l.remainingCredits,
          unit_price_micros: l.unitPriceMicros,
          priority: l.priority,
          expires_at: l.expiresAt,
          external_order_id: l.externalOrderId,
          note: l.note,
          actor_id: l.actorId,
          created_at: l.createdAt,
        }));
      }
      return [];
    }),
    walletAccount: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId: string } }) =>
        db.accounts.get(where.workspaceId) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { workspaceId: string };
          data: Record<string, unknown>;
        }) => {
          const acc = db.accounts.get(where.workspaceId)!;
          if (typeof data.availableCredits === 'bigint') acc.availableCredits = data.availableCredits;
          if (typeof data.heldCredits === 'bigint') acc.heldCredits = data.heldCredits;
          if (typeof data.lifetimeToppedUp === 'bigint') acc.lifetimeToppedUp = data.lifetimeToppedUp;
          if (typeof data.lifetimeSpent === 'bigint') acc.lifetimeSpent = data.lifetimeSpent;
          if (typeof data.status === 'string') acc.status = data.status;
          if (typeof data.version === 'bigint') acc.version = data.version;
          acc.updatedAt = new Date();
          return { ...acc };
        },
      ),
    },
    walletCreditLot: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { workspaceId_externalOrderId?: { workspaceId: string; externalOrderId: string } };
        }) => {
          const key = where.workspaceId_externalOrderId;
          if (!key) return null;
          return (
            db.lots.find(
              (l) => l.workspaceId === key.workspaceId && l.externalOrderId === key.externalOrderId,
            ) ?? null
          );
        },
      ),
      findMany: vi.fn(async ({ where }: { where?: { workspaceId?: string } }) =>
        db.lots.filter((l) => !where?.workspaceId || l.workspaceId === where.workspaceId),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const lot = {
          id: randomUUID(),
          workspaceId: String(data.workspaceId),
          sourceType: String(data.sourceType),
          initialCredits: data.initialCredits as bigint,
          remainingCredits: data.remainingCredits as bigint,
          unitPriceMicros: (data.unitPriceMicros as bigint) ?? 0n,
          priority: Number(data.priority ?? 10),
          expiresAt: (data.expiresAt as Date | null) ?? null,
          externalOrderId: (data.externalOrderId as string | null) ?? null,
          note: (data.note as string | null) ?? null,
          actorId: (data.actorId as string | null) ?? null,
          createdAt: new Date(),
        };
        db.lots.push(lot);
        return { ...lot };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const lot = db.lots.find((l) => l.id === where.id)!;
        if (typeof data.remainingCredits === 'bigint') lot.remainingCredits = data.remainingCredits;
        return { ...lot };
      }),
    },
    walletHold: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            id?: string;
            workspaceId_idempotencyKey?: { workspaceId: string; idempotencyKey: string };
          };
        }) => {
          if (where.id) return db.holds.find((h) => h.id === where.id) ?? null;
          const k = where.workspaceId_idempotencyKey;
          if (k) {
            return (
              db.holds.find(
                (h) => h.workspaceId === k.workspaceId && h.idempotencyKey === k.idempotencyKey,
              ) ?? null
            );
          }
          return null;
        },
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { workspaceId?: string; refType?: string; refId?: string; status?: string };
        }) =>
          db.holds.find(
            (h) =>
              (!where.workspaceId || h.workspaceId === where.workspaceId) &&
              (!where.refType || h.refType === where.refType) &&
              (!where.refId || h.refId === where.refId) &&
              (!where.status || h.status === where.status),
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where?: { workspaceId?: string; status?: string } }) =>
        db.holds.filter(
          (h) =>
            (!where?.workspaceId || h.workspaceId === where.workspaceId) &&
            (!where?.status || h.status === where.status),
        ),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const hold = {
          id: randomUUID(),
          workspaceId: String(data.workspaceId),
          idempotencyKey: String(data.idempotencyKey),
          actionCode: String(data.actionCode),
          refType: String(data.refType),
          refId: String(data.refId),
          heldCredits: data.heldCredits as bigint,
          settledCredits: 0n,
          releasedCredits: 0n,
          status: 'HELD',
          expiresAt: data.expiresAt as Date,
          createdAt: new Date(),
          settledAt: null,
        };
        db.holds.push(hold);
        return { ...hold };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const hold = db.holds.find((h) => h.id === where.id)!;
        if (typeof data.status === 'string') hold.status = data.status;
        if (typeof data.settledCredits === 'bigint') hold.settledCredits = data.settledCredits;
        if (typeof data.releasedCredits === 'bigint') hold.releasedCredits = data.releasedCredits;
        if (typeof data.refId === 'string') hold.refId = data.refId;
        if (data.settledAt instanceof Date) hold.settledAt = data.settledAt;
        return { ...hold };
      }),
    },
    walletLedger: {
      findMany: vi.fn(async ({ where }: { where?: { workspaceId?: string; entryType?: string } }) =>
        db.ledgers.filter(
          (l) =>
            (!where?.workspaceId || l.workspaceId === where.workspaceId) &&
            (!where?.entryType || l.entryType === where.entryType),
        ),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const entry = {
          id: randomUUID(),
          workspaceId: String(data.workspaceId),
          idempotencyKey: String(data.idempotencyKey),
          entryType: String(data.entryType),
          deltaAvailable: (data.deltaAvailable as bigint) ?? 0n,
          deltaHeld: (data.deltaHeld as bigint) ?? 0n,
          balanceAvailable: data.balanceAvailable as bigint,
          balanceHeld: data.balanceHeld as bigint,
          revenueMicros: (data.revenueMicros as bigint) ?? 0n,
          holdId: (data.holdId as string | null) ?? null,
          lotId: (data.lotId as string | null) ?? null,
          actionCode: (data.actionCode as string | null) ?? null,
          refType: (data.refType as string | null) ?? null,
          refId: (data.refId as string | null) ?? null,
          billableUnits: (data.billableUnits as number | null) ?? null,
          note: (data.note as string | null) ?? null,
          actorId: (data.actorId as string | null) ?? null,
          createdAt: new Date(),
        };
        db.ledgers.push(entry);
        return { ...entry };
      }),
    },
    billingPriceCard: {
      findFirst: vi.fn(
        async ({ where }: { where: { actionCode?: string; active?: boolean } }) =>
          db.priceCards.find(
            (c) =>
              (!where.actionCode || c.actionCode === where.actionCode) &&
              (where.active === undefined || c.active === where.active),
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where?: { active?: boolean } } = {}) =>
        db.priceCards.filter((c) => where?.active === undefined || c.active === where.active),
      ),
    },
  });

  const prisma = {
    withWorkspace: vi.fn(async <T>(wsId: string, fn: (tx: unknown) => Promise<T>) => fn(makeTx(wsId))),
    billingPriceCard: {
      findFirst: vi.fn(
        async ({ where }: { where: { actionCode?: string; active?: boolean } }) =>
          db.priceCards.find(
            (c) =>
              (!where.actionCode || c.actionCode === where.actionCode) &&
              (where.active === undefined || c.active === where.active),
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where?: { active?: boolean } } = {}) =>
        db.priceCards.filter((c) => where?.active === undefined || c.active === where.active),
      ),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      if (sql.includes('app_list_expired_wallet_holds')) {
        const now = Date.now();
        return db.holds
          .filter((h) => h.status === 'HELD' && h.expiresAt.getTime() <= now)
          .map((h) => ({
            id: h.id,
            workspace_id: h.workspaceId,
            action_code: h.actionCode,
            ref_type: h.refType,
            ref_id: h.refId,
            held_credits: h.heldCredits,
            expires_at: h.expiresAt,
          }));
      }
      if (sql.includes('app_ops_wallet_profit_summary')) {
        const byWs = new Map<
          string,
          {
            workspace_id: string;
            workspace_name: string;
            settled_credits: bigint;
            paid_revenue_micros: bigint;
            topup_credits: bigint;
            bonus_credits: bigint;
            released_credits: bigint;
            ledger_entries: bigint;
          }
        >();
        for (const l of db.ledgers) {
          const cur = byWs.get(l.workspaceId) ?? {
            workspace_id: l.workspaceId,
            workspace_name: 'Workspace',
            settled_credits: 0n,
            paid_revenue_micros: 0n,
            topup_credits: 0n,
            bonus_credits: 0n,
            released_credits: 0n,
            ledger_entries: 0n,
          };
          cur.ledger_entries += 1n;
          if (l.entryType === 'SETTLE') {
            cur.settled_credits += l.deltaHeld < 0n ? -l.deltaHeld : l.deltaHeld;
            cur.paid_revenue_micros += l.revenueMicros;
          } else if (l.entryType === 'TOPUP') {
            cur.topup_credits += l.deltaAvailable > 0n ? l.deltaAvailable : 0n;
          } else if (l.entryType === 'PLAN_GRANT' || l.entryType === 'ADJUST') {
            cur.bonus_credits += l.deltaAvailable > 0n ? l.deltaAvailable : 0n;
          }
          byWs.set(l.workspaceId, cur);
        }
        return [...byWs.values()];
      }
      return [];
    }),
  } as unknown as PrismaService;

  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const opsDb = {
    get db() {
      if (options?.engineUnavailable) {
        throw new Error('OPS_NOT_CONFIGURED');
      }
      return {
        query: vi.fn(async () => options?.engineCostRows ?? []),
      };
    },
  } as unknown as OpsDatabase;
  const config = {
    WALLET_BILLING_ENABLED: options?.billingEnabled ?? true,
    WALLET_HOLD_TTL_MINUTES: 360,
    WALLET_HOLD_SWEEP_INTERVAL_MS: 600_000,
  } as AppConfig;

  const service = new WalletService(config, prisma, audit, opsDb);
  return { service, db, prisma, audit };
}

describe('WalletService', () => {
  it('topUp & grantBonus are idempotent by externalOrderId and separate paid vs bonus priority', async () => {
    const ws = randomUUID();
    const { service, db } = createMockWalletEnv();

    const firstTopUp = await service.topUp(
      ws,
      { credits: '1000', unitPriceMicros: '10000', externalOrderId: 'ord-001', note: 'initial' },
      'ops-1',
    );
    expect(firstTopUp.idempotent).toBe(false);
    expect(firstTopUp.account.availableCredits).toBe('1000');
    expect(firstTopUp.account.lifetimeToppedUp).toBe('1000');
    expect(firstTopUp.lot.priority).toBe(10);

    // Duplicate externalOrderId does not double-credit
    const dupTopUp = await service.topUp(
      ws,
      { credits: '1000', unitPriceMicros: '10000', externalOrderId: 'ord-001' },
      'ops-1',
    );
    expect(dupTopUp.idempotent).toBe(true);
    expect(dupTopUp.account.availableCredits).toBe('1000');
    expect(db.lots).toHaveLength(1);

    // Bonus grant gets priority 1 and does not inflate lifetimeToppedUp
    const bonus = await service.grantBonus(
      ws,
      {
        credits: '200',
        sourceType: 'PROMO_BONUS',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        externalOrderId: 'promo-001',
      },
      'ops-1',
    );
    expect(bonus.idempotent).toBe(false);
    expect(bonus.lot.priority).toBe(1);
    expect(bonus.lot.unitPriceMicros).toBe('0');
    expect(bonus.account.availableCredits).toBe('1200');
    expect(bonus.account.lifetimeToppedUp).toBe('1000');
  });

  it('holdCredits rejects 402 INSUFFICIENT_CREDITS and 403 WALLET_FROZEN, and deduplicates by idempotencyKey', async () => {
    const ws = randomUUID();
    const { service, db } = createMockWalletEnv();

    await expect(
      service.holdCredits(ws, {
        idempotencyKey: 'hold-no-funds',
        actionCode: 'DISCOVERY_QUALIFIED_LEAD',
        refType: 'discovery_run',
        refId: 'plan-1',
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    await service.topUp(ws, { credits: '500', unitPriceMicros: '10000', externalOrderId: 'ord-1' }, 'ops-1');

    const held = await service.holdCredits(ws, {
      idempotencyKey: 'hold-run-1',
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      refType: 'discovery_run',
      refId: 'plan-1',
    });
    expect(held.free).toBe(false);
    expect(held.idempotent).toBe(false);
    expect(held.hold!.heldCredits).toBe('200'); // 10 * 20 defaultHoldUnits
    expect(held.account.availableCredits).toBe('300');
    expect(held.account.heldCredits).toBe('200');

    // Idempotent replay does not hold again
    const replay = await service.holdCredits(ws, {
      idempotencyKey: 'hold-run-1',
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      refType: 'discovery_run',
      refId: 'plan-1',
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.account.availableCredits).toBe('300');

    // Free action (0 credits per unit) succeeds without holding
    const freeRes = await service.holdCredits(ws, {
      idempotencyKey: 'free-1',
      actionCode: 'FREE_ACTION',
      refType: 'test',
      refId: '1',
    });
    expect(freeRes.free).toBe(true);
    expect(freeRes.hold).toBeNull();

    // Frozen wallet throws WalletFrozenError (403)
    db.accounts.get(ws)!.status = 'FROZEN';
    await expect(
      service.holdCredits(ws, {
        idempotencyKey: 'hold-when-frozen',
        actionCode: 'CONTACT_VALID_EMAIL',
        refType: 'contact_verify',
        refId: 'p-1',
      }),
    ).rejects.toBeInstanceOf(WalletFrozenError);
  });

  it('settleHold consumes expiring bonus lots before paid lots, computes exact revenueMicros, and auto-refunds surplus', async () => {
    const ws = randomUUID();
    const { service, db } = createMockWalletEnv();

    await service.topUp(ws, { credits: '500', unitPriceMicros: '10000', externalOrderId: 'paid-1' }, 'ops-1');
    await service.grantBonus(
      ws,
      {
        credits: '80',
        sourceType: 'PROMO_BONUS',
        expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        externalOrderId: 'bonus-soon',
      },
      'ops-1',
    );
    await service.grantBonus(
      ws,
      {
        credits: '50',
        sourceType: 'PLAN_GRANT',
        expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        externalOrderId: 'bonus-later',
      },
      'ops-1',
    );

    // Total available = 630. Hold 200 (DISCOVERY_QUALIFIED_LEAD: 10 credits/lead * 20 default)
    const held = await service.holdCredits(ws, {
      idempotencyKey: 'disc-1',
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      refType: 'discovery_run',
      refId: 'run-1',
    });
    expect(held.account.availableCredits).toBe('430');
    expect(held.account.heldCredits).toBe('200');

    // Settle for 15 qualified leads => actual = 150 credits, refund = 50 credits.
    // Lots consumed: 80 (bonus-soon, $0) + 50 (bonus-later, $0) + 20 (paid-1, 20 * 10,000 = 200,000 micros)!
    const settled = await service.settleHold(ws, {
      holdId: held.hold!.id,
      billableUnits: 15,
      note: '15 qualified leads',
    });
    expect(settled.idempotent).toBe(false);
    expect(settled.hold.status).toBe('SETTLED');
    expect(settled.hold.settledCredits).toBe('150');
    expect(settled.hold.releasedCredits).toBe('50');
    expect(settled.account.heldCredits).toBe('0');
    expect(settled.account.availableCredits).toBe('480'); // 630 - 150
    expect(settled.account.lifetimeSpent).toBe('150');

    const settleLedger = db.ledgers.find((l) => l.entryType === 'SETTLE')!;
    expect(settleLedger.revenueMicros).toBe(200_000n); // ONLY the 20 paid credits count as revenue!
    expect(settleLedger.deltaHeld).toBe(-150n);
    const refundLedger = db.ledgers.find((l) => l.entryType === 'RELEASE')!;
    expect(refundLedger.deltaAvailable).toBe(50n);
    expect(refundLedger.deltaHeld).toBe(-50n);
    expect(refundLedger.balanceAvailable).toBe(480n);
    expect(refundLedger.balanceHeld).toBe(0n);

    // Repeat settle is idempotent
    const repeat = await service.settleHold(ws, { holdId: held.hold!.id, billableUnits: 15 });
    expect(repeat.idempotent).toBe(true);
    expect(repeat.account.availableCredits).toBe('480');
  });

  it('settleHold with 0 billableUnits refunds 100% of held credits with zero spend', async () => {
    const ws = randomUUID();
    const { service } = createMockWalletEnv();
    await service.topUp(ws, { credits: '100', unitPriceMicros: '10000', externalOrderId: 'ord-z' }, 'ops-1');

    const held = await service.holdCredits(ws, {
      idempotencyKey: 'verify-invalid',
      actionCode: 'CONTACT_VALID_EMAIL',
      refType: 'contact_verify',
      refId: 'pt-1',
    });
    expect(held.account.availableCredits).toBe('98');
    expect(held.account.heldCredits).toBe('2');

    const res = await service.settleHold(ws, {
      holdId: held.hold!.id,
      billableUnits: 0,
      note: 'INVALID email -> zero charge',
    });
    expect(res.hold.status).toBe('RELEASED');
    expect(res.hold.settledCredits).toBe('0');
    expect(res.hold.releasedCredits).toBe('2');
    expect(res.account.availableCredits).toBe('100');
    expect(res.account.heldCredits).toBe('0');
    expect(res.account.lifetimeSpent).toBe('0');
  });

  it('sweepExpiredHolds automatically releases stale HELD rows and opsProfitReconciliation computes gross margin', async () => {
    const ws = randomUUID();
    const { service, db } = createMockWalletEnv({
      engineCostRows: [{ workspace_id: ws, cost_usd: '0.35' }],
    });
    await service.topUp(ws, { credits: '300', unitPriceMicros: '10000', externalOrderId: 'ord-p' }, 'ops-1');

    // Create 1 settled paid spend (100 credits = $1.00 revenue)
    const h1 = await service.holdCredits(ws, {
      idempotencyKey: 'h-settled',
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      refType: 'discovery_run',
      refId: 'run-ok',
      credits: '100',
    });
    await service.settleHold(ws, { holdId: h1.hold!.id, billableUnits: 10 });

    // Create 1 stale zombie hold already expired
    const h2 = await service.holdCredits(ws, {
      idempotencyKey: 'h-zombie',
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      refType: 'discovery_run',
      refId: 'run-lost',
      credits: '50',
    });
    db.holds.find((h) => h.id === h2.hold!.id)!.expiresAt = new Date(Date.now() - 60_000);

    const swept = await service.sweepExpiredHolds(50);
    expect(swept.released).toBe(1);
    expect(db.accounts.get(ws)!.heldCredits).toBe(0n);
    expect(db.accounts.get(ws)!.availableCredits).toBe(200n);
    expect(db.holds.find((h) => h.id === h2.hold!.id)!.status).toBe('EXPIRED_RELEASED');

    // Profit reconciliation: revenue $1.00 (1,000,000 micros) vs engine cost $0.35 (350,000 micros) => gross profit $0.65 (65%)
    const profit = await service.opsProfitReconciliation({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
    expect(profit.engineCostStatus).toBe('ok');
    expect(profit.totals.paidRevenueMicros).toBe('1000000');
    expect(profit.totals.engineCostMicros).toBe('350000');
    expect(profit.totals.grossProfitMicros).toBe('650000');
    expect(profit.totals.grossMarginPct).toBe(65);
  });

  it('releaseHold throws NotFoundException for unknown holdId and opsProfitReconciliation degrades gracefully without engine DB', async () => {
    const ws = randomUUID();
    const { service } = createMockWalletEnv({ engineUnavailable: true });
    await expect(service.releaseHold(ws, randomUUID(), 'test')).rejects.toBeInstanceOf(NotFoundException);

    const profit = await service.opsProfitReconciliation({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
    expect(profit.engineCostStatus).toBe('unavailable');
  });

  it('rejects BIGINT overflow inputs and boolean defaultHoldUnits with 400 BadRequestException', async () => {
    const ws = randomUUID();
    const { service, db } = createMockWalletEnv();

    // 超过 PG int8 最大值的 19 位整数必须 400 拦截，不得抛 500
    await expect(
      service.topUp(
        ws,
        { credits: '9999999999999999999', unitPriceMicros: '10000', externalOrderId: 'ov-1' },
        'ops-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.topUp(
        ws,
        { credits: '1000', unitPriceMicros: '9999999999999999999', externalOrderId: 'ov-2' },
        'ops-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.grantBonus(
        ws,
        { credits: '9999999999999999999', sourceType: 'PROMO_BONUS', externalOrderId: 'ov-3' },
        'ops-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // 拒绝 JSON boolean 被静默强转为 defaultHoldUnits=1
    await expect(
      service.opsCreatePriceCard(
        {
          actionCode: 'TEST_BOOL_GUARD',
          displayName: '测试布尔拦截',
          pricingMode: 'FLAT_ACTION',
          creditsPerUnit: '10',
          defaultHoldUnits: true,
        },
        'ops-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.opsUpdatePriceCard(
        randomUUID(),
        { defaultHoldUnits: false },
        'ops-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // 余额累加触顶 MAX_PG_BIGINT 同样返回 400，不越界
    db.accounts.set(ws, {
      workspaceId: ws,
      currency: 'CREDITS',
      availableCredits: MAX_PG_BIGINT - 5n,
      heldCredits: 0n,
      lifetimeToppedUp: MAX_PG_BIGINT - 5n,
      lifetimeSpent: 0n,
      status: 'ACTIVE',
      version: 1n,
      updatedAt: new Date(),
    });
    await expect(
      service.topUp(ws, { credits: '10', unitPriceMicros: '10000', externalOrderId: 'ov-bal' }, 'ops-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('WalletController enforces AdminGuard on /lots, /holds, /ledger and strips internal pricing/revenue fields', async () => {
    const ws = randomUUID();
    const { service } = createMockWalletEnv();
    await service.topUp(
      ws,
      { credits: '500', unitPriceMicros: '12500', externalOrderId: 'secret-wire-ord-1', note: 'VIP 折扣价' },
      'ops-internal-admin',
    );
    const held = await service.holdCredits(ws, {
      idempotencyKey: 'h-ctrl-1',
      actionCode: 'CONTACT_VALID_EMAIL',
      refType: 'contact_verify',
      refId: 'pt-1',
    });
    await service.settleHold(ws, { holdId: held.hold!.id, billableUnits: 1, note: '内部结算备注' });

    // 1. 守卫元数据校验：/lots /holds /ledger 必须挂 AdminGuard，/summary 仅 TenantGuard（对普通成员开放）
    const lotsGuards = Reflect.getMetadata(GUARDS_METADATA, WalletController.prototype.lots) as unknown[];
    const holdsGuards = Reflect.getMetadata(GUARDS_METADATA, WalletController.prototype.holds) as unknown[];
    const ledgerGuards = Reflect.getMetadata(GUARDS_METADATA, WalletController.prototype.ledger) as unknown[];
    const summaryGuards = Reflect.getMetadata(GUARDS_METADATA, WalletController.prototype.summary) as unknown[] | undefined;
    expect(lotsGuards).toContain(AdminGuard);
    expect(holdsGuards).toContain(AdminGuard);
    expect(ledgerGuards).toContain(AdminGuard);
    expect(summaryGuards ?? []).not.toContain(AdminGuard);

    // 2. AdminGuard 实测：普通 member 被 403 拒绝，admin 放行
    const adminGuard = new AdminGuard();
    const makeCtx = (role: 'admin' | 'member') =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ tenant: { userId: 'u-1', workspaceId: ws, role } }),
        }),
      }) as unknown as ExecutionContext;
    expect(() => adminGuard.canActivate(makeCtx('member'))).toThrow(ForbiddenException);
    expect(adminGuard.canActivate(makeCtx('admin'))).toBe(true);

    // 3. 响应 DTO 字段过滤：租户侧绝不泄漏 unitPriceMicros / revenueMicros / externalOrderId / note / actorId
    const controller = new WalletController(service);
    const req = { tenant: { userId: 'u-1', workspaceId: ws, role: 'admin' } } as never;

    const lotsRes = await controller.lots(req, '50');
    expect(lotsRes.data.length).toBe(1);
    const lotRow = lotsRes.data[0] as unknown as Record<string, unknown>;
    expect(lotRow.initialCredits).toBe('500');
    expect(lotRow).not.toHaveProperty('unitPriceMicros');
    expect(lotRow).not.toHaveProperty('externalOrderId');
    expect(lotRow).not.toHaveProperty('note');
    expect(lotRow).not.toHaveProperty('actorId');

    const ledgerRes = await controller.ledger(req, '30');
    expect(ledgerRes.data.length).toBeGreaterThanOrEqual(2);
    for (const row of ledgerRes.data as unknown as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('revenueMicros');
      expect(row).not.toHaveProperty('note');
      expect(row).not.toHaveProperty('actorId');
    }
  });
});
