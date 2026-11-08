import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVIDERS = ['glockapps', 'inboxally', 'mailtester', 'manual'] as const;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface SeedTestInput {
  domain: unknown;
  provider: unknown;
  testedAt?: unknown;
  inboxPct?: unknown;
  spamPct?: unknown;
  missingPct?: unknown;
  gmailInboxPct?: unknown;
  outlookInboxPct?: unknown;
  reportRef: unknown;
  contentHash: unknown;
  raw?: unknown;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

function percent(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || Number.isNaN(num) || num < 0 || num > 100) {
    invalid(`${field} 必须是 0..100 的数字`);
  }
  return Math.round(num * 100) / 100;
}

/**
 * 种子放置测试记录（P4-12 warmup/seed 周清单的后端支撑，ch05 §5.3.3.4）。
 * 只做记录与查询；「连续两周不达标暂停该域」的判定读取这里的行（判定在 ops 清单）。
 */
@Injectable()
export class OutreachSeedTestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async record(tenant: OutreachTenant, input: SeedTestInput) {
    const domain =
      typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
    if (!domain || !EMAIL_RE.test(`outreach@${domain}`)) invalid('domain 不合法');
    if (
      typeof input.provider !== 'string' ||
      !(PROVIDERS as readonly string[]).includes(input.provider)
    ) {
      invalid('provider 必须是 glockapps/inboxally/mailtester/manual');
    }
    const reportRef = typeof input.reportRef === 'string' ? input.reportRef.trim() : '';
    if (!reportRef || reportRef.length > 256) invalid('reportRef 必填且不超过 256 字');
    const contentHash =
      typeof input.contentHash === 'string' ? input.contentHash.trim().toLowerCase() : '';
    if (!HASH_RE.test(contentHash)) invalid('contentHash 必须是 64 位十六进制');
    const testedAt =
      input.testedAt === undefined || input.testedAt === null
        ? new Date()
        : new Date(String(input.testedAt));
    if (Number.isNaN(testedAt.getTime())) invalid('testedAt 不是合法时间');

    const inboxPct = percent(input.inboxPct, 'inboxPct');
    const spamPct = percent(input.spamPct, 'spamPct');
    const missingPct = percent(input.missingPct, 'missingPct');
    const gmailInboxPct = percent(input.gmailInboxPct, 'gmailInboxPct');
    const outlookInboxPct = percent(input.outlookInboxPct, 'outlookInboxPct');

    const domainRow = await this.prisma.outreachDomain.upsert({
      where: { workspaceId_domain: { workspaceId: tenant.workspaceId, domain } },
      create: { workspaceId: tenant.workspaceId, domain, kind: 'cold_outbound', state: 'ACTIVE' },
      update: {},
    });
    const row = await this.prisma.outreachSeedTest.create({
      data: {
        workspaceId: tenant.workspaceId,
        domainId: domainRow.id,
        provider: input.provider,
        testedAt,
        inboxPct,
        spamPct,
        missingPct,
        gmailInboxPct,
        outlookInboxPct,
        reportRef,
        contentHash,
        ...(input.raw !== undefined ? { raw: input.raw as Prisma.InputJsonValue } : {}),
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.seed_test.recorded',
      target: row.id,
      detail: { domain, provider: row.provider, spamPct: row.spamPct },
    });
    return row;
  }

  async list(tenant: OutreachTenant, domain?: string) {
    const where: Prisma.OutreachSeedTestWhereInput = {
      workspaceId: tenant.workspaceId,
    };
    if (domain) {
      const domainRow = await this.prisma.outreachDomain.findUnique({
        where: {
          workspaceId_domain: {
            workspaceId: tenant.workspaceId,
            domain: domain.trim().toLowerCase(),
          },
        },
      });
      if (!domainRow) {
        throw new NotFoundException({
          error: { code: 'OUTREACH_DOMAIN_NOT_FOUND', message: '发件域不存在' },
        });
      }
      where.domainId = domainRow.id;
    }
    return this.prisma.outreachSeedTest.findMany({
      where,
      orderBy: { testedAt: 'desc' },
      take: 100,
    });
  }
}
