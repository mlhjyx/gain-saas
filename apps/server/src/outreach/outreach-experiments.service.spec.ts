import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import {
  assignmentBucket,
  decideArm,
  OutreachExperimentsService,
} from './outreach-experiments.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAMPAIGN = '77777777-7777-4777-8777-777777777777';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };
const REF_A = '55555555-5555-4555-8555-555555555555';
const REF_B = '66666666-6666-4666-8666-666666666666';

interface Row {
  [key: string]: unknown;
}

class FakeExperimentsPrisma {
  experiments: Row[] = [];
  assignments: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly outreachExperiment = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), state: 'DRAFT', createdAt: new Date(), ...data };
      this.experiments.push(row);
      return { ...row };
    },
    findFirst: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = this.experiments.find(
        (candidate) =>
          (!where.id || candidate.id === where.id) &&
          (!where.workspaceId || candidate.workspaceId === where.workspaceId),
      );
      if (!row) return null;
      if (!include) return { ...row };
      return {
        ...row,
        assignments: this.assignments.filter(
          (assignment) => assignment.experimentId === row.id,
        ),
      };
    },
    findMany: async ({ where, select }: { where: Row; select?: Row }) => {
      const rows = this.experiments.filter(
        (candidate) =>
          candidate.workspaceId === where.workspaceId &&
          (!where.campaignId || candidate.campaignId === where.campaignId) &&
          (!where.state || candidate.state === where.state),
      );
      if (select) return rows.map((row) => ({ id: row.id }));
      return rows.map((row) => ({
        ...row,
        assignments: this.assignments.filter(
          (assignment) => assignment.experimentId === row.id,
        ),
      }));
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.experiments.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };

  readonly outreachExperimentAssignment = {
    createMany: async ({
      data,
      skipDuplicates,
    }: {
      data: Row[];
      skipDuplicates?: boolean;
    }) => {
      let count = 0;
      for (const row of data) {
        if (
          skipDuplicates &&
          this.assignments.some(
            (existing) =>
              existing.experimentId === row.experimentId &&
              existing.subjectType === row.subjectType &&
              existing.subjectRef === row.subjectRef,
          )
        ) {
          continue;
        }
        this.assignments.push({ id: this.id(), assignedAt: new Date(), ...row });
        count += 1;
      }
      return { count };
    },
    findMany: async ({ where }: { where: Row }) => {
      const idList = (condition: unknown): unknown[] =>
        condition && typeof condition === 'object' && 'in' in (condition as Row)
          ? ((condition as { in: unknown[] }).in ?? [])
          : [condition];
      return this.assignments.filter(
        (row) =>
          idList(where.experimentId).includes(row.experimentId) &&
          (!where.subjectType || row.subjectType === where.subjectType) &&
          (!where.arm || row.arm === where.arm) &&
          idList(where.subjectRef).includes(row.subjectRef),
      );
    },
  };
}

function build() {
  const prisma = new FakeExperimentsPrisma();
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return {
    prisma,
    service: new OutreachExperimentsService(prisma as unknown as PrismaService, audit),
  };
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

const baseInput = {
  name: '首触 holdout',
  hypothesis: '冷邮件首触提升 meeting 率',
  primaryMetric: 'meeting_held_rate',
  campaignId: CAMPAIGN,
};

describe('实验分配函数（可复算）', () => {
  it('bucket 稳定且落在 0..255；不同对象分布不同', () => {
    const a1 = assignmentBucket('s'.repeat(64), 'e1', REF_A);
    const a2 = assignmentBucket('s'.repeat(64), 'e1', REF_A);
    const b = assignmentBucket('s'.repeat(64), 'e1', REF_B);
    expect(a1).toBe(a2);
    expect(a1).toBeGreaterThanOrEqual(0);
    expect(a1).toBeLessThanOrEqual(255);
    expect(typeof b).toBe('number');
  });

  it('decideArm 边界：bucket < floor(ratio*256) 为 holdout', () => {
    expect(decideArm(24, 0.1)).toBe('holdout');
    expect(decideArm(25, 0.1)).toBe('treatment');
    expect(decideArm(0, 0.5)).toBe('holdout');
    expect(decideArm(255, 0.5)).toBe('treatment');
  });
});

describe('OutreachExperimentsService（P4-09）', () => {
  it('创建：冻结 64 位盐；校验字段；列表返回各 arm 计数', async () => {
    const { prisma, service } = build();
    const created = await service.create(tenant, baseInput);
    expect(created.assignmentSalt).toMatch(/^[0-9a-f]{64}$/);
    expect(created.state).toBe('DRAFT');
    await expect(service.create(tenant, { ...baseInput, holdoutRatio: 1.5 })).rejects.toSatisfy(
      (error) => errorCode(error) === 'VALIDATION_ERROR',
    );
    await expect(service.create(tenant, { ...baseInput, name: '' })).rejects.toSatisfy(
      (error) => errorCode(error) === 'VALIDATION_ERROR',
    );
    const list = await service.list(tenant);
    expect(list[0].assignmentCounts).toEqual({ treatment: 0, holdout: 0 });
    expect(prisma.experiments).toHaveLength(1);
  });

  it('状态机：DRAFT→RUNNING；重复 start 拒绝；归档后不可再 start', async () => {
    const { service } = build();
    const created = await service.create(tenant, baseInput);
    const running = await service.start(tenant, created.id);
    expect(running.state).toBe('RUNNING');
    await expect(service.start(tenant, created.id)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_EXPERIMENT_NOT_DRAFT',
    );
    const archived = await service.archive(tenant, created.id);
    expect(archived.state).toBe('ARCHIVED');
    await expect(service.start(tenant, created.id)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_EXPERIMENT_NOT_DRAFT',
    );
  });

  it('分配：仅 RUNNING；确定性（重复分配结果一致）；幂等去重', async () => {
    const { prisma, service } = build();
    const created = await service.create(tenant, { ...baseInput, holdoutRatio: 0.5 });
    await expect(
      service.assign(tenant, created.id, { subjectType: 'contact', subjectRefs: [REF_A] }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_EXPERIMENT_NOT_RUNNING');

    await service.start(tenant, created.id);
    const first = await service.assign(tenant, created.id, {
      subjectType: 'contact',
      subjectRefs: [REF_A, REF_B],
    });
    const second = await service.assign(tenant, created.id, {
      subjectType: 'contact',
      subjectRefs: [REF_A, REF_B],
    });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(prisma.assignments).toHaveLength(2);
    const byRef = new Map(first.map((row) => [row.subjectRef, row]));
    expect(byRef.get(REF_A)!.bucket).toBe(
      assignmentBucket(created.assignmentSalt, created.id, REF_A),
    );
    expect(byRef.get(REF_B)!.bucket).toBe(
      assignmentBucket(created.assignmentSalt, created.id, REF_B),
    );
  });

  it('holdoutContacts：只认 RUNNING + contact 级 + 指定 campaign', async () => {
    const { prisma, service } = build();
    const created = await service.create(tenant, { ...baseInput, holdoutRatio: 0.99 });
    await service.start(tenant, created.id);
    await service.assign(tenant, created.id, {
      subjectType: 'contact',
      subjectRefs: [REF_A],
    });
    expect((await service.holdoutContacts(tenant, CAMPAIGN, [REF_A, REF_B]))).toEqual(
      new Set([REF_A]),
    );
    // 账户级分配不参与发送排除（草稿尚无账户引用）。
    const accountExperiment = await service.create(tenant, {
      ...baseInput,
      holdoutRatio: 0.99,
      campaignId: CAMPAIGN,
    });
    await service.start(tenant, accountExperiment.id);
    await service.assign(tenant, accountExperiment.id, {
      subjectType: 'account',
      subjectRefs: [REF_B],
    });
    expect((await service.holdoutContacts(tenant, CAMPAIGN, [REF_B]))).toEqual(
      new Set<string>(),
    );
    // 归档后不再排除。
    await service.archive(tenant, created.id);
    expect((await service.holdoutContacts(tenant, CAMPAIGN, [REF_A]))).toEqual(
      new Set<string>(),
    );
    expect(prisma.experiments.length).toBe(2);
  });
});
