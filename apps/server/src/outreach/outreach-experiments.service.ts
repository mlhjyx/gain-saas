import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DESIGNS = ['holdout', 'ab'] as const;
const SUBJECT_TYPES = ['account', 'contact'] as const;

export type ExperimentArm = 'treatment' | 'holdout';

/** bucket = sha256(salt|experimentId|subjectRef) 的前 8 个 bit（0..255），任何人可复算。 */
export function assignmentBucket(
  salt: string,
  experimentId: string,
  subjectRef: string,
): number {
  const hash = createHash('sha256')
    .update(`${salt}|${experimentId}|${subjectRef}`)
    .digest('hex');
  return Number.parseInt(hash.slice(0, 2), 16);
}

/** holdout 当 bucket < floor(ratio×256)；确定性、与分配顺序无关。 */
export function decideArm(bucket: number, holdoutRatio: number): ExperimentArm {
  return bucket < Math.floor(holdoutRatio * 256) ? 'holdout' : 'treatment';
}

export interface CreateExperimentInput {
  name: unknown;
  hypothesis: unknown;
  primaryMetric: unknown;
  campaignId?: unknown;
  design?: unknown;
  holdoutRatio?: unknown;
  strata?: unknown;
  analysisPlan?: unknown;
}

export interface AssignSubjectsInput {
  subjectType?: unknown;
  subjectRefs: unknown;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}
function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_EXPERIMENT_NOT_FOUND', message: '实验不存在' },
  });
}

/**
 * 实验与 holdout（P4-09，ch05 §5.3.7）：创建时冻结分配盐与口径；分配是确定性哈希，
 * 可被任何人用同一函数复算（避免事后挑对照组）。发送执行器按 RUNNING 实验的 holdout
 * 联系人排除（contact 级；account 级需草稿携带账户引用后启用，口径差异已在 evidence 标注）。
 */
@Injectable()
export class OutreachExperimentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(tenant: OutreachTenant, input: CreateExperimentInput) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 200) invalid('实验名称必填且不超过 200 字');
    const hypothesis = typeof input.hypothesis === 'string' ? input.hypothesis.trim() : '';
    if (!hypothesis || hypothesis.length > 2000) invalid('假设必填且不超过 2000 字');
    const primaryMetric =
      typeof input.primaryMetric === 'string' ? input.primaryMetric.trim() : '';
    if (!primaryMetric || primaryMetric.length > 64) invalid('主指标必填且不超过 64 字');
    const design = input.design === undefined ? 'holdout' : input.design;
    if (typeof design !== 'string' || !(DESIGNS as readonly string[]).includes(design)) {
      invalid('design 必须是 holdout 或 ab');
    }
    const holdoutRatio = input.holdoutRatio === undefined ? 0.1 : Number(input.holdoutRatio);
    if (!Number.isFinite(holdoutRatio) || holdoutRatio <= 0 || holdoutRatio >= 1) {
      invalid('holdoutRatio 必须在 (0,1) 之间');
    }
    let campaignId: string | null = null;
    if (input.campaignId !== undefined && input.campaignId !== null) {
      if (typeof input.campaignId !== 'string' || !UUID_RE.test(input.campaignId)) {
        invalid('campaignId must be a UUID');
      }
      campaignId = input.campaignId;
    }
    const experiment = await this.prisma.outreachExperiment.create({
      data: {
        workspaceId: tenant.workspaceId,
        campaignId,
        name,
        hypothesis,
        primaryMetric,
        design,
        holdoutRatio,
        assignmentSalt: randomBytes(32).toString('hex'),
        strata:
          input.strata === undefined
            ? undefined
            : (input.strata as Prisma.InputJsonValue),
        analysisPlan:
          input.analysisPlan === undefined
            ? undefined
            : (input.analysisPlan as Prisma.InputJsonValue),
        createdBy: tenant.userId,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.experiment.created',
      target: experiment.id,
      detail: { name, design, holdoutRatio, campaignId },
    });
    return experiment;
  }

  async list(tenant: OutreachTenant) {
    const rows = await this.prisma.outreachExperiment.findMany({
      where: { workspaceId: tenant.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { assignments: { select: { arm: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      campaignId: row.campaignId,
      design: row.design,
      holdoutRatio: row.holdoutRatio,
      primaryMetric: row.primaryMetric,
      state: row.state,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      assignmentCounts: {
        treatment: row.assignments.filter((assignment) => assignment.arm === 'treatment')
          .length,
        holdout: row.assignments.filter((assignment) => assignment.arm === 'holdout').length,
      },
      createdAt: row.createdAt,
    }));
  }

  async get(tenant: OutreachTenant, experimentId: string) {
    if (!UUID_RE.test(experimentId)) notFound();
    const row = await this.prisma.outreachExperiment.findFirst({
      where: { id: experimentId, workspaceId: tenant.workspaceId },
      include: { assignments: { orderBy: { assignedAt: 'asc' }, take: 500 } },
    });
    if (!row) notFound();
    return row;
  }

  async start(tenant: OutreachTenant, experimentId: string) {
    const experiment = await this.requireExperiment(tenant, experimentId);
    if (experiment.state !== 'DRAFT') {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_EXPERIMENT_NOT_DRAFT',
          message: `实验状态为 ${experiment.state}，只有 DRAFT 可以启动`,
        },
      });
    }
    const updated = await this.prisma.outreachExperiment.update({
      where: { id: experimentId },
      data: { state: 'RUNNING', startedAt: new Date() },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.experiment.started',
      target: experimentId,
    });
    return updated;
  }

  async archive(tenant: OutreachTenant, experimentId: string) {
    const experiment = await this.requireExperiment(tenant, experimentId);
    if (experiment.state === 'ARCHIVED') {
      throw new ConflictException({
        error: { code: 'OUTREACH_EXPERIMENT_ARCHIVED', message: '实验已归档' },
      });
    }
    const updated = await this.prisma.outreachExperiment.update({
      where: { id: experimentId },
      data: { state: 'ARCHIVED', endedAt: new Date() },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.experiment.archived',
      target: experimentId,
    });
    return updated;
  }

  /** 分配（仅 RUNNING）：确定性哈希 + createMany skipDuplicates，重复分配幂等。 */
  async assign(tenant: OutreachTenant, experimentId: string, input: AssignSubjectsInput) {
    const experiment = await this.requireExperiment(tenant, experimentId);
    if (experiment.state !== 'RUNNING') {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_EXPERIMENT_NOT_RUNNING',
          message: '实验未处于 RUNNING，不能分配对象',
        },
      });
    }
    const subjectType = input.subjectType === undefined ? 'account' : input.subjectType;
    if (
      typeof subjectType !== 'string' ||
      !(SUBJECT_TYPES as readonly string[]).includes(subjectType)
    ) {
      invalid('subjectType 必须是 account 或 contact');
    }
    if (!Array.isArray(input.subjectRefs) || input.subjectRefs.length === 0) {
      invalid('subjectRefs 必须是非空 UUID 数组');
    }
    if (input.subjectRefs.length > 500) invalid('单次最多分配 500 个对象');
    const subjects = [...new Set(input.subjectRefs)];
    for (const ref of subjects) {
      if (typeof ref !== 'string' || !UUID_RE.test(ref)) invalid('subjectRefs 含非法 UUID');
    }
    const data = subjects.map((subjectRef) => {
      const bucket = assignmentBucket(
        experiment.assignmentSalt,
        experiment.id,
        subjectRef as string,
      );
      return {
        experimentId: experiment.id,
        subjectType,
        subjectRef: subjectRef as string,
        arm: decideArm(bucket, experiment.holdoutRatio),
        bucket,
      };
    });
    await this.prisma.outreachExperimentAssignment.createMany({ data, skipDuplicates: true });
    const assignments = await this.prisma.outreachExperimentAssignment.findMany({
      where: { experimentId: experiment.id, subjectRef: { in: subjects as string[] } },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.experiment.assigned',
      target: experiment.id,
      detail: {
        subjectType,
        count: assignments.length,
        holdout: assignments.filter((row) => row.arm === 'holdout').length,
      },
    });
    return assignments;
  }

  /** 发送路径用：campaign 下 RUNNING 实验里被判为 holdout 的联系人集合。 */
  async holdoutContacts(
    tenant: OutreachTenant,
    campaignId: string,
    contactRefs: readonly string[],
  ): Promise<Set<string>> {
    if (contactRefs.length === 0) return new Set();
    const experiments = await this.prisma.outreachExperiment.findMany({
      where: { workspaceId: tenant.workspaceId, campaignId, state: 'RUNNING' },
      select: { id: true },
    });
    if (experiments.length === 0) return new Set();
    const assignments = await this.prisma.outreachExperimentAssignment.findMany({
      where: {
        experimentId: { in: experiments.map((experiment) => experiment.id) },
        subjectType: 'contact',
        arm: 'holdout',
        subjectRef: { in: [...contactRefs] },
      },
      select: { subjectRef: true },
    });
    return new Set(assignments.map((assignment) => assignment.subjectRef));
  }

  private async requireExperiment(tenant: OutreachTenant, experimentId: string) {
    if (!UUID_RE.test(experimentId)) notFound();
    const experiment = await this.prisma.outreachExperiment.findFirst({
      where: { id: experimentId, workspaceId: tenant.workspaceId },
    });
    if (!experiment) notFound();
    return experiment;
  }
}
