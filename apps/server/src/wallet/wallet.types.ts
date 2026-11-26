import { HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';

export const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;
/** 单次充值/赠点/价目单价安全上界（10 亿点；保证 credits * unitPriceMicros <= 1e18 < PG int8 max）。 */
export const MAX_SINGLE_CREDITS = 1_000_000_000n;
/** 单点折算单价安全上界（10 亿微美元 = $1,000/点）。 */
export const MAX_UNIT_PRICE_MICROS = 1_000_000_000n;

const NO_CONTROL_CHARS_RE = /^[^\u0000-\u001f\u007f]+$/;
const POSITIVE_BIGINT_RE = /^[1-9]\d{0,18}$/;
const NONNEG_BIGINT_RE = /^(0|[1-9]\d{0,18})$/;
const ACTION_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const HOLD_UNITS_STR_RE = /^[1-9]\d{0,4}$/;

function parseBoundedPositiveCredits(raw: string): boolean {
  if (!POSITIVE_BIGINT_RE.test(raw)) return false;
  const val = BigInt(raw);
  return val >= 1n && val <= MAX_SINGLE_CREDITS;
}

function parseBoundedNonNegCredits(raw: string): boolean {
  if (!NONNEG_BIGINT_RE.test(raw)) return false;
  const val = BigInt(raw);
  return val >= 0n && val <= MAX_SINGLE_CREDITS;
}

function parseBoundedUnitPriceMicros(raw: string): boolean {
  if (!NONNEG_BIGINT_RE.test(raw)) return false;
  const val = BigInt(raw);
  return val >= 0n && val <= MAX_UNIT_PRICE_MICROS;
}

/** 严格拒绝 boolean / null / 浮点数，仅接受 1..10000 整数或其十进制数字串。 */
const StrictHoldUnitsSchema = z.union([
  z.number().int().min(1).max(10000),
  z
    .string()
    .trim()
    .regex(HOLD_UNITS_STR_RE, 'defaultHoldUnits 必须是 1..10000 的整数')
    .transform((v) => Number(v))
    .refine((v) => v >= 1 && v <= 10000, 'defaultHoldUnits 必须是 1..10000 的整数'),
]);

export const TopUpBodySchema = z
  .object({
    credits: z
      .union([z.string(), z.number().int().positive()])
      .transform((v) => String(v).trim())
      .refine(
        parseBoundedPositiveCredits,
        `credits 必须是 1..${MAX_SINGLE_CREDITS.toString()} 之间的正整数`,
      ),
    unitPriceMicros: z
      .union([z.string(), z.number().int().nonnegative()])
      .optional()
      .default('10000')
      .transform((v) => String(v).trim())
      .refine(
        parseBoundedUnitPriceMicros,
        `unitPriceMicros 必须是 0..${MAX_UNIT_PRICE_MICROS.toString()} 之间的非负整数`,
      ),
    externalOrderId: z
      .string()
      .regex(NO_CONTROL_CHARS_RE, 'externalOrderId 不能包含控制字符')
      .transform((v) => v.trim())
      .refine((v) => v.length >= 1 && v.length <= 128, 'externalOrderId 长度须在 1..128 之间'),
    note: z
      .string()
      .regex(NO_CONTROL_CHARS_RE, 'note 不能包含控制字符')
      .transform((v) => v.trim())
      .refine((v) => v.length <= 500, 'note 长度不能超过 500')
      .optional(),
  })
  .strict()
  .refine(
    (d) => BigInt(d.credits) * BigInt(d.unitPriceMicros) <= MAX_PG_BIGINT,
    'credits × unitPriceMicros 超出 BIGINT 安全上界',
  );

export const GrantBonusBodySchema = z
  .object({
    credits: z
      .union([z.string(), z.number().int().positive()])
      .transform((v) => String(v).trim())
      .refine(
        parseBoundedPositiveCredits,
        `credits 必须是 1..${MAX_SINGLE_CREDITS.toString()} 之间的正整数`,
      ),
    sourceType: z.enum(['PLAN_GRANT', 'PROMO_BONUS', 'MANUAL_ADJUST']).default('PROMO_BONUS'),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    externalOrderId: z
      .string()
      .regex(NO_CONTROL_CHARS_RE, 'externalOrderId 不能包含控制字符')
      .transform((v) => v.trim())
      .refine((v) => v.length >= 1 && v.length <= 128, 'externalOrderId 长度须在 1..128 之间'),
    note: z
      .string()
      .regex(NO_CONTROL_CHARS_RE, 'note 不能包含控制字符')
      .transform((v) => v.trim())
      .refine((v) => v.length <= 500, 'note 长度不能超过 500')
      .optional(),
  })
  .strict();

export const WalletStatusBodySchema = z
  .object({
    status: z.enum(['ACTIVE', 'FROZEN']),
    note: z.string().max(500).optional(),
  })
  .strict();

export const CreatePriceCardBodySchema = z
  .object({
    actionCode: z.string().trim().regex(ACTION_CODE_RE, 'actionCode 须为大写字母/数字/下划线'),
    displayName: z.string().trim().min(1).max(120),
    pricingMode: z.enum(['PER_UNIT_OUTCOME', 'FLAT_ACTION']),
    creditsPerUnit: z
      .union([z.string(), z.number().int().nonnegative()])
      .transform((v) => String(v).trim())
      .refine(
        parseBoundedNonNegCredits,
        `creditsPerUnit 必须是 0..${MAX_SINGLE_CREDITS.toString()} 之间的非负整数`,
      ),
    defaultHoldUnits: StrictHoldUnitsSchema.optional().default(1),
    active: z.boolean().optional().default(true),
  })
  .strict()
  .refine(
    (d) => BigInt(d.creditsPerUnit) * BigInt(d.defaultHoldUnits) <= MAX_SINGLE_CREDITS,
    '默认预占积分总额超出安全上界',
  );

export const UpdatePriceCardBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    pricingMode: z.enum(['PER_UNIT_OUTCOME', 'FLAT_ACTION']).optional(),
    creditsPerUnit: z
      .union([z.string(), z.number().int().nonnegative()])
      .transform((v) => String(v).trim())
      .refine(
        parseBoundedNonNegCredits,
        `creditsPerUnit 必须是 0..${MAX_SINGLE_CREDITS.toString()} 之间的非负整数`,
      )
      .optional(),
    defaultHoldUnits: StrictHoldUnitsSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict();

export interface WalletAccountDto {
  readonly workspaceId: string;
  readonly currency: string;
  readonly availableCredits: string;
  readonly heldCredits: string;
  readonly lifetimeToppedUp: string;
  readonly lifetimeSpent: string;
  readonly status: string;
  readonly version: string;
  readonly updatedAt: string;
}

export interface WalletCreditLotDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceType: string;
  readonly initialCredits: string;
  readonly remainingCredits: string;
  readonly unitPriceMicros: string;
  readonly priority: number;
  readonly expiresAt: string | null;
  readonly externalOrderId: string | null;
  readonly note: string | null;
  readonly actorId: string | null;
  readonly createdAt: string;
}

export type TenantWalletCreditLotDto = Omit<
  WalletCreditLotDto,
  'unitPriceMicros' | 'externalOrderId' | 'note' | 'actorId'
>;

export interface WalletHoldDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly actionCode: string;
  readonly refType: string;
  readonly refId: string;
  readonly heldCredits: string;
  readonly settledCredits: string;
  readonly releasedCredits: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export interface WalletLedgerDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly entryType: string;
  readonly deltaAvailable: string;
  readonly deltaHeld: string;
  readonly balanceAvailable: string;
  readonly balanceHeld: string;
  readonly revenueMicros: string;
  readonly holdId: string | null;
  readonly lotId: string | null;
  readonly actionCode: string | null;
  readonly refType: string | null;
  readonly refId: string | null;
  readonly billableUnits: number | null;
  readonly note: string | null;
  readonly actorId: string | null;
  readonly createdAt: string;
}

export type TenantWalletLedgerDto = Omit<
  WalletLedgerDto,
  'revenueMicros' | 'note' | 'actorId'
>;

export interface BillingPriceCardDto {
  readonly id: string;
  readonly actionCode: string;
  readonly displayName: string;
  readonly pricingMode: string;
  readonly creditsPerUnit: string;
  readonly defaultHoldUnits: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WalletSummaryDto {
  readonly billingEnabled: boolean;
  readonly account: WalletAccountDto;
  readonly lotsSummary: {
    readonly bonusCredits: string;
    readonly paidCredits: string;
    readonly totalActiveCredits: string;
    readonly activeLotCount: number;
    readonly soonestExpiryAt: string | null;
  };
  readonly activeHoldsCount: number;
  readonly priceCards: readonly BillingPriceCardDto[];
}

export interface OpsWalletAccountListItemDto {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceStatus: string;
  readonly currency: string;
  readonly availableCredits: string;
  readonly heldCredits: string;
  readonly lifetimeToppedUp: string;
  readonly lifetimeSpent: string;
  readonly walletStatus: string;
  readonly updatedAt: string;
}

export interface ProfitReconciliationRowDto {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly settledCredits: string;
  readonly paidRevenueMicros: string;
  readonly engineCostMicros: string;
  readonly grossProfitMicros: string;
  readonly grossMarginPct: number | null;
  readonly topUpCredits: string;
  readonly bonusCredits: string;
  readonly releasedCredits: string;
  readonly ledgerEntries: number;
}

export interface ProfitReconciliationDto {
  readonly window: { readonly from: string; readonly to: string };
  readonly engineCostStatus: 'ok' | 'unavailable';
  readonly engineCostReason?: string;
  readonly totals: {
    readonly settledCredits: string;
    readonly paidRevenueMicros: string;
    readonly engineCostMicros: string;
    readonly grossProfitMicros: string;
    readonly grossMarginPct: number | null;
  };
  readonly rows: readonly ProfitReconciliationRowDto[];
}

export interface HoldCreditsInput {
  readonly idempotencyKey: string;
  readonly actionCode: string;
  readonly refType: string;
  readonly refId: string;
  readonly units?: number;
  readonly credits?: string | bigint;
  readonly ttlMs?: number;
  readonly actorId?: string | null;
  readonly note?: string | null;
}

export interface SettleHoldInput {
  readonly holdId: string;
  readonly billableUnits: number;
  readonly overrideActualCredits?: string | bigint;
  readonly note?: string | null;
  readonly actorId?: string | null;
}

export class InsufficientCreditsError extends HttpException {
  readonly code = 'INSUFFICIENT_CREDITS';
  readonly availableCredits: string;
  readonly requiredCredits: string;
  readonly actionCode: string;

  constructor(params: { availableCredits: bigint; requiredCredits: bigint; actionCode: string }) {
    super(
      {
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: `积分不足：当前可用 ${params.availableCredits.toString()} 点，本次需预占 ${params.requiredCredits.toString()} 点`,
          details: {
            availableCredits: params.availableCredits.toString(),
            requiredCredits: params.requiredCredits.toString(),
            actionCode: params.actionCode,
          },
        },
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
    this.availableCredits = params.availableCredits.toString();
    this.requiredCredits = params.requiredCredits.toString();
    this.actionCode = params.actionCode;
  }
}

export class WalletFrozenError extends HttpException {
  readonly code = 'WALLET_FROZEN';

  constructor(workspaceId: string) {
    super(
      {
        error: {
          code: 'WALLET_FROZEN',
          message: `工作空间 ${workspaceId} 钱包已冻结`,
        },
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
