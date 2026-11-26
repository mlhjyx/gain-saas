import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from '../ops/attribution-test-pg.js';
import type { OpsDatabase } from '../ops/ops-database.service.js';
import { OpsCampaignMetricsService } from '../ops/ops-campaign-metrics.service.js';
import { OpsExportThrottle } from '../ops/ops-export-throttle.js';
import { OpsService } from '../ops/ops.service.js';
import { OutreachSendJobsService } from '../outreach/outreach-send-jobs.service.js';
import { OutreachUnsubscribeService } from '../outreach/outreach-unsubscribe.service.js';
import { AuthController } from '../tenant/auth.controller.js';
import { AuthService } from '../tenant/auth.service.js';
import { DiscoveryRunsController } from '../tenant/discovery-runs.controller.js';
import { SessionService } from '../tenant/session.service.js';
import { WorkspacesController } from '../tenant/workspaces.controller.js';
import { AuditService } from './audit.service.js';
import {
  DATABASE_PRINCIPAL_QUERY,
  isAuthorizedAppDatabasePrincipal,
  PrismaService,
  type AppDatabasePrincipalEvidence,
} from './prisma.service.js';

const available = dockerAvailable();
if (!available) {
  if (process.env.CI === 'true') {
    throw new Error('[rls-isolation.pg] CI requires docker for PG16 RLS isolation tests');
  }
  console.warn('[rls-isolation.pg] docker unavailable, skipping PG16 RLS isolation tests');
}

const TENANT_TABLES = [
  'acquisition_task',
  'campaign',
  'campaign_approval',
  'campaign_audience',
  'campaign_decision_trace',
  'campaign_execution_authorization',
  'campaign_plan_job',
  'campaign_revision',
  'cost_ledger',
  'deletion_mirror',
  'discovery_run_link',
  'event_inbox',
  'feedback_submission',
  'idempotency_record',
  'invitation',
  'legal_review',
  'membership',
  'notification',
  'opportunity_outcome',
  'outreach_audit_package',
  'outreach_batch',
  'outreach_batch_approval',
  'outreach_batch_event',
  'outreach_bounce_writeback',
  'outreach_breaker',
  'outreach_call_attempt',
  'outreach_call_basis',
  'outreach_consent',
  'outreach_domain',
  'outreach_domain_counter',
  'outreach_draft',
  'outreach_experiment',
  'outreach_experiment_assignment',
  'outreach_health_event',
  'outreach_mailbox',
  'outreach_mailbox_counter',
  'outreach_metric_snapshot',
  'outreach_reply',
  'outreach_seed_test',
  'outreach_send',
  'outreach_send_job',
  'outreach_template_version',
  'outreach_unsubscribe_token',
  'qgo',
  'qualified_lead',
  'sao',
  'task_run',
  'workspace_budget_policy',
  'workspace_compliance_declaration',
  'workspace_offboarding_request',
  'workspace_purge_receipt',
  'workspace_registry',
  'workspace_storage_quota',
] as const;

describe.skipIf(!available)('PG16 53-table FORCE RLS, gain_saas_app & SECURITY DEFINER isolation', () => {
  let pg: DisposablePostgres;
  let adminPrisma: PrismaClient;
  let appPrisma: PrismaService;

  const WS_A = randomUUID();
  const WS_B = randomUUID();

  beforeAll(async () => {
    pg = startDisposablePostgres();
    adminPrisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
    appPrisma = new PrismaService({ datasourceUrl: pg.appDatabaseUrl, enforcePrincipal: true });
    await appPrisma.verifyPrincipal();
  }, 900_000);

  afterAll(async () => {
    await appPrisma?.onModuleDestroy().catch(() => undefined);
    await adminPrisma?.$disconnect().catch(() => undefined);
    pg?.stop();
  }, 120_000);

  it('verifies gain_saas_app has rolsuper=f & rolbypassrls=f while owner principal fails fail-closed check', async () => {
    const appEvidence = await appPrisma.$queryRawUnsafe<AppDatabasePrincipalEvidence[]>(
      DATABASE_PRINCIPAL_QUERY,
    );
    expect(appEvidence).toHaveLength(1);
    expect(isAuthorizedAppDatabasePrincipal(appEvidence[0])).toBe(true);

    const ownerEvidence = await adminPrisma.$queryRawUnsafe<AppDatabasePrincipalEvidence[]>(
      DATABASE_PRINCIPAL_QUERY,
    );
    expect(isAuthorizedAppDatabasePrincipal(ownerEvidence[0])).toBe(false);

    const unsafeOwnerService = new PrismaService({
      datasourceUrl: pg.databaseUrl,
      enforcePrincipal: true,
    });
    await expect(unsafeOwnerService.verifyPrincipal()).rejects.toThrow(
      /DATABASE_PRINCIPAL_INVALID/,
    );
    await unsafeOwnerService.onModuleDestroy().catch(() => undefined);
  }, 60_000);

  it('enforces ENABLE + FORCE RLS + policy on all 53 tenant tables, security_invoker on 3 views, and revokes _prisma_migrations', async () => {
    expect(TENANT_TABLES).toHaveLength(53);

    const rlsRows = await adminPrisma.$queryRaw<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `;
    const rlsMap = new Map(rlsRows.map((row) => [row.relname, row]));

    for (const table of TENANT_TABLES) {
      const row = rlsMap.get(table);
      expect(row, `missing table ${table}`).toBeDefined();
      expect(row!.relrowsecurity, `${table} relrowsecurity`).toBe(true);
      expect(row!.relforcerowsecurity, `${table} relforcerowsecurity`).toBe(true);
    }

    for (const nonTenant of ['session', 'audit_log', 'users', 'workspace', 'ops_user', '_prisma_migrations']) {
      const row = rlsMap.get(nonTenant);
      expect(row, `missing table ${nonTenant}`).toBeDefined();
      expect(row!.relrowsecurity, `${nonTenant} should not have RLS`).toBe(false);
    }

    const policies = await adminPrisma.$queryRaw<Array<{ tablename: string; policyname: string }>>`
      SELECT tablename, policyname
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    const policyMap = new Map(policies.map((p) => [p.tablename, p.policyname]));
    for (const table of TENANT_TABLES) {
      expect(policyMap.get(table), `missing policy on ${table}`).toBe(`${table}_tenant_isolation`);
    }

    const views = await adminPrisma.$queryRaw<Array<{ relname: string; reloptions: string[] | null }>>`
      SELECT c.relname, c.reloptions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'v'
        AND c.relname IN ('v_campaign_authorized_plans', 'v_campaign_attribution', 'v_outcome_chain')
      ORDER BY c.relname
    `;
    expect(views).toHaveLength(3);
    for (const view of views) {
      expect(view.reloptions, `${view.relname} reloptions`).toContain('security_invoker=true');
    }

    await expect(
      appPrisma.$queryRawUnsafe(`SELECT migration_name FROM "_prisma_migrations" LIMIT 1`),
    ).rejects.toThrow(/42501|permission denied/i);
  }, 60_000);

  it('fails closed outside withWorkspace, enforces cross-tenant isolation on tables and views, and blocks nested mismatched withWorkspace', async () => {
    const campA = randomUUID();
    const campB = randomUUID();
    const qgoA = randomUUID();
    const qgoB = randomUUID();
    const saoA = randomUUID();
    const saoB = randomUUID();
    const userId = randomUUID();

    await adminPrisma.workspace.createMany({
      data: [
        { id: WS_A, name: 'Tenant A' },
        { id: WS_B, name: 'Tenant B' },
      ],
    });
    await adminPrisma.campaign.createMany({
      data: [
        { id: campA, workspaceId: WS_A, name: 'Camp A', objective: 'obj A', status: 'ACTIVE', createdBy: userId, updatedBy: userId },
        { id: campB, workspaceId: WS_B, name: 'Camp B', objective: 'obj B', status: 'ACTIVE', createdBy: userId, updatedBy: userId },
      ],
    });
    await adminPrisma.qgo.createMany({
      data: [
        { id: qgoA, workspaceId: WS_A, leadRef: randomUUID(), canonicalCompanyRef: randomUUID(), campaignId: campA, title: 'QGO A', evidence: [{ kind: 'fit', verdict: 'match' }], nextStep: 's', state: 'CONVERTED', createdBy: userId },
        { id: qgoB, workspaceId: WS_B, leadRef: randomUUID(), canonicalCompanyRef: randomUUID(), campaignId: campB, title: 'QGO B', evidence: [{ kind: 'fit', verdict: 'match' }], nextStep: 's', state: 'CONVERTED', createdBy: userId },
      ],
    });
    await adminPrisma.sao.createMany({
      data: [
        { id: saoA, workspaceId: WS_A, qgoId: qgoA, state: 'ACCEPTED', decidedBy: userId, decidedAt: new Date() },
        { id: saoB, workspaceId: WS_B, qgoId: qgoB, state: 'ACCEPTED', decidedBy: userId, decidedAt: new Date() },
      ],
    });
    await adminPrisma.opportunityOutcome.createMany({
      data: [
        { id: randomUUID(), workspaceId: WS_A, saoId: saoA, outcome: 'MEETING_BOOKED', occurredAt: new Date(), source: 'MANUAL', createdBy: userId },
        { id: randomUUID(), workspaceId: WS_B, saoId: saoB, outcome: 'WON', occurredAt: new Date(), source: 'MANUAL', createdBy: userId },
      ],
    });

    // Outside withWorkspace: fail-closed reads -> 0 rows, writes -> 42501
    expect(await appPrisma.campaign.findMany()).toEqual([]);
    expect(await appPrisma.qgo.findMany()).toEqual([]);
    await expect(
      appPrisma.campaign.create({
        data: { workspaceId: WS_A, name: 'No Context', objective: 'x', status: 'ACTIVE', createdBy: userId, updatedBy: userId },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
    await expect(appPrisma.withWorkspace('not-a-uuid', async () => null)).rejects.toThrow(
      /INVALID_WORKSPACE_ID/,
    );

    // Inside WS_A: sees only WS_A (including via instance proxy & security_invoker views), cannot touch WS_B
    await appPrisma.withWorkspace(WS_A, async (tx) => {
      const txCampaigns = await tx.campaign.findMany();
      expect(txCampaigns.map((c) => c.id)).toEqual([campA]);

      // Instance proxy inside ALS also routes to active tx
      const proxiedCampaigns = await appPrisma.campaign.findMany();
      expect(proxiedCampaigns.map((c) => c.id)).toEqual([campA]);

      const viewAttr = await tx.$queryRaw<Array<{ campaign_id: string }>>`
        SELECT campaign_id FROM public.v_campaign_attribution
      `;
      expect(viewAttr.map((r) => r.campaign_id)).toEqual([campA]);

      const viewChain = await tx.$queryRaw<Array<{ outcome_type: string; campaign_id: string | null }>>`
        SELECT outcome_type, campaign_id FROM public.v_outcome_chain
      `;
      expect(viewChain).toEqual([{ outcome_type: 'MEETING_BOOKED', campaign_id: campA }]);

      const updateForeign = await tx.campaign.updateMany({
        where: { id: campB },
        data: { name: 'Hacked B' },
      });
      expect(updateForeign.count).toBe(0);

      // Nested same-workspace succeeds
      const nestedSame = await appPrisma.withWorkspace(WS_A, async (innerTx) =>
        innerTx.campaign.count(),
      );
      expect(nestedSame).toBe(1);

      // Nested mismatched workspace throws CROSS_WORKSPACE_CONTEXT_VIOLATION
      await expect(
        appPrisma.withWorkspace(WS_B, async () => 'forbidden'),
      ).rejects.toThrow(/CROSS_WORKSPACE_CONTEXT_VIOLATION/);
    });

    // Cross-workspace INSERT inside WS_A fails RLS WITH CHECK (42501)
    await expect(
      appPrisma.withWorkspace(WS_A, (tx) =>
        tx.campaign.create({
          data: { workspaceId: WS_B, name: 'Cross Insert', objective: 'x', status: 'ACTIVE', createdBy: userId, updatedBy: userId },
        }),
      ),
    ).rejects.toThrow(/42501|row-level security/i);
  }, 60_000);

  it('runs SECURITY DEFINER auth, invitation, unsubscribe, worker, discovery run oracle, and ops paths against gain_saas_app', async () => {
    const config = {
      SESSION_SECRET: 's'.repeat(32),
      SESSION_TTL_MINUTES: 60,
      NODE_ENV: 'test',
      INVITE_CODE: undefined,
      OPS_EXPORT_HOURLY_LIMIT: 10,
    } as AppConfig;
    const audit = new AuditService(appPrisma);
    const sessions = new SessionService(config, appPrisma);
    const authService = new AuthService(config, appPrisma, sessions, audit);
    const authController = new AuthController(authService, sessions, appPrisma, {} as never);
    const workspacesController = new WorkspacesController(appPrisma, audit, sessions);

    // 1. Register creates user + workspace + membership + registry under FORCE RLS
    const reg = await authService.register({
      email: 'founder@rls-test.example',
      password: 'Password1234',
      companyName: 'RLS Test GmbH',
    });
    const ws1 = reg.workspace.id;

    // 2. Invite & acceptInvitation via SECURITY DEFINER RPC
    const inv = await authService.createInvitation(ws1, reg.user.id, {
      email: 'teammate@rls-test.example',
      role: 'member',
    });
    const accepted = await authService.acceptInvitation({
      token: inv.token,
      password: 'Password1234',
    });
    expect(accepted.membership.workspaceId).toBe(ws1);

    // 3. Login + session + workspaces.list
    const loginRes = await authService.login({
      email: 'founder@rls-test.example',
      password: 'Password1234',
    });
    expect(loginRes.membership.workspaceId).toBe(ws1);

    const tenantReq = {
      tenant: {
        userId: reg.user.id,
        workspaceId: ws1,
        role: 'admin',
        jti: loginRes.session.claims.jti,
        exp: loginRes.session.claims.exp,
        onboardingCompleted: false,
        onboardingCompanyId: null,
      },
    } as unknown as Request;
    const sessionData = await authController.session(tenantReq);
    expect(sessionData.data.workspaces.map((w) => w.id)).toContain(ws1);
    const listData = await workspacesController.list(tenantReq);
    expect(listData.data.map((w) => w.id)).toContain(ws1);

    // 4. OutreachUnsubscribeService issue + consume via app_lookup_unsubscribe_token
    const unsubscribe = new OutreachUnsubscribeService(appPrisma, audit);
    const contactRef = randomUUID();
    const { token } = await unsubscribe.issue(
      { userId: reg.user.id, workspaceId: ws1, role: 'admin' },
      contactRef,
      'buyer@target.example',
    );
    const consumed = await unsubscribe.consume(token);
    expect(consumed).toEqual({
      alreadyUsed: false,
      workspaceId: ws1,
      contactRef,
      recipientEmail: 'buyer@target.example',
    });

    // 5. OutreachSendJobsService claim + markDone via app_claim_outreach_send_jobs + withWorkspace
    const batchId = randomUUID();
    const draftId = randomUUID();
    await adminPrisma.outreachBatch.create({
      data: { id: batchId, workspaceId: ws1, name: 'B1', status: 'QUEUED', createdBy: reg.user.id },
    });
    await adminPrisma.outreachDraft.create({
      data: {
        id: draftId,
        workspaceId: ws1,
        batchId,
        contactRef,
        recipientEmail: 'buyer@target.example',
        subject: 'Hi',
        body: 'Hello',
        status: 'APPROVED',
      },
    });
    await adminPrisma.outreachSendJob.create({
      data: {
        workspaceId: ws1,
        batchId,
        draftId,
        state: 'PENDING',
        nextAttemptAt: new Date(Date.now() - 10_000),
        idempotencyKey: `key-${randomUUID()}`,
      },
    });
    const sendJobs = new OutreachSendJobsService(appPrisma);
    const claimed = await sendJobs.claim(10, new Date());
    expect(claimed.some((j) => j.workspaceId === ws1 && j.draftId === draftId)).toBe(true);
    const claimedForWs = claimed.filter((j) => j.workspaceId === ws1);
    await sendJobs.markDone(ws1, claimedForWs.map((j) => j.id));

    // 6. DiscoveryRunsController.record returns 404 NOT_FOUND on foreign runId under FORCE RLS
    const foreignRunId = randomUUID();
    const planId = randomUUID();
    const icpId = randomUUID();
    await adminPrisma.discoveryRunLink.create({
      data: { runId: foreignRunId, workspaceId: WS_B, planId, icpId },
    });
    const runsCtrl = new DiscoveryRunsController(appPrisma, audit);
    const runErr = await runsCtrl
      .record(tenantReq, { runId: foreignRunId, planId, icpId })
      .catch((e: unknown) => e);
    expect(runErr).toBeInstanceOf(NotFoundException);
    expect((runErr as NotFoundException).getResponse()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    // 7. OpsService.workspaces / users / storage-quota / detail / setWorkspaceStatus & OpsCampaignMetricsService
    const opsService = new OpsService(
      config,
      {} as never,
      {} as never,
      audit,
      appPrisma,
      new OpsExportThrottle(10),
    );
    const opsWorkspaces = await opsService.workspaces();
    expect(opsWorkspaces.some((w) => w.id === ws1)).toBe(true);
    const opsUsers = await opsService.users();
    expect(opsUsers.some((u) => u.email === 'founder@rls-test.example')).toBe(true);

    // workspace_storage_quota FORCE RLS cross-tenant isolation + OpsService write/detail path under gain_saas_app
    const savedQuota = await opsService.updateWorkspaceStorageQuota(
      ws1,
      {
        maxDocumentsPerWorkspace: 800,
        maxDocumentsPerCompany: 250,
        maxBytesPerWorkspace: '4294967296',
        maxExportsPerDay: 15,
      },
      'ops-1',
    );
    expect(savedQuota).toMatchObject({
      workspaceId: ws1,
      maxDocumentsPerWorkspace: 800,
      maxDocumentsPerCompany: 250,
      maxBytesPerWorkspace: '4294967296',
      maxExportsPerDay: 15,
      isDefault: false,
    });
    expect(await appPrisma.workspaceStorageQuota.findMany()).toEqual([]);
    const quotaSeenFromWsB = await appPrisma.withWorkspace(WS_B, (tx) =>
      tx.workspaceStorageQuota.findMany(),
    );
    expect(quotaSeenFromWsB).toEqual([]);
    const detail = await opsService.workspaceDetail(ws1);
    expect(detail.workspace).toMatchObject({ id: ws1, name: 'RLS Test GmbH', status: 'ACTIVE' });
    expect(detail.storageQuota).toMatchObject({
      workspaceId: ws1,
      maxDocumentsPerWorkspace: 800,
      maxBytesPerWorkspace: '4294967296',
      isDefault: false,
    });

    const opsMetrics = new OpsCampaignMetricsService(appPrisma, {
      db: { query: vi.fn(async () => ({ rows: [] })) },
    } as unknown as OpsDatabase);
    const allMetrics = await opsMetrics.campaignMetrics({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    });
    expect(allMetrics.workspaceId).toBeNull();

    // Disable ws1 -> login throws 403 WORKSPACE_DISABLED
    await opsService.setWorkspaceStatus(ws1, 'DISABLED', 'ops-1', 'suspended');
    const disabledLoginErr = await authService
      .login({ email: 'founder@rls-test.example', password: 'Password1234' })
      .catch((e: unknown) => e);
    expect(disabledLoginErr).toBeInstanceOf(ForbiddenException);
    expect((disabledLoginErr as ForbiddenException).getResponse()).toMatchObject({
      error: { code: 'WORKSPACE_DISABLED' },
    });
  }, 60_000);
});
