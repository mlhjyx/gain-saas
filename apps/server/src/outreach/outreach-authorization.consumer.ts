import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { normalizeCountry } from './outreach-jurisdiction.js';

/**
 * ExecutionAuthorization v2 的只读消费（第 5 章 D5-4 / P4-03）。
 *
 * scope v2 契约（campaign-authz/v2，存 campaign_execution_authorization.scope）：
 * actions[] 中 `outreach.email.send` 一项绑定 batchId + 收件人集合哈希 + 内容哈希 +
 * caps/schedule/budget/jurisdiction。执行器只读校验并逐封消费 uses；签发与撤销仍由
 * campaign 模块独占（见 campaign-execution-wiring.absence.spec.ts 的引用白名单）。
 */
export const OUTREACH_AUTHZ_ACTION = 'outreach.email.send';
export const OUTREACH_AUTHZ_SCOPE_VERSION = 'campaign-authz/v2';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash64 = z.string().regex(/^[0-9a-f]{64}$/);
const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), '必须是可解析的时间');

const actionSchema = z.object({
  type: z.literal(OUTREACH_AUTHZ_ACTION),
  batchId: z.string().regex(UUID_RE),
  audience: z.object({
    contactRefsHash: hash64,
    count: z.number().int().positive(),
    sizeCap: z.number().int().positive().optional(),
  }),
  template: z.object({
    contentHash: hash64,
    draftSetHash: hash64.optional(),
  }),
  caps: z
    .object({
      perMailboxDaily: z.number().int().positive().optional(),
      perMailboxWeekly: z.number().int().positive().optional(),
      perDomainHourly: z.number().int().positive().optional(),
      batchMax: z.number().int().positive().optional(),
    })
    .optional(),
  schedule: z
    .object({
      notBefore: isoDate,
      notAfter: isoDate,
      windowLocal: z.string().optional(),
      weekdays: z.array(z.number().int().min(1).max(7)).optional(),
      timezonePolicy: z.string().optional(),
    })
    .optional(),
  budget: z
    .object({
      currency: z.string().min(1),
      capMicros: z.number().int().nonnegative(),
    })
    .optional(),
  jurisdiction: z
    .object({
      policyVersion: z.string().optional(),
      allowedCountries: z.array(z.string()).optional(),
      deniedCountries: z.array(z.string()).optional(),
    })
    .optional(),
});

const scopeSchema = z.object({
  schemaVersion: z.literal(OUTREACH_AUTHZ_SCOPE_VERSION),
  actions: z.array(actionSchema),
});

export type OutreachAuthorizationAction = z.infer<typeof actionSchema>;

export interface OutreachAuthorizationBatch {
  id: string;
  campaignId: string | null;
  authorizationId: string | null;
  contentHash: string | null;
}

export interface OutreachAuthorizationDraft {
  id: string;
  contactRef: string;
  countryCode: string | null;
  contentHash?: string | null;
}

export interface OutreachAuthorizationGrant {
  authorizationId: string;
  campaignId: string;
  batchId: string;
  maxUses: number;
  usedUses: number;
  remainingUses: number;
  action: OutreachAuthorizationAction;
}

/** 收件人集合哈希：sha256(sorted(contactRefs).join('\n'))，与签发方同构。 */
export function hashOutreachAudience(contactRefs: readonly string[]): string {
  return createHash('sha256')
    .update([...contactRefs].sort().join('\n'))
    .digest('hex');
}

/** 草稿集哈希：sha256(sorted(`${draftId}:${contentHash}`).join('\n'))，防替换单封。 */
export function hashOutreachDraftSet(
  drafts: ReadonlyArray<{ id: string; contentHash?: string | null }>,
): string {
  return createHash('sha256')
    .update(
      drafts
        .map((draft) => `${draft.id}:${draft.contentHash ?? ''}`)
        .sort()
        .join('\n'),
    )
    .digest('hex');
}

function reject(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

@Injectable()
export class OutreachAuthorizationConsumer {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * 批次级授权校验（在任何投递前执行）。任一不满足即 409，整批拒绝。
   * `pendingCount` 为本次待投递草稿数（用于剩余 uses 与预算估算）。
   */
  async authorizeBatch(
    tenant: OutreachTenant,
    batch: OutreachAuthorizationBatch,
    drafts: ReadonlyArray<OutreachAuthorizationDraft>,
    pendingCount: number,
  ): Promise<OutreachAuthorizationGrant> {
    if (!batch.authorizationId || !UUID_RE.test(batch.authorizationId)) {
      reject(
        'CAMPAIGN_AUTHORIZATION_INVALID',
        '批次未绑定执行授权（ExecutionAuthorization），拒绝发送',
      );
    }
    const row = await this.prisma.campaignExecutionAuthorization.findFirst({
      where: { id: batch.authorizationId, workspaceId: tenant.workspaceId },
    });
    if (!row) {
      reject('CAMPAIGN_AUTHORIZATION_INVALID', '执行授权不存在或不属于当前工作空间');
    }
    if (row.state === 'REVOKED') {
      reject('CAMPAIGN_AUTHORIZATION_REVOKED', '执行授权已被撤销，拒绝发送');
    }
    if (row.state !== 'ISSUED') {
      reject('CAMPAIGN_AUTHORIZATION_INVALID', `执行授权状态为 ${row.state}，不可用`);
    }
    const now = Date.now();
    if (row.expiresAt.getTime() <= now) {
      reject('CAMPAIGN_AUTHORIZATION_EXPIRED', '执行授权已过期，需重新签发');
    }
    if (batch.campaignId && row.campaignId !== batch.campaignId) {
      reject('OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', '授权所属 campaign 与批次不一致');
    }

    const parsed = scopeSchema.safeParse(row.scope);
    if (!parsed.success) {
      reject(
        'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
        '授权 scope 不是 campaign-authz/v2 的 outreach 契约（v1 授权不能用于发送）',
      );
    }
    const action = parsed.data.actions.find((item) => item.batchId === batch.id);
    if (!action) {
      reject('OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', '授权 scope 未覆盖该批次');
    }
    if (!batch.contentHash || action.template.contentHash !== batch.contentHash) {
      reject(
        'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
        '批次内容哈希与授权签发时冻结的内容哈希不符',
      );
    }
    if (
      action.template.draftSetHash &&
      action.template.draftSetHash !== hashOutreachDraftSet(drafts)
    ) {
      reject('OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', '草稿集与授权签发时不一致（疑似替换单封）');
    }
    if (
      action.audience.contactRefsHash !==
      hashOutreachAudience(drafts.map((draft) => draft.contactRef))
    ) {
      reject('OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', '收件人集合与授权签发时不一致');
    }
    if (action.audience.count !== drafts.length) {
      reject(
        'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
        `收件人数 ${drafts.length} 与授权 ${action.audience.count} 不符`,
      );
    }
    if (action.audience.sizeCap && drafts.length > action.audience.sizeCap) {
      reject(
        'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
        `批次规模超过授权的单批上限 ${action.audience.sizeCap}`,
      );
    }
    if (action.schedule) {
      const notBefore = Date.parse(action.schedule.notBefore);
      const notAfter = Date.parse(action.schedule.notAfter);
      if (now < notBefore || now >= notAfter) {
        reject(
          'OUTREACH_SCHEDULE_OUT_OF_WINDOW',
          `当前时间不在授权计划的发送区间内（${action.schedule.notBefore} — ${action.schedule.notAfter}）`,
        );
      }
    }
    if (action.budget) {
      const estimate = pendingCount * this.config.OUTREACH_COST_PER_EMAIL_MICROS;
      if (estimate > action.budget.capMicros) {
        reject(
          'OUTREACH_BUDGET_EXCEEDED',
          `本批预估成本 ${estimate}µUSD 超过授权预算上限 ${action.budget.capMicros}µUSD`,
        );
      }
    }
    const denied = new Set(
      (action.jurisdiction?.deniedCountries ?? []).map((country) => normalizeCountry(country)),
    );
    const allowed = new Set(
      (action.jurisdiction?.allowedCountries ?? []).map((country) => normalizeCountry(country)),
    );
    for (const draft of drafts) {
      const country = normalizeCountry(draft.countryCode);
      // 未知国家不在这里整批拒绝：由逐封法域门按 REVIEW_REQUIRED 跳过（fail-closed 但不误伤整批）。
      if (!country) continue;
      if (denied.has(country)) {
        reject(
          'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
          `批次包含授权排除的国家 ${country}`,
        );
      }
      if (allowed.size > 0 && !allowed.has(country)) {
        reject(
          'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
          `批次包含授权范围外的国家 ${country || 'UNKNOWN'}`,
        );
      }
    }

    const consumedRows = await this.prisma.outreachSend.findMany({
      where: {
        workspaceId: tenant.workspaceId,
        batchId: batch.id,
        draftId: { in: drafts.map((draft) => draft.id) },
        authorizationUse: { not: null },
      },
      select: { draftId: true },
    });
    const consumedDraftIds = new Set(consumedRows.map((row) => row.draftId as string));
    const neededUses = Math.max(0, pendingCount - consumedDraftIds.size);
    const remainingUses = Math.max(row.maxUses - row.uses, 0);
    if (remainingUses < neededUses) {
      reject(
        'CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED',
        `执行授权剩余次数 ${remainingUses} 不足本次待发 ${neededUses} 封`,
      );
    }

    return {
      authorizationId: row.id,
      campaignId: row.campaignId,
      batchId: batch.id,
      maxUses: row.maxUses,
      usedUses: row.uses,
      remainingUses,
      action,
    };
  }

  /**
   * 逐封消费一次授权（与发送台账同事务落 `authorization_use` 由调用方完成）。
   * 幂等：同一草稿的重试沿用首次消费的序号，不重复计数（maxUses = 收件人数）。
   */
  async consumeForDraft(
    tenant: OutreachTenant,
    grant: OutreachAuthorizationGrant,
    draftId: string,
  ): Promise<number> {
    const existing = await this.prisma.outreachSend.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        batchId: grant.batchId,
        draftId,
        authorizationUse: { not: null },
      },
      select: { authorizationUse: true },
    });
    if (existing?.authorizationUse !== null && existing?.authorizationUse !== undefined) {
      return existing.authorizationUse as number;
    }
    const updated = await this.prisma.campaignExecutionAuthorization.updateMany({
      where: {
        id: grant.authorizationId,
        workspaceId: tenant.workspaceId,
        state: 'ISSUED',
        uses: { lt: grant.maxUses },
      },
      data: { uses: { increment: 1 } },
    });
    if (updated.count === 0) {
      reject('CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED', '执行授权次数已耗尽，拒绝发送');
    }
    const row = await this.prisma.campaignExecutionAuthorization.findUnique({
      where: { id: grant.authorizationId },
      select: { uses: true },
    });
    const use = row?.uses ?? grant.usedUses + 1;
    grant.usedUses = use;
    grant.remainingUses = Math.max(grant.maxUses - use, 0);
    return use;
  }
}
