import { Controller, Get, HttpException, NotFoundException, Optional, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { EngineHttp } from '../bff/engine-http.js';
import { PrismaService } from '../shared/prisma.service.js';
import { TenantGuard } from './tenant.guard.js';

/**
 * 工作空间上下文与纯实体/存储用量全景(SD11/§10.4 + MT-P1)：
 * - GET /api/workspace/context：前端据此渲染角色差异与「允许动作」；
 * - GET /api/workspace/usage-summary：透传引擎 GET /api/v1/workspace/usage-summary 并融合 SaaS 侧实体计数与存储配额预警。
 */
const ALLOWED_ACTIONS: Record<string, readonly string[]> = {
  admin: [
    'workspace.rename',
    'workspace.leave',
    'members.manage',
    'company.manage',
    'acquisition.run',
    'reports.view',
    'onboarding.complete',
  ],
  member: ['workspace.leave', 'acquisition.run', 'reports.view'],
};

export const DEFAULT_STORAGE_QUOTA = Object.freeze({
  maxDocumentsPerWorkspace: 500,
  maxDocumentsPerCompany: 200,
  maxBytesPerWorkspace: 2_147_483_648n,
  maxExportsPerDay: 10,
});

function ratioOf(used: number, max: number): number {
  if (max <= 0) return 0;
  return used / max;
}

@Controller('api/workspace')
@UseGuards(TenantGuard)
export class WorkspaceContextController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly engine?: EngineHttp,
  ) {}

  @Get('context')
  async context(@Req() req: Request) {
    const tenant = req.tenant!;
    const [membership, user] = await Promise.all([
      this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
        tx.membership.findFirst({
          where: {
            userId: tenant.userId,
            workspaceId: tenant.workspaceId,
            status: 'active',
          },
          include: { workspace: { select: { id: true, name: true } } },
        }),
      ),
      this.prisma.user.findUnique({
        where: { id: tenant.userId },
        select: { id: true, email: true },
      }),
    ]);
    if (!membership || !user) {
      throw new NotFoundException({
        error: { code: 'WORKSPACE_CONTEXT_UNAVAILABLE', message: '工作空间或用户不存在' },
      });
    }
    return {
      data: {
        user: { id: user.id, email: user.email },
        workspace: {
          id: membership.workspace.id,
          name: membership.workspace.name,
          role: membership.role,
        },
        onboarding: {
          complete: tenant.onboardingCompleted !== false,
          companyId: tenant.onboardingCompanyId ?? null,
        },
        allowedActions: ALLOWED_ACTIONS[membership.role] ?? [],
      },
    };
  }

  @Get('usage-summary')
  async usageSummary(@Req() req: Request) {
    const tenant = req.tenant!;
    const lang = req.headers?.['accept-language'] as string | undefined;
    if (!this.engine) {
      throw new HttpException(
        { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: '引擎客户端未初始化' } },
        502,
      );
    }
    let engineRes;
    try {
      engineRes = await this.engine.call(tenant, 'GET', '/workspace/usage-summary');
    } catch (err) {
      throw new HttpException(
        this.engine.toClientError(
          502,
          { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: err instanceof Error ? err.message : String(err) } },
          lang,
        ),
        502,
      );
    }
    if (engineRes.status >= 400) {
      throw new HttpException(
        this.engine.toClientError(engineRes.status, engineRes.body, lang),
        this.engine.toClientStatus(engineRes.status, engineRes.body),
      );
    }
    const engineData = ((engineRes.body as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<
      string,
      unknown
    >;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

    const saas = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const [activeMembers, campaigns, qgos, saos, outreachSent30d, storageRow] = await Promise.all([
        tx.membership.count({ where: { workspaceId: tenant.workspaceId, status: 'active' } }),
        tx.campaign.count({ where: { workspaceId: tenant.workspaceId } }),
        tx.qgo.count({ where: { workspaceId: tenant.workspaceId } }),
        tx.sao.count({ where: { workspaceId: tenant.workspaceId } }),
        tx.outreachSend.count({
          where: { workspaceId: tenant.workspaceId, status: 'SENT', createdAt: { gte: thirtyDaysAgo } },
        }),
        tx.workspaceStorageQuota.findUnique({ where: { workspaceId: tenant.workspaceId } }),
      ]);

      const maxDocs = storageRow?.maxDocumentsPerWorkspace ?? DEFAULT_STORAGE_QUOTA.maxDocumentsPerWorkspace;
      const maxDocsPerCompany = storageRow?.maxDocumentsPerCompany ?? DEFAULT_STORAGE_QUOTA.maxDocumentsPerCompany;
      const maxBytes = storageRow?.maxBytesPerWorkspace ?? DEFAULT_STORAGE_QUOTA.maxBytesPerWorkspace;
      const maxExportsPerDay = storageRow?.maxExportsPerDay ?? DEFAULT_STORAGE_QUOTA.maxExportsPerDay;

      const sellerDocs = (engineData.sellerDocuments ?? {}) as { total?: number; totalBytes?: number };
      const peakRatio = Math.max(
        0,
        ratioOf(Number(sellerDocs.total ?? 0), maxDocs),
        ratioOf(Number(sellerDocs.totalBytes ?? 0), Number(maxBytes)),
      );
      const alertLevel: 'ok' | 'warning' | 'critical' =
        peakRatio >= 0.95 ? 'critical' : peakRatio >= 0.8 ? 'warning' : 'ok';

      return {
        activeMembers,
        campaigns,
        qgos,
        saos,
        outreachSent30d,
        storageQuota: {
          maxDocumentsPerWorkspace: maxDocs,
          maxDocumentsPerCompany: maxDocsPerCompany,
          maxBytesPerWorkspace: maxBytes.toString(),
          maxExportsPerDay,
          isDefault: storageRow === null,
        },
        alertLevel,
      };
    });

    return {
      data: {
        ...engineData,
        workspaceId: typeof engineData.workspaceId === 'string' ? engineData.workspaceId : tenant.workspaceId,
        saas,
      },
    };
  }
}
