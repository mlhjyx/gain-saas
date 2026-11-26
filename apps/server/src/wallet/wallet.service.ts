import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { computeGrossMarginPct, parseCreditsBigInt, summarizeWalletLots } from '@gain-saas/shared';
import type { AppConfig } from '../config/configuration.js';
import type { OpsDatabase } from '../ops/ops-database.service.js';
import { AuditService } from '../shared/audit.service.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { PrismaService } from '../shared/prisma.service.js';
import {
  CreatePriceCardBodySchema,
  GrantBonusBodySchema,
  InsufficientCreditsError,
  MAX_PG_BIGINT,
  TopUpBodySchema,
  UpdatePriceCardBodySchema,
  WalletFrozenError,
  WalletStatusBodySchema,
  type BillingPriceCardDto,
  type HoldCreditsInput,
  type OpsWalletAccountListItemDto,
  type ProfitReconciliationDto,
  type ProfitReconciliationRowDto,
  type SettleHoldInput,
  type WalletAccountDto,
  type WalletCreditLotDto,
  type WalletHoldDto,
  type WalletLedgerDto,
  type WalletSummaryDto,
} from './wallet.types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LockedAccountRow {
  workspace_id: string;
  currency: string;
  available_credits: bigint;
  held_credits: bigint;
  lifetime_topped_up: bigint;
  lifetime_spent: bigint;
  status: string;
  version: bigint;
  updated_at: Date;
}

interface LockedHoldRow {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  action_code: string;
  ref_type: string;
  ref_id: string;
  held_credits: bigint;
  settled_credits: bigint;
  released_credits: bigint;
  status: string;
  expires_at: Date;
  created_at: Date;
  settled_at: Date | null;
}

interface LockedLotRow {
  id: string;
  workspace_id: string;
  source_type: string;
  initial_credits: bigint;
  remaining_credits: bigint;
  unit_price_micros: bigint;
  priority: number;
  expires_at: Date | null;
  external_order_id: string | null;
  note: string | null;
  actor_id: string | null;
  created_at: Date;
}

interface PriceCardRawRow {
  id: string;
  action_code: string;
  display_name: string;
  pricing_mode: string;
  credits_per_unit: bigint;
  default_hold_units: number;
  effective_from: Date;
  effective_to: Date | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value);
}

function serializeAccount(row: {
  workspaceId: string;
  currency: string;
  availableCredits: bigint;
  heldCredits: bigint;
  lifetimeToppedUp: bigint;
  lifetimeSpent: bigint;
  status: string;
  version: bigint;
  updatedAt: Date;
}): WalletAccountDto {
  return {
    workspaceId: row.workspaceId,
    currency: row.currency,
    availableCredits: row.availableCredits.toString(),
    heldCredits: row.heldCredits.toString(),
    lifetimeToppedUp: row.lifetimeToppedUp.toString(),
    lifetimeSpent: row.lifetimeSpent.toString(),
    status: row.status,
    version: row.version.toString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeLockedAccount(row: LockedAccountRow): WalletAccountDto {
  return {
    workspaceId: row.workspace_id,
    currency: row.currency,
    availableCredits: toBigInt(row.available_credits).toString(),
    heldCredits: toBigInt(row.held_credits).toString(),
    lifetimeToppedUp: toBigInt(row.lifetime_topped_up).toString(),
    lifetimeSpent: toBigInt(row.lifetime_spent).toString(),
    status: row.status,
    version: toBigInt(row.version).toString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function serializeLot(row: {
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
}): WalletCreditLotDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceType: row.sourceType,
    initialCredits: row.initialCredits.toString(),
    remainingCredits: row.remainingCredits.toString(),
    unitPriceMicros: row.unitPriceMicros.toString(),
    priority: row.priority,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    externalOrderId: row.externalOrderId,
    note: row.note,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeHold(row: {
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
}): WalletHoldDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    idempotencyKey: row.idempotencyKey,
    actionCode: row.actionCode,
    refType: row.refType,
    refId: row.refId,
    heldCredits: row.heldCredits.toString(),
    settledCredits: row.settledCredits.toString(),
    releasedCredits: row.releasedCredits.toString(),
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
  };
}

function serializeLockedHold(row: LockedHoldRow): WalletHoldDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    actionCode: row.action_code,
    refType: row.ref_type,
    refId: row.ref_id,
    heldCredits: toBigInt(row.held_credits).toString(),
    settledCredits: toBigInt(row.settled_credits).toString(),
    releasedCredits: toBigInt(row.released_credits).toString(),
    status: row.status,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
  };
}

function serializeLedger(row: {
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
}): WalletLedgerDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    idempotencyKey: row.idempotencyKey,
    entryType: row.entryType,
    deltaAvailable: row.deltaAvailable.toString(),
    deltaHeld: row.deltaHeld.toString(),
    balanceAvailable: row.balanceAvailable.toString(),
    balanceHeld: row.balanceHeld.toString(),
    revenueMicros: row.revenueMicros.toString(),
    holdId: row.holdId,
    lotId: row.lotId,
    actionCode: row.actionCode,
    refType: row.refType,
    refId: row.refId,
    billableUnits: row.billableUnits,
    note: row.note,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializePriceCard(row: {
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
}): BillingPriceCardDto {
  return {
    id: row.id,
    actionCode: row.actionCode,
    displayName: row.displayName,
    pricingMode: row.pricingMode,
    creditsPerUnit: row.creditsPerUnit.toString(),
    defaultHoldUnits: row.defaultHoldUnits,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeRawPriceCard(row: PriceCardRawRow): BillingPriceCardDto {
  return {
    id: row.id,
    actionCode: row.action_code,
    displayName: row.display_name,
    pricingMode: row.pricing_mode,
    creditsPerUnit: toBigInt(row.credits_per_unit).toString(),
    defaultHoldUnits: Number(row.default_hold_units),
    effectiveFrom: new Date(row.effective_from).toISOString(),
    effectiveTo: row.effective_to ? new Date(row.effective_to).toISOString() : null,
    active: Boolean(row.active),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * 商业化充值钱包核心服务（M9 W1）：
 * - 全表 BIGINT + FORCE RLS，全部租户读写走 withWorkspace + SELECT ... FOR UPDATE 行锁防并发超扣；
 * - 幂等预占（holdCredits）→ 启动失败即时退还（releaseHold）→ 按有效产出实扣（settleHold，赠点 priority=1 优先消耗，差额/空跑自动退点）；
 * - 不可变双录账本（wallet_ledger）与运营毛利对账（wallet_ledger 实收 vs global_dev.usage_ledger 底层成本）。
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly opsDatabase?: OpsDatabase,
  ) {}

  get billingEnabled(): boolean {
    return Boolean(this.config.WALLET_BILLING_ENABLED);
  }

  private assertUuid(value: string, label: string): void {
    if (!UUID_RE.test(value)) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: `${label} 不是合法 UUID` },
      });
    }
  }

  private async ensureAndLockAccount(
    tx: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<LockedAccountRow> {
    await tx.$executeRaw`
      INSERT INTO public.wallet_account (workspace_id)
      VALUES (${workspaceId}::uuid)
      ON CONFLICT (workspace_id) DO NOTHING
    `;
    const rows = await tx.$queryRaw<LockedAccountRow[]>`
      SELECT
        workspace_id,
        currency,
        available_credits,
        held_credits,
        lifetime_topped_up,
        lifetime_spent,
        status,
        version,
        updated_at
      FROM public.wallet_account
      WHERE workspace_id = ${workspaceId}::uuid
      FOR UPDATE
    `;
    const account = rows[0];
    if (!account) {
      throw new NotFoundException({
        error: { code: 'WORKSPACE_NOT_FOUND', message: '工作空间钱包不存在' },
      });
    }
    return {
      ...account,
      available_credits: toBigInt(account.available_credits),
      held_credits: toBigInt(account.held_credits),
      lifetime_topped_up: toBigInt(account.lifetime_topped_up),
      lifetime_spent: toBigInt(account.lifetime_spent),
      version: toBigInt(account.version),
    };
  }

  /**
   * 惰性清理已到期且仍有余额的赠点批次（在 wallet_account FOR UPDATE 锁内调用），
   * 保证可用余额不含过期点数且不会破坏 available_credits >= 0 约束。
   */
  private async expireStaleLotsInTx(
    tx: Prisma.TransactionClient,
    account: LockedAccountRow,
    now: Date,
  ): Promise<LockedAccountRow> {
    const expiredLots = await tx.$queryRaw<LockedLotRow[]>`
      SELECT
        id, workspace_id, source_type, initial_credits, remaining_credits,
        unit_price_micros, priority, expires_at, external_order_id, note, actor_id, created_at
      FROM public.wallet_credit_lot
      WHERE workspace_id = ${account.workspace_id}::uuid
        AND remaining_credits > 0
        AND expires_at IS NOT NULL
        AND expires_at <= ${now}
      ORDER BY expires_at ASC, created_at ASC
      FOR UPDATE
    `;
    if (expiredLots.length === 0) return account;

    let currentAvail = account.available_credits;
    let currentVersion = account.version;

    for (const lot of expiredLots) {
      const rem = toBigInt(lot.remaining_credits);
      if (rem <= 0n || currentAvail <= 0n) continue;
      const deduct = rem <= currentAvail ? rem : currentAvail;
      currentAvail -= deduct;
      currentVersion += 1n;

      await tx.walletCreditLot.update({
        where: { id: lot.id },
        data: { remainingCredits: rem - deduct },
      });
      await tx.walletLedger.create({
        data: {
          workspaceId: account.workspace_id,
          idempotencyKey: `expire:lot:${lot.id}:${currentVersion.toString()}`,
          entryType: 'EXPIRE',
          deltaAvailable: -deduct,
          deltaHeld: 0n,
          balanceAvailable: currentAvail,
          balanceHeld: account.held_credits,
          revenueMicros: 0n,
          lotId: lot.id,
          note: '赠点到期自动清零',
          actorId: 'system:lot-expiry',
        },
      });
    }

    if (currentAvail !== account.available_credits) {
      await tx.walletAccount.update({
        where: { workspaceId: account.workspace_id },
        data: { availableCredits: currentAvail, version: currentVersion },
      });
    }

    return { ...account, available_credits: currentAvail, version: currentVersion };
  }

  async listPriceCards(includeInactive = false): Promise<BillingPriceCardDto[]> {
    const rows = await this.prisma.billingPriceCard.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ active: 'desc' }, { actionCode: 'asc' }, { effectiveFrom: 'desc' }],
    });
    return rows.map(serializePriceCard);
  }

  async getActivePriceCard(actionCode: string): Promise<BillingPriceCardDto | null> {
    const row = await this.prisma.billingPriceCard.findFirst({
      where: { actionCode, active: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    return row ? serializePriceCard(row) : null;
  }

  async getSummary(workspaceId: string, now: Date = new Date()): Promise<WalletSummaryDto> {
    this.assertUuid(workspaceId, 'workspaceId');
    const [scoped, priceCards] = await Promise.all([
      this.prisma.withWorkspace(workspaceId, async (tx) => {
        const account = await tx.walletAccount.findUnique({ where: { workspaceId } });
        const lots = await tx.walletCreditLot.findMany({
          where: { workspaceId, remainingCredits: { gt: 0n } },
          orderBy: [{ priority: 'asc' }, { expiresAt: 'asc' }, { createdAt: 'asc' }],
        });
        const holds = await tx.walletHold.findMany({
          where: { workspaceId, status: 'HELD' },
          select: { id: true },
        });
        return { account, lots, activeHoldsCount: holds.length };
      }),
      this.listPriceCards(false),
    ]);

    const accountDto: WalletAccountDto = scoped.account
      ? serializeAccount(scoped.account)
      : {
          workspaceId,
          currency: 'CREDITS',
          availableCredits: '0',
          heldCredits: '0',
          lifetimeToppedUp: '0',
          lifetimeSpent: '0',
          status: 'ACTIVE',
          version: '1',
          updatedAt: now.toISOString(),
        };

    const lotsSummary = summarizeWalletLots(
      scoped.lots.map((l) => ({
        sourceType: l.sourceType,
        remainingCredits: l.remainingCredits,
        priority: l.priority,
        expiresAt: l.expiresAt,
      })),
      now,
    );

    return {
      billingEnabled: this.billingEnabled,
      account: accountDto,
      lotsSummary,
      activeHoldsCount: scoped.activeHoldsCount,
      priceCards,
    };
  }

  async listLots(workspaceId: string, limit = 50): Promise<WalletCreditLotDto[]> {
    this.assertUuid(workspaceId, 'workspaceId');
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const rows = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.walletCreditLot.findMany({
        where: { workspaceId },
        orderBy: [{ createdAt: 'desc' }],
        take: safeLimit,
      }),
    );
    return rows.map(serializeLot);
  }

  async listHolds(workspaceId: string, status?: string, limit = 50): Promise<WalletHoldDto[]> {
    this.assertUuid(workspaceId, 'workspaceId');
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const rows = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.walletHold.findMany({
        where: { workspaceId, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: 'desc' }],
        take: safeLimit,
      }),
    );
    return rows.map(serializeHold);
  }

  async listLedger(
    workspaceId: string,
    options?: { limit?: number; entryType?: string; cursor?: string },
  ): Promise<{ items: WalletLedgerDto[]; nextCursor: string | null }> {
    this.assertUuid(workspaceId, 'workspaceId');
    const safeLimit = Math.min(Math.max(Math.trunc(options?.limit ?? 30) || 30, 1), 200);
    const cursorId = options?.cursor && UUID_RE.test(options.cursor) ? options.cursor : undefined;

    const rows = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.walletLedger.findMany({
        where: {
          workspaceId,
          ...(options?.entryType && options.entryType !== 'ALL' ? { entryType: options.entryType } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: safeLimit + 1,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
    );

    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const nextCursor = hasMore ? pageRows[pageRows.length - 1]!.id : null;
    return { items: pageRows.map(serializeLedger), nextCursor };
  }

  async topUp(
    workspaceId: string,
    rawBody: unknown,
    actorId: string,
  ): Promise<{ idempotent: boolean; lot: WalletCreditLotDto; account: WalletAccountDto }> {
    this.assertUuid(workspaceId, 'workspaceId');
    const parsed = TopUpBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }
    const credits = parseCreditsBigInt(parsed.data.credits);
    const unitPriceMicros = parseCreditsBigInt(parsed.data.unitPriceMicros);
    const externalOrderId = parsed.data.externalOrderId;
    const note = parsed.data.note ?? null;

    const result = await this.prisma.withWorkspace(workspaceId, async (tx) => {
      const account = await this.ensureAndLockAccount(tx, workspaceId);
      const existingLot = await tx.walletCreditLot.findUnique({
        where: { workspaceId_externalOrderId: { workspaceId, externalOrderId } },
      });
      if (existingLot) {
        return {
          idempotent: true,
          lot: serializeLot(existingLot),
          account: serializeLockedAccount(account),
        };
      }

      const nextAvail = account.available_credits + credits;
      const nextToppedUp = account.lifetime_topped_up + credits;
      if (nextAvail > MAX_PG_BIGINT || nextToppedUp > MAX_PG_BIGINT) {
        throw new BadRequestException({
          error: { code: 'VALIDATION_ERROR', message: '账户积分总额超出安全上界' },
        });
      }
      const nextVersion = account.version + 1n;

      const lot = await tx.walletCreditLot.create({
        data: {
          workspaceId,
          sourceType: 'TOPUP_PAID',
          initialCredits: credits,
          remainingCredits: credits,
          unitPriceMicros,
          priority: 10,
          expiresAt: null,
          externalOrderId,
          note,
          actorId,
        },
      });

      const updatedAcc = await tx.walletAccount.update({
        where: { workspaceId },
        data: {
          availableCredits: nextAvail,
          lifetimeToppedUp: nextToppedUp,
          version: nextVersion,
        },
      });

      await tx.walletLedger.create({
        data: {
          workspaceId,
          idempotencyKey: `topup:${externalOrderId}`,
          entryType: 'TOPUP',
          deltaAvailable: credits,
          deltaHeld: 0n,
          balanceAvailable: nextAvail,
          balanceHeld: account.held_credits,
          revenueMicros: 0n,
          lotId: lot.id,
          refType: 'order',
          refId: externalOrderId,
          note,
          actorId,
        },
      });

      return {
        idempotent: false,
        lot: serializeLot(lot),
        account: serializeAccount(updatedAcc),
      };
    });

    if (!result.idempotent) {
      await this.audit.record({
        realm: 'ops',
        actorId,
        workspaceId,
        action: 'wallet.top_up',
        target: result.lot.id,
        detail: {
          credits: credits.toString(),
          unitPriceMicros: unitPriceMicros.toString(),
          externalOrderId,
        },
      });
    }
    return result;
  }

  async grantBonus(
    workspaceId: string,
    rawBody: unknown,
    actorId: string,
  ): Promise<{ idempotent: boolean; lot: WalletCreditLotDto; account: WalletAccountDto }> {
    this.assertUuid(workspaceId, 'workspaceId');
    const parsed = GrantBonusBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }
    const credits = parseCreditsBigInt(parsed.data.credits);
    const { sourceType, externalOrderId } = parsed.data;
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'expiresAt 必须晚于当前时间' },
      });
    }
    const note = parsed.data.note ?? null;
    const ledgerEntryType = sourceType === 'MANUAL_ADJUST' ? 'ADJUST' : 'PLAN_GRANT';

    const result = await this.prisma.withWorkspace(workspaceId, async (tx) => {
      const account = await this.ensureAndLockAccount(tx, workspaceId);
      const existingLot = await tx.walletCreditLot.findUnique({
        where: { workspaceId_externalOrderId: { workspaceId, externalOrderId } },
      });
      if (existingLot) {
        return {
          idempotent: true,
          lot: serializeLot(existingLot),
          account: serializeLockedAccount(account),
        };
      }

      const nextAvail = account.available_credits + credits;
      if (nextAvail > MAX_PG_BIGINT) {
        throw new BadRequestException({
          error: { code: 'VALIDATION_ERROR', message: '账户积分总额超出安全上界' },
        });
      }
      const nextVersion = account.version + 1n;

      const lot = await tx.walletCreditLot.create({
        data: {
          workspaceId,
          sourceType,
          initialCredits: credits,
          remainingCredits: credits,
          unitPriceMicros: 0n,
          priority: 1,
          expiresAt,
          externalOrderId,
          note,
          actorId,
        },
      });

      const updatedAcc = await tx.walletAccount.update({
        where: { workspaceId },
        data: {
          availableCredits: nextAvail,
          version: nextVersion,
        },
      });

      await tx.walletLedger.create({
        data: {
          workspaceId,
          idempotencyKey: `grant:${externalOrderId}`,
          entryType: ledgerEntryType,
          deltaAvailable: credits,
          deltaHeld: 0n,
          balanceAvailable: nextAvail,
          balanceHeld: account.held_credits,
          revenueMicros: 0n,
          lotId: lot.id,
          refType: sourceType.toLowerCase(),
          refId: externalOrderId,
          note,
          actorId,
        },
      });

      return {
        idempotent: false,
        lot: serializeLot(lot),
        account: serializeAccount(updatedAcc),
      };
    });

    if (!result.idempotent) {
      await this.audit.record({
        realm: 'ops',
        actorId,
        workspaceId,
        action: 'wallet.grant_bonus',
        target: result.lot.id,
        detail: {
          credits: credits.toString(),
          sourceType,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          externalOrderId,
        },
      });
    }
    return result;
  }

  async setWalletStatus(
    workspaceId: string,
    rawBody: unknown,
    actorId: string,
  ): Promise<WalletAccountDto> {
    this.assertUuid(workspaceId, 'workspaceId');
    const parsed = WalletStatusBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: '钱包状态参数不合法' },
      });
    }

    const updated = await this.prisma.withWorkspace(workspaceId, async (tx) => {
      const account = await this.ensureAndLockAccount(tx, workspaceId);
      const row = await tx.walletAccount.update({
        where: { workspaceId },
        data: {
          status: parsed.data.status,
          version: account.version + 1n,
        },
      });
      return serializeAccount(row);
    });

    await this.audit.record({
      realm: 'ops',
      actorId,
      workspaceId,
      action: 'wallet.status_change',
      target: workspaceId,
      detail: { status: parsed.data.status, note: parsed.data.note ?? null },
    });

    return updated;
  }

  /**
   * 原子预占积分（SELECT ... FOR UPDATE 行锁防并发超扣 + 幂等键防双扣）。
   */
  async holdCredits(
    workspaceId: string,
    input: HoldCreditsInput,
    now: Date = new Date(),
  ): Promise<{
    readonly free: boolean;
    readonly idempotent: boolean;
    readonly hold: WalletHoldDto | null;
    readonly account: WalletAccountDto;
  }> {
    this.assertUuid(workspaceId, 'workspaceId');
    const idempotencyKey = input.idempotencyKey.trim().slice(0, 160);
    if (!idempotencyKey) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'idempotencyKey 不能为空' },
      });
    }

    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      let account = await this.ensureAndLockAccount(tx, workspaceId);

      // 1. 幂等查重（优先于余额检查，已成功预占/结算的请求重放不会误报 402）
      const existingHold = await tx.walletHold.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
      });
      if (existingHold) {
        return {
          free: false,
          idempotent: true,
          hold: serializeHold(existingHold),
          account: serializeLockedAccount(account),
        };
      }

      // 2. 清理过期赠点
      account = await this.expireStaleLotsInTx(tx, account, now);

      // 3. 校验账户状态
      if (account.status !== 'ACTIVE') {
        throw new WalletFrozenError(workspaceId);
      }

      // 4. 计算所需预占点数
      let requiredCredits: bigint;
      if (input.credits !== undefined) {
        requiredCredits = parseCreditsBigInt(input.credits);
      } else {
        const card = await tx.billingPriceCard.findFirst({
          where: { actionCode: input.actionCode, active: true },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (!card) {
          return {
            free: true,
            idempotent: false,
            hold: null,
            account: serializeLockedAccount(account),
          };
        }
        const units = Math.max(1, Math.trunc(input.units ?? card.defaultHoldUnits));
        requiredCredits = toBigInt(card.creditsPerUnit) * BigInt(units);
      }

      if (requiredCredits <= 0n) {
        return {
          free: true,
          idempotent: false,
          hold: null,
          account: serializeLockedAccount(account),
        };
      }

      // 5. 余额不足立即拒绝 402 INSUFFICIENT_CREDITS
      if (account.available_credits < requiredCredits) {
        throw new InsufficientCreditsError({
          availableCredits: account.available_credits,
          requiredCredits,
          actionCode: input.actionCode,
        });
      }

      const nextAvail = account.available_credits - requiredCredits;
      const nextHeld = account.held_credits + requiredCredits;
      if (nextHeld > MAX_PG_BIGINT) {
        throw new BadRequestException({
          error: { code: 'VALIDATION_ERROR', message: '账户预占积分总额超出安全上界' },
        });
      }
      const nextVersion = account.version + 1n;
      const ttlMs = input.ttlMs ?? (this.config.WALLET_HOLD_TTL_MINUTES ?? 360) * 60_000;
      const expiresAt = new Date(now.getTime() + ttlMs);

      const updatedAcc = await tx.walletAccount.update({
        where: { workspaceId },
        data: {
          availableCredits: nextAvail,
          heldCredits: nextHeld,
          version: nextVersion,
        },
      });

      const hold = await tx.walletHold.create({
        data: {
          workspaceId,
          idempotencyKey,
          actionCode: input.actionCode,
          refType: input.refType,
          refId: input.refId.slice(0, 160),
          heldCredits: requiredCredits,
          expiresAt,
        },
      });

      await tx.walletLedger.create({
        data: {
          workspaceId,
          idempotencyKey: `hold:${hold.id}`,
          entryType: 'HOLD',
          deltaAvailable: -requiredCredits,
          deltaHeld: requiredCredits,
          balanceAvailable: nextAvail,
          balanceHeld: nextHeld,
          revenueMicros: 0n,
          holdId: hold.id,
          actionCode: input.actionCode,
          refType: input.refType,
          refId: input.refId.slice(0, 160),
          note: input.note ?? null,
          actorId: input.actorId ?? null,
        },
      });

      return {
        free: false,
        idempotent: false,
        hold: serializeHold(hold),
        account: serializeAccount(updatedAcc),
      };
    });
  }

  /**
   * 绑定异步任务真实外部 refId（如寻源任务创建成功后将 planId 替换为 engine runId）。
   */
  async attachHoldRef(workspaceId: string, holdId: string, refId: string): Promise<void> {
    this.assertUuid(workspaceId, 'workspaceId');
    this.assertUuid(holdId, 'holdId');
    await this.prisma.withWorkspace(workspaceId, async (tx) => {
      await tx.walletHold.update({
        where: { id: holdId },
        data: { refId: refId.slice(0, 160) },
      });
    });
  }

  /**
   * 全额释放预占单（启动失败 / 超时巡检回滚 / 取消任务），幂等。
   */
  async releaseHold(
    workspaceId: string,
    holdId: string,
    reason: string,
    actorId?: string | null,
    expired = false,
    now: Date = new Date(),
  ): Promise<{ readonly idempotent: boolean; readonly hold: WalletHoldDto; readonly account: WalletAccountDto }> {
    this.assertUuid(workspaceId, 'workspaceId');
    this.assertUuid(holdId, 'holdId');

    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const account = await this.ensureAndLockAccount(tx, workspaceId);
      const lockedHolds = await tx.$queryRaw<LockedHoldRow[]>`
        SELECT
          id, workspace_id, idempotency_key, action_code, ref_type, ref_id,
          held_credits, settled_credits, released_credits, status, expires_at, created_at, settled_at
        FROM public.wallet_hold
        WHERE id = ${holdId}::uuid AND workspace_id = ${workspaceId}::uuid
        FOR UPDATE
      `;
      const hold = lockedHolds[0];
      if (!hold) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: '预占记录不存在' },
        });
      }
      if (hold.status !== 'HELD') {
        return {
          idempotent: true,
          hold: serializeLockedHold(hold),
          account: serializeLockedAccount(account),
        };
      }

      const refund = toBigInt(hold.held_credits);
      const nextAvail = account.available_credits + refund;
      const nextHeld = account.held_credits - refund;
      const nextVersion = account.version + 1n;
      const nextStatus = expired ? 'EXPIRED_RELEASED' : 'RELEASED';
      const entryType = expired ? 'EXPIRE' : 'RELEASE';

      const updatedHold = await tx.walletHold.update({
        where: { id: hold.id },
        data: {
          status: nextStatus,
          settledCredits: 0n,
          releasedCredits: refund,
          settledAt: now,
        },
      });

      const updatedAcc = await tx.walletAccount.update({
        where: { workspaceId },
        data: {
          availableCredits: nextAvail,
          heldCredits: nextHeld,
          version: nextVersion,
        },
      });

      await tx.walletLedger.create({
        data: {
          workspaceId,
          idempotencyKey: `${expired ? 'expire-hold' : 'release'}:${hold.id}`,
          entryType,
          deltaAvailable: refund,
          deltaHeld: -refund,
          balanceAvailable: nextAvail,
          balanceHeld: nextHeld,
          revenueMicros: 0n,
          holdId: hold.id,
          actionCode: hold.action_code,
          refType: hold.ref_type,
          refId: hold.ref_id,
          billableUnits: 0,
          note: reason.slice(0, 500),
          actorId: actorId ?? null,
        },
      });

      return {
        idempotent: false,
        hold: serializeHold(updatedHold),
        account: serializeAccount(updatedAcc),
      };
    });
  }

  /**
   * 按有效产出结算预占单：
   * - billableUnits <= 0 时 0 扣费并 100% 自动退还预占；
   * - 优先消耗赠点批次（priority=1、近到期优先），再扣付费充值批次（priority=10）；
   * - 实扣封顶于 held_credits，差额自动退还可用余额并写入双录流水。
   */
  async settleHold(
    workspaceId: string,
    input: SettleHoldInput,
    now: Date = new Date(),
  ): Promise<{ readonly idempotent: boolean; readonly hold: WalletHoldDto; readonly account: WalletAccountDto }> {
    this.assertUuid(workspaceId, 'workspaceId');
    this.assertUuid(input.holdId, 'holdId');
    const billableUnits = Math.max(0, Math.trunc(input.billableUnits));

    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const account = await this.ensureAndLockAccount(tx, workspaceId);
      const lockedHolds = await tx.$queryRaw<LockedHoldRow[]>`
        SELECT
          id, workspace_id, idempotency_key, action_code, ref_type, ref_id,
          held_credits, settled_credits, released_credits, status, expires_at, created_at, settled_at
        FROM public.wallet_hold
        WHERE id = ${input.holdId}::uuid AND workspace_id = ${workspaceId}::uuid
        FOR UPDATE
      `;
      const hold = lockedHolds[0];
      if (!hold) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: '预占记录不存在' },
        });
      }
      if (hold.status !== 'HELD') {
        return {
          idempotent: true,
          hold: serializeLockedHold(hold),
          account: serializeLockedAccount(account),
        };
      }

      const heldCredits = toBigInt(hold.held_credits);
      let actualCredits = 0n;

      if (input.overrideActualCredits !== undefined) {
        actualCredits = parseCreditsBigInt(input.overrideActualCredits);
        if (actualCredits < 0n) actualCredits = 0n;
      } else if (billableUnits > 0) {
        const card = await tx.billingPriceCard.findFirst({
          where: { actionCode: hold.action_code, active: true },
          orderBy: { effectiveFrom: 'desc' },
        });
        const unitCredits = card ? toBigInt(card.creditsPerUnit) : heldCredits;
        actualCredits = BigInt(billableUnits) * unitCredits;
      }
      if (actualCredits > heldCredits) {
        actualCredits = heldCredits;
      }
      const refund = heldCredits - actualCredits;

      // 0 有效产出：全额退还预占，不产生消耗与收入
      if (actualCredits === 0n) {
        const nextAvail = account.available_credits + heldCredits;
        const nextHeld = account.held_credits - heldCredits;
        const nextVersion = account.version + 1n;

        const updatedHold = await tx.walletHold.update({
          where: { id: hold.id },
          data: {
            status: 'RELEASED',
            settledCredits: 0n,
            releasedCredits: heldCredits,
            settledAt: now,
          },
        });

        const updatedAcc = await tx.walletAccount.update({
          where: { workspaceId },
          data: {
            availableCredits: nextAvail,
            heldCredits: nextHeld,
            version: nextVersion,
          },
        });

        await tx.walletLedger.create({
          data: {
            workspaceId,
            idempotencyKey: `settle-zero:${hold.id}`,
            entryType: 'RELEASE',
            deltaAvailable: heldCredits,
            deltaHeld: -heldCredits,
            balanceAvailable: nextAvail,
            balanceHeld: nextHeld,
            revenueMicros: 0n,
            holdId: hold.id,
            actionCode: hold.action_code,
            refType: hold.ref_type,
            refId: hold.ref_id,
            billableUnits: 0,
            note: input.note ?? '无有效产出，预占积分已全额退还',
            actorId: input.actorId ?? null,
          },
        });

        return {
          idempotent: false,
          hold: serializeHold(updatedHold),
          account: serializeAccount(updatedAcc),
        };
      }

      // 按优先级扣减批次：priority ASC（赠点=1 优先于充值=10）、expires_at ASC NULLS LAST、created_at ASC
      const activeLots = await tx.$queryRaw<LockedLotRow[]>`
        SELECT
          id, workspace_id, source_type, initial_credits, remaining_credits,
          unit_price_micros, priority, expires_at, external_order_id, note, actor_id, created_at
        FROM public.wallet_credit_lot
        WHERE workspace_id = ${workspaceId}::uuid
          AND remaining_credits > 0
          AND (expires_at IS NULL OR expires_at > ${now})
        ORDER BY priority ASC, expires_at ASC NULLS LAST, created_at ASC
        FOR UPDATE
      `;

      let remainingToConsume = actualCredits;
      let revenueMicros = 0n;
      let primaryLotId: string | null = null;

      for (const lot of activeLots) {
        if (remainingToConsume <= 0n) break;
        const lotRem = toBigInt(lot.remaining_credits);
        if (lotRem <= 0n) continue;
        const take = lotRem >= remainingToConsume ? remainingToConsume : lotRem;
        remainingToConsume -= take;
        revenueMicros += take * toBigInt(lot.unit_price_micros);
        if (!primaryLotId) primaryLotId = lot.id;

        await tx.walletCreditLot.update({
          where: { id: lot.id },
          data: { remainingCredits: lotRem - take },
        });
      }

      // 兜底：若预占期间某赠点批次刚跨过 expires_at，继续从未清零的过期批次补齐消耗
      if (remainingToConsume > 0n) {
        const fallbackLots = await tx.$queryRaw<LockedLotRow[]>`
          SELECT
            id, workspace_id, source_type, initial_credits, remaining_credits,
            unit_price_micros, priority, expires_at, external_order_id, note, actor_id, created_at
          FROM public.wallet_credit_lot
          WHERE workspace_id = ${workspaceId}::uuid
            AND remaining_credits > 0
            AND expires_at IS NOT NULL
            AND expires_at <= ${now}
          ORDER BY priority ASC, expires_at DESC, created_at ASC
          FOR UPDATE
        `;
        for (const lot of fallbackLots) {
          if (remainingToConsume <= 0n) break;
          const lotRem = toBigInt(lot.remaining_credits);
          if (lotRem <= 0n) continue;
          const take = lotRem >= remainingToConsume ? remainingToConsume : lotRem;
          remainingToConsume -= take;
          revenueMicros += take * toBigInt(lot.unit_price_micros);
          if (!primaryLotId) primaryLotId = lot.id;

          await tx.walletCreditLot.update({
            where: { id: lot.id },
            data: { remainingCredits: lotRem - take },
          });
        }
      }

      if (revenueMicros > MAX_PG_BIGINT) {
        throw new BadRequestException({
          error: { code: 'VALIDATION_ERROR', message: '单次结算折算收入超出 BIGINT 安全上界' },
        });
      }
      const afterSettleHeld = account.held_credits - actualCredits;
      const finalAvail = account.available_credits + refund;
      const finalHeld = account.held_credits - heldCredits;
      const nextSpent = account.lifetime_spent + actualCredits;
      if (nextSpent > MAX_PG_BIGINT) {
        throw new BadRequestException({
          error: { code: 'VALIDATION_ERROR', message: '累计实扣积分超出 BIGINT 安全上界' },
        });
      }
      const nextVersion = account.version + 1n;

      const updatedHold = await tx.walletHold.update({
        where: { id: hold.id },
        data: {
          status: 'SETTLED',
          settledCredits: actualCredits,
          releasedCredits: refund,
          settledAt: now,
        },
      });

      const updatedAcc = await tx.walletAccount.update({
        where: { workspaceId },
        data: {
          availableCredits: finalAvail,
          heldCredits: finalHeld,
          lifetimeSpent: nextSpent,
          version: nextVersion,
        },
      });

      await tx.walletLedger.create({
        data: {
          workspaceId,
          idempotencyKey: `settle:${hold.id}`,
          entryType: 'SETTLE',
          deltaAvailable: 0n,
          deltaHeld: -actualCredits,
          balanceAvailable: account.available_credits,
          balanceHeld: afterSettleHeld,
          revenueMicros,
          holdId: hold.id,
          lotId: primaryLotId,
          actionCode: hold.action_code,
          refType: hold.ref_type,
          refId: hold.ref_id,
          billableUnits,
          note: input.note ?? null,
          actorId: input.actorId ?? null,
        },
      });

      if (refund > 0n) {
        await tx.walletLedger.create({
          data: {
            workspaceId,
            idempotencyKey: `settle-refund:${hold.id}`,
            entryType: 'RELEASE',
            deltaAvailable: refund,
            deltaHeld: -refund,
            balanceAvailable: finalAvail,
            balanceHeld: finalHeld,
            revenueMicros: 0n,
            holdId: hold.id,
            actionCode: hold.action_code,
            refType: hold.ref_type,
            refId: hold.ref_id,
            billableUnits: 0,
            note: '预占差额自动退还',
            actorId: input.actorId ?? null,
          },
        });
      }

      return {
        idempotent: false,
        hold: serializeHold(updatedHold),
        account: serializeAccount(updatedAcc),
      };
    });
  }

  /**
   * 按业务引用（如 discovery_run + runId）查找活跃预占单并按有效产出结算。
   */
  async settleHoldByRef(
    workspaceId: string,
    refType: string,
    refId: string,
    billableUnits: number,
    note?: string | null,
    actorId?: string | null,
  ): Promise<{ readonly idempotent: boolean; readonly hold: WalletHoldDto; readonly account: WalletAccountDto } | null> {
    if (!UUID_RE.test(workspaceId) || !refId) return null;
    const activeHold = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.walletHold.findFirst({
        where: { workspaceId, refType, refId, status: 'HELD' },
        select: { id: true },
      }),
    );
    if (!activeHold) return null;
    return this.settleHold(workspaceId, {
      holdId: activeHold.id,
      billableUnits,
      note,
      actorId,
    });
  }

  /**
   * 每 10 分钟僵尸预占自动巡检：释放所有 status='HELD' AND expires_at <= now() 的过期预占单。
   */
  async sweepExpiredHolds(limit = 50): Promise<{ scanned: number; released: number; failed: number }> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
    const expired = await this.prisma.$queryRaw<
      Array<{
        id: string;
        workspace_id: string;
        action_code: string;
        ref_type: string;
        ref_id: string;
        held_credits: bigint;
        expires_at: Date;
      }>
    >`SELECT id, workspace_id, action_code, ref_type, ref_id, held_credits, expires_at FROM public.app_list_expired_wallet_holds(${safeLimit}::integer)`;

    let released = 0;
    let failed = 0;
    for (const row of expired) {
      try {
        const res = await this.releaseHold(
          row.workspace_id,
          row.id,
          'HOLD_EXPIRED_AUTO_RELEASE',
          'system:wallet-sweeper',
          true,
        );
        if (!res.idempotent) released += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `僵尸预占释放失败 hold=${row.id} workspace=${row.workspace_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { scanned: expired.length, released, failed };
  }

  // ─── 运营域查询与价目表管理（经 audited SECURITY DEFINER RPC）───

  async opsListAccounts(limit = 100, offset = 0): Promise<OpsWalletAccountListItemDto[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    const safeOffset = Math.max(Math.trunc(offset) || 0, 0);
    const rows = await this.prisma.$queryRaw<
      Array<{
        workspace_id: string;
        workspace_name: string;
        workspace_status: string;
        currency: string;
        available_credits: bigint;
        held_credits: bigint;
        lifetime_topped_up: bigint;
        lifetime_spent: bigint;
        wallet_status: string;
        updated_at: Date;
      }>
    >`SELECT * FROM public.app_ops_list_wallet_accounts(${safeLimit}::integer, ${safeOffset}::integer)`;

    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      workspaceStatus: row.workspace_status,
      currency: row.currency,
      availableCredits: toBigInt(row.available_credits).toString(),
      heldCredits: toBigInt(row.held_credits).toString(),
      lifetimeToppedUp: toBigInt(row.lifetime_topped_up).toString(),
      lifetimeSpent: toBigInt(row.lifetime_spent).toString(),
      walletStatus: row.wallet_status,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async opsCreatePriceCard(rawBody: unknown, actorId: string): Promise<BillingPriceCardDto> {
    const parsed = CreatePriceCardBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }
    const { actionCode, displayName, pricingMode, creditsPerUnit, defaultHoldUnits, active } = parsed.data;
    const rows = await this.prisma.$queryRaw<PriceCardRawRow[]>`
      SELECT * FROM public.app_ops_create_price_card(
        ${actionCode}::varchar,
        ${displayName}::varchar,
        ${pricingMode}::varchar,
        ${parseCreditsBigInt(creditsPerUnit)}::bigint,
        ${defaultHoldUnits}::integer,
        ${active}::boolean
      )
    `;
    const created = rows[0];
    if (!created) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: '创建价目表失败' },
      });
    }
    const dto = serializeRawPriceCard(created);
    await this.audit.record({
      realm: 'ops',
      actorId,
      action: 'wallet.price_card.create',
      target: dto.id,
      detail: {
        actionCode: dto.actionCode,
        creditsPerUnit: dto.creditsPerUnit,
        defaultHoldUnits: dto.defaultHoldUnits,
        active: dto.active,
      },
    });
    return dto;
  }

  async opsUpdatePriceCard(
    id: string,
    rawBody: unknown,
    actorId: string,
  ): Promise<BillingPriceCardDto> {
    this.assertUuid(id, 'priceCardId');
    const parsed = UpdatePriceCardBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }
    const d = parsed.data;
    const creditsVal = d.creditsPerUnit !== undefined ? parseCreditsBigInt(d.creditsPerUnit) : null;
    const rows = await this.prisma.$queryRaw<PriceCardRawRow[]>`
      SELECT * FROM public.app_ops_update_price_card(
        ${id}::uuid,
        ${d.displayName ?? null}::varchar,
        ${d.pricingMode ?? null}::varchar,
        ${creditsVal}::bigint,
        ${d.defaultHoldUnits ?? null}::integer,
        ${d.active ?? null}::boolean
      )
    `;
    const updated = rows[0];
    if (!updated) {
      throw new NotFoundException({
        error: { code: 'NOT_FOUND', message: '价目表记录不存在' },
      });
    }
    const dto = serializeRawPriceCard(updated);
    await this.audit.record({
      realm: 'ops',
      actorId,
      action: 'wallet.price_card.update',
      target: dto.id,
      detail: {
        actionCode: dto.actionCode,
        creditsPerUnit: dto.creditsPerUnit,
        defaultHoldUnits: dto.defaultHoldUnits,
        active: dto.active,
      },
    });
    return dto;
  }

  /**
   * 运营毛利对账视图：聚合 gain_saas.wallet_ledger 实收折算收入 vs global_dev.usage_ledger 底层美元成本。
   */
  async opsProfitReconciliation(
    query: { from: Date; to: Date; workspaceId?: string },
    opsDb: OpsDatabase | undefined = this.opsDatabase,
  ): Promise<ProfitReconciliationDto> {
    if (query.workspaceId) {
      this.assertUuid(query.workspaceId, 'workspaceId');
    }

    const walletRows = await this.prisma.$queryRaw<
      Array<{
        workspace_id: string;
        workspace_name: string;
        settled_credits: bigint;
        paid_revenue_micros: bigint;
        topup_credits: bigint;
        bonus_credits: bigint;
        released_credits: bigint;
        ledger_entries: bigint;
      }>
    >`SELECT * FROM public.app_ops_wallet_profit_summary(${query.from}, ${query.to}, ${query.workspaceId ?? null}::uuid)`;

    const costByWorkspace = new Map<string, bigint>();
    let engineCostStatus: 'ok' | 'unavailable' = 'unavailable';
    let engineCostReason: string | undefined;

    if (opsDb) {
      try {
        const engineRows = (await opsDb.db.query(
          query.workspaceId
            ? `SELECT workspace_id::text AS workspace_id, COALESCE(SUM(cost_usd), 0) AS cost_usd
               FROM usage_ledger
               WHERE workspace_id = $1::uuid AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
               GROUP BY workspace_id`
            : `SELECT workspace_id::text AS workspace_id, COALESCE(SUM(cost_usd), 0) AS cost_usd
               FROM usage_ledger
               WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
               GROUP BY workspace_id`,
          query.workspaceId
            ? [query.workspaceId, query.from.toISOString(), query.to.toISOString()]
            : [query.from.toISOString(), query.to.toISOString()],
        )) as Array<{ workspace_id: string; cost_usd: string | number | null }>;
        for (const r of engineRows) {
          if (!r.workspace_id) continue;
          const usd = Number(r.cost_usd ?? 0);
          const micros = Number.isFinite(usd) && usd > 0 ? BigInt(Math.round(usd * 1_000_000)) : 0n;
          costByWorkspace.set(r.workspace_id.toLowerCase(), micros);
        }
        engineCostStatus = 'ok';
      } catch (err) {
        engineCostStatus = 'unavailable';
        engineCostReason = `引擎 usage_ledger 不可用（${err instanceof Error ? err.message : String(err)}）`;
      }
    } else {
      engineCostReason = '未配置引擎运营库连接（OPS_APP_DATABASE_URL）';
    }

    const rowMap = new Map<string, ProfitReconciliationRowDto>();
    let totalSettled = 0n;
    let totalRevenue = 0n;
    let totalEngineCost = 0n;

    for (const row of walletRows) {
      const wsKey = row.workspace_id.toLowerCase();
      const settled = toBigInt(row.settled_credits);
      const rev = toBigInt(row.paid_revenue_micros);
      const cost = costByWorkspace.get(wsKey) ?? 0n;
      const profit = rev - cost;

      totalSettled += settled;
      totalRevenue += rev;
      totalEngineCost += cost;

      rowMap.set(wsKey, {
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        settledCredits: settled.toString(),
        paidRevenueMicros: rev.toString(),
        engineCostMicros: cost.toString(),
        grossProfitMicros: profit.toString(),
        grossMarginPct: computeGrossMarginPct(rev, cost),
        topUpCredits: toBigInt(row.topup_credits).toString(),
        bonusCredits: toBigInt(row.bonus_credits).toString(),
        releasedCredits: toBigInt(row.released_credits).toString(),
        ledgerEntries: Number(row.ledger_entries),
      });
    }

    // 纳入有引擎消耗但尚无钱包流水的租户（便于及时发现无充值跑费异常）
    for (const [wsKey, cost] of costByWorkspace.entries()) {
      if (rowMap.has(wsKey) || cost <= 0n) continue;
      totalEngineCost += cost;
      rowMap.set(wsKey, {
        workspaceId: wsKey,
        workspaceName: wsKey.slice(0, 8),
        settledCredits: '0',
        paidRevenueMicros: '0',
        engineCostMicros: cost.toString(),
        grossProfitMicros: (-cost).toString(),
        grossMarginPct: null,
        topUpCredits: '0',
        bonusCredits: '0',
        releasedCredits: '0',
        ledgerEntries: 0,
      });
    }

    const rows = [...rowMap.values()].sort((a, b) => {
      const diff = BigInt(b.paidRevenueMicros) - BigInt(a.paidRevenueMicros);
      if (diff !== 0n) return diff > 0n ? 1 : -1;
      const costDiff = BigInt(b.engineCostMicros) - BigInt(a.engineCostMicros);
      return costDiff > 0n ? 1 : costDiff < 0n ? -1 : 0;
    });

    const totalProfit = totalRevenue - totalEngineCost;
    return {
      window: { from: query.from.toISOString(), to: query.to.toISOString() },
      engineCostStatus,
      ...(engineCostReason ? { engineCostReason } : {}),
      totals: {
        settledCredits: totalSettled.toString(),
        paidRevenueMicros: totalRevenue.toString(),
        engineCostMicros: totalEngineCost.toString(),
        grossProfitMicros: totalProfit.toString(),
        grossMarginPct: computeGrossMarginPct(totalRevenue, totalEngineCost),
      },
      rows,
    };
  }
}
