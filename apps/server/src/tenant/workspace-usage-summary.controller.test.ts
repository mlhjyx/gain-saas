import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { EngineHttp } from '../bff/engine-http.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { WorkspaceContextController } from './workspace-context.controller.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const WS_ID = '22222222-2222-4222-8222-222222222222';

function tenantReq(role: 'admin' | 'member' = 'member', acceptLanguage = 'zh-CN'): Request {
  return {
    tenant: {
      userId: USER_ID,
      workspaceId: WS_ID,
      role,
      jti: 'jti-1',
      exp: 9_999_999_999,
      onboardingCompleted: true,
      onboardingCompanyId: '44444444-4444-4444-8444-444444444444',
    },
    headers: { 'accept-language': acceptLanguage },
  } as unknown as Request;
}

describe('WorkspaceContextController.usageSummary (GET /api/workspace/usage-summary)', () => {
  it('proxies engine GET /workspace/usage-summary and merges pure entity & storage quota usage', async () => {
    const engineSummary = {
      workspaceId: WS_ID,
      companies: { total: 2, draft: 0, enriching: 0, review: 1, active: 1 },
      sellerDocuments: {
        total: 420,
        ready: 410,
        pendingUpload: 5,
        processing: 3,
        failed: 2,
        totalBytes: 1_800_000_000,
        readyBytes: 1_750_000_000,
        pendingUploadBytes: 50_000_000,
        quota: { maxPerWorkspace: 500, maxPerCompany: 200, maxBytesPerWorkspace: 2_147_483_648 },
      },
      icps: { total: 3, active: 2 },
      discoveryRuns: { total: 10, running: 1, completed: 8, failed: 1 },
      canonicalCompanies: { total: 150 },
      canonicalContacts: { total: 60 },
      siteAssets: { total: 5, totalBytes: 12000 },
      siteReleases: { total: 2, totalBytes: 34000 },
      operationArtifacts: { total: 12, totalBytes: 50000, personalCount: 4, personalBytes: 10000 },
    };

    const tx = {
      membership: { count: vi.fn(async () => 4) },
      campaign: { count: vi.fn(async () => 2) },
      qgo: { count: vi.fn(async () => 7) },
      sao: { count: vi.fn(async () => 3) },
      outreachSend: { count: vi.fn(async () => 45) },
      workspaceStorageQuota: {
        findUnique: vi.fn(async () => ({
          workspaceId: WS_ID,
          maxDocumentsPerWorkspace: 500,
          maxDocumentsPerCompany: 200,
          maxBytesPerWorkspace: 2_147_483_648n,
          maxExportsPerDay: 10,
        })),
      },
    };
    const prisma = {
      withWorkspace: vi.fn(async (_wid: string, fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const engine = {
      call: vi.fn(async () => ({ status: 200, body: { data: engineSummary }, contentType: 'application/json', headers: {} })),
      toClientStatus: vi.fn((s: number) => s),
      toClientError: vi.fn((_s: number, b: unknown) => b),
    } as unknown as EngineHttp;

    const controller = new WorkspaceContextController(prisma, engine);
    const result = await controller.usageSummary(tenantReq());

    expect(engine.call).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, workspaceId: WS_ID, role: 'member' }),
      'GET',
      '/workspace/usage-summary',
    );
    expect(result.data).toMatchObject({
      workspaceId: WS_ID,
      companies: engineSummary.companies,
      sellerDocuments: engineSummary.sellerDocuments,
      saas: {
        activeMembers: 4,
        campaigns: 2,
        qgos: 7,
        saos: 3,
        outreachSent30d: 45,
        storageQuota: {
          maxDocumentsPerWorkspace: 500,
          maxDocumentsPerCompany: 200,
          maxBytesPerWorkspace: '2147483648',
          maxExportsPerDay: 10,
          isDefault: false,
        },
        alertLevel: 'warning',
      },
    });
  });

  it('maps engine 401/403 to 502 so tenant session is never logged out', async () => {
    const prisma = { withWorkspace: vi.fn() } as unknown as PrismaService;
    const engine = {
      call: vi.fn(async () => ({
        status: 403,
        body: { error: { code: 'SCOPE_REQUIRED', message: 'missing scope' } },
        contentType: 'application/json',
        headers: {},
      })),
      toClientStatus: vi.fn(() => 502),
      toClientError: vi.fn(() => ({ error: { code: 'SCOPE_REQUIRED', userCopy: { title: '服务授权校验暂未通过', why: '', next: '' } } })),
    } as unknown as EngineHttp;

    const controller = new WorkspaceContextController(prisma, engine);
    const err = await controller.usageSummary(tenantReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(502);
  });
});
