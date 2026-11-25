import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from '../ops/attribution-test-pg.js';
import { OpsExportThrottle } from '../ops/ops-export-throttle.js';
import { OpsController } from '../ops/ops.controller.js';
import { OpsService } from '../ops/ops.service.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditController } from '../tenant/audit.controller.js';
import { OutreachExperimentsService } from './outreach-experiments.service.js';
import { OutreachMailboxService } from './outreach-mailbox.service.js';

const available = dockerAvailable();
if (!available) {
  if (process.env.CI === 'true') {
    throw new Error('[outreach-child-workspace.pg] CI 需要 docker 运行真库迁移与隔离测试，但 docker 不可用');
  }
  console.warn('[outreach-child-workspace.pg] docker 不可用，跳过真库迁移与隔离测试');
}

describe.skipIf(!available)('PR 1 真库迁移、回填与 workspace_id 隔离（disposable PG16）', () => {
  let pg: DisposablePostgres;
  let prisma: PrismaClient;
  let appPrisma: PrismaService;

  const WS_1 = randomUUID();
  const WS_2 = randomUUID();

  beforeAll(async () => {
    pg = startDisposablePostgres();
    prisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
    appPrisma = new PrismaService({ datasourceUrl: pg.appDatabaseUrl, enforcePrincipal: true });
    await appPrisma.verifyPrincipal();
  }, 900_000);

  afterAll(async () => {
    await appPrisma?.onModuleDestroy().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
    pg?.stop();
  }, 120_000);

  it('fresh prisma migrate deploy creates expected columns, NOT NULL constraints, and indexes', async () => {
    const cols = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>
    >`
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'workspace_id'
        AND table_name IN (
          'audit_log',
          'outreach_experiment_assignment',
          'outreach_mailbox_counter',
          'outreach_domain_counter'
        )
      ORDER BY table_name
    `;

    expect(cols).toEqual([
      { table_name: 'audit_log', column_name: 'workspace_id', data_type: 'uuid', is_nullable: 'YES' },
      { table_name: 'outreach_domain_counter', column_name: 'workspace_id', data_type: 'uuid', is_nullable: 'NO' },
      { table_name: 'outreach_experiment_assignment', column_name: 'workspace_id', data_type: 'uuid', is_nullable: 'NO' },
      { table_name: 'outreach_mailbox_counter', column_name: 'workspace_id', data_type: 'uuid', is_nullable: 'NO' },
    ]);

    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'audit_log_realm_workspace_id_at_idx',
          'audit_log_workspace_id_at_idx',
          'outreach_experiment_assignment_workspace_id_experiment_id_idx',
          'outreach_mailbox_counter_workspace_id_mailbox_id_day_idx',
          'outreach_domain_counter_workspace_id_domain_id_hour_idx'
        )
      ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      'audit_log_realm_workspace_id_at_idx',
      'audit_log_workspace_id_at_idx',
      'outreach_domain_counter_workspace_id_domain_id_hour_idx',
      'outreach_experiment_assignment_workspace_id_experiment_id_idx',
      'outreach_mailbox_counter_workspace_id_mailbox_id_day_idx',
    ]);
  }, 60_000);

  it('AuditService + AuditController + OpsController.audit enforce workspace_id isolation against PG16', async () => {
    const auditService = new AuditService(appPrisma);
    await auditService.record({
      realm: 'tenant',
      actorId: 'u-1',
      workspaceId: WS_1,
      action: 'campaign.created',
      target: 'campaign/c-1',
    });
    await auditService.record({
      realm: 'tenant',
      actorId: 'u-2',
      workspaceId: WS_1,
      action: 'members.invite',
      target: 'inv-1',
    });
    await auditService.record({
      realm: 'tenant',
      actorId: 'u-1',
      workspaceId: WS_2,
      action: 'campaign.created',
      target: 'campaign/c-2',
    });
    await auditService.record({
      realm: 'tenant',
      actorId: 'u-1',
      action: 'auth.logout',
    });
    await auditService.record({
      realm: 'ops',
      actorId: 'ops-1',
      workspaceId: WS_1,
      action: 'workspace.status',
      target: 'Workspace 1',
    });
    await auditService.record({
      realm: 'ops',
      actorId: 'ops-1',
      action: 'ops.login',
      target: 'op@example.test',
    });

    const auditController = new AuditController(appPrisma);
    const tenantRes = await auditController.list({
      tenant: {
        userId: 'u-1',
        workspaceId: WS_1,
        role: 'admin',
        jti: 'j-1',
        exp: 0,
        onboardingCompleted: true,
        onboardingCompanyId: null,
      },
    } as unknown as Request);

    expect(tenantRes.data.total).toBe(2);
    expect(tenantRes.data.entries.map((entry) => entry.actorId).sort()).toEqual(['u-1', 'u-2']);

    const opsService = new OpsService(
      { OPS_EXPORT_HOURLY_LIMIT: 10 } as AppConfig,
      {} as never,
      {} as never,
      auditService,
      appPrisma,
      new OpsExportThrottle(10),
    );
    const opsController = new OpsController(opsService, {} as never, {} as never);

    const opsDefault = await opsController.audit('50');
    expect(opsDefault.entries.every((entry) => entry.realm === 'ops')).toBe(true);
    expect(opsDefault.entries.map((entry) => entry.action)).toContain('ops.login');

    const opsWs1 = await opsController.audit('50', WS_1);
    expect(opsWs1.entries).toHaveLength(3);
    expect(opsWs1.entries.every((entry) => entry.workspaceId === WS_1)).toBe(true);

    const opsWs1Tenant = await opsController.audit('50', WS_1, 'tenant');
    expect(opsWs1Tenant.entries).toHaveLength(2);
    expect(opsWs1Tenant.entries.every((entry) => entry.realm === 'tenant' && entry.workspaceId === WS_1)).toBe(true);
  }, 60_000);

  it('OutreachMailboxService & OutreachExperimentsService persist and isolate workspace_id end-to-end on PG16', async () => {
    const auditService = new AuditService(appPrisma);
    const mailboxService = new OutreachMailboxService(
      appPrisma,
      auditService,
      {
        OUTREACH_SMTP_FROM_ADDRESS: 'outreach@example.test',
        OUTREACH_MAILBOX_DAILY_CAP: 30,
        OUTREACH_MAILBOX_WEEKLY_CAP: 120,
      } as AppConfig,
    );
    const experimentsService = new OutreachExperimentsService(appPrisma, auditService);

    const mailbox1 = (await mailboxService.ensureDefaultMailbox(WS_1, 'sales1@ws1.example.test'))!;
    expect(mailbox1.workspaceId).toBe(WS_1);

    const now = new Date('2026-11-26T10:15:00Z');
    await mailboxService.recordSend(mailbox1, 'buyer@ziel.de', now);
    await mailboxService.recordHardBounce(WS_1, mailbox1.id, now);

    const usage1 = await mailboxService.usage(WS_1, mailbox1.id, now);
    expect(usage1).toEqual({ dailySent: 1, weeklySent: 1 });

    // Cross-workspace negative check on same mailboxId
    const usage2 = await mailboxService.usage(WS_2, mailbox1.id, now);
    expect(usage2).toEqual({ dailySent: 0, weeklySent: 0 });

    const mailboxCounter = await prisma.outreachMailboxCounter.findFirst({
      where: { mailboxId: mailbox1.id },
    });
    expect(mailboxCounter).toMatchObject({ workspaceId: WS_1, sent: 1, hardBounces: 1 });

    const domainCounter = await prisma.outreachDomainCounter.findFirst({
      where: { domainId: mailbox1.domainId },
    });
    expect(domainCounter).toMatchObject({ workspaceId: WS_1, recipientDomain: 'ziel.de', sent: 1 });

    const campaignId = randomUUID();
    await prisma.workspace.upsert({
      where: { id: WS_1 },
      update: {},
      create: { id: WS_1, name: 'WS 1' },
    });
    await prisma.campaign.create({
      data: {
        id: campaignId,
        workspaceId: WS_1,
        name: 'Holdout Campaign',
        objective: 'probe',
        status: 'ACTIVE',
        createdBy: 'u-1',
        updatedBy: 'u-1',
      },
    });
    const contactRef = randomUUID();
    const exp = await experimentsService.create(
      { userId: 'u-1', workspaceId: WS_1, role: 'admin' },
      {
        name: 'PG16 Holdout',
        hypothesis: 'Verify workspace_id persistence',
        primaryMetric: 'reply_rate',
        campaignId,
        holdoutRatio: 0.99,
      },
    );
    await experimentsService.start({ userId: 'u-1', workspaceId: WS_1, role: 'admin' }, exp.id);
    const assignments = await experimentsService.assign(
      { userId: 'u-1', workspaceId: WS_1, role: 'admin' },
      exp.id,
      { subjectType: 'contact', subjectRefs: [contactRef] },
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.workspaceId).toBe(WS_1);

    if (assignments[0]!.arm === 'holdout') {
      const held1 = await experimentsService.holdoutContacts(
        { userId: 'u-1', workspaceId: WS_1, role: 'admin' },
        campaignId,
        [contactRef],
      );
      expect(held1).toEqual(new Set([contactRef]));
    }
    const held2 = await experimentsService.holdoutContacts(
      { userId: 'u-2', workspaceId: WS_2, role: 'admin' },
      campaignId,
      [contactRef],
    );
    expect(held2).toEqual(new Set());
  }, 60_000);

  it('backfills pre-existing rows accurately when applying 20261126010000 and 20261126020000 migrations', async () => {
    const adminClient = new Client({ connectionString: pg.databaseUrl });
    await adminClient.connect();
    try {
      await adminClient.query('CREATE DATABASE backfill_probe');
    } finally {
      await adminClient.end();
    }

    const baseUrl = pg.databaseUrl.slice(0, pg.databaseUrl.lastIndexOf('/'));
    const probeClient = new Client({ connectionString: `${baseUrl}/backfill_probe` });
    await probeClient.connect();
    try {
      const migrationsDir = join(process.cwd(), 'prisma/migrations');
      const migrationDirs = readdirSync(migrationsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

      const preDirs = migrationDirs.filter(
        (name) =>
          name !== '20261126010000_audit_log_workspace_id' &&
          name !== '20261126020000_outreach_child_workspace_id' &&
          name !== '20261126030000_gain_saas_rls_and_app_role',
      );
      for (const dir of preDirs) {
        const sql = readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8');
        await probeClient.query(sql);
      }

      // Seed pre-migration outreach hierarchy + child rows (without workspace_id column yet)
      const domain1 = randomUUID();
      const domain2 = randomUUID();
      const mailbox1 = randomUUID();
      const mailbox2 = randomUUID();
      const exp1 = randomUUID();
      const assignment1 = randomUUID();
      const subject1 = randomUUID();

      await probeClient.query(
        `INSERT INTO outreach_domain (id, workspace_id, domain) VALUES ($1, $2, 'd1.test'), ($3, $4, 'd2.test')`,
        [domain1, WS_1, domain2, WS_2],
      );
      await probeClient.query(
        `INSERT INTO outreach_mailbox (id, workspace_id, domain_id, address, display_name)
         VALUES ($1, $2, $3, 'a@d1.test', 'A'), ($4, $5, $6, 'b@d2.test', 'B')`,
        [mailbox1, WS_1, domain1, mailbox2, WS_2, domain2],
      );
      await probeClient.query(
        `INSERT INTO outreach_mailbox_counter (mailbox_id, day, sent)
         VALUES ($1, '2026-11-25', 4), ($2, '2026-11-25', 9)`,
        [mailbox1, mailbox2],
      );
      await probeClient.query(
        `INSERT INTO outreach_domain_counter (domain_id, hour, recipient_domain, sent)
         VALUES ($1, '2026-11-25T10:00:00Z', 'ziel.de', 3), ($2, '2026-11-25T10:00:00Z', 'acme.de', 7)`,
        [domain1, domain2],
      );
      await probeClient.query(
        `INSERT INTO outreach_experiment (id, workspace_id, name, hypothesis, primary_metric, assignment_salt, created_by)
         VALUES ($1, $2, 'Legacy Exp', 'h', 'm', $3, 'u-1')`,
        [exp1, WS_1, 'a'.repeat(64)],
      );
      await probeClient.query(
        `INSERT INTO outreach_experiment_assignment (id, experiment_id, subject_type, subject_ref, arm, bucket)
         VALUES ($1, $2, 'contact', $3, 'holdout', 10)`,
        [assignment1, exp1, subject1],
      );

      // Seed pre-migration audit_log rows (backfillable + ambiguous + invalid UUID)
      const invTarget = randomUUID();
      await probeClient.query(
        `INSERT INTO audit_log (id, realm, actor_id, action, target, detail) VALUES
         ($1, 'tenant', 'u-1', 'outreach.t0.touch', $2, $3::jsonb),
         ($4, 'tenant', 'u-1', 'auth.login', $5, NULL),
         ($6, 'ops', 'ops-1', 'workspace.status', 'Acme', $7::jsonb),
         ($8, 'ops', 'ops-1', 'export.leads', $9, $10::jsonb),
         ($11, 'tenant', 'u-1', 'members.invite', $12, '{"email":"a@b.c"}'::jsonb),
         ($13, 'tenant', 'u-1', 'bff.request', '/api/x', '{"workspaceId":"not-a-uuid"}'::jsonb),
         ($14, 'ops', 'ops-1', 'ops.login', 'op@example.test', NULL)`,
        [
          '00000000-0000-4000-8000-000000000001',
          randomUUID(),
          JSON.stringify({ workspaceId: WS_1, channel: 'mailto' }),
          '00000000-0000-4000-8000-000000000002',
          WS_2,
          '00000000-0000-4000-8000-000000000003',
          JSON.stringify({ before: { id: WS_1 }, after: { id: WS_1, status: 'DISABLED' } }),
          '00000000-0000-4000-8000-000000000004',
          WS_2,
          JSON.stringify({ rows: 5 }),
          '00000000-0000-4000-8000-000000000005',
          invTarget,
          '00000000-0000-4000-8000-000000000006',
          '00000000-0000-4000-8000-000000000007',
        ],
      );

      // Apply the two new migrations in sequence
      await probeClient.query(
        readFileSync(join(migrationsDir, '20261126010000_audit_log_workspace_id/migration.sql'), 'utf8'),
      );
      await probeClient.query(
        readFileSync(join(migrationsDir, '20261126020000_outreach_child_workspace_id/migration.sql'), 'utf8'),
      );

      const auditRows = await probeClient.query<{ id: string; workspace_id: string | null }>(
        `SELECT id::text, workspace_id::text FROM audit_log ORDER BY id`,
      );
      expect(auditRows.rows).toEqual([
        { id: '00000000-0000-4000-8000-000000000001', workspace_id: WS_1 },
        { id: '00000000-0000-4000-8000-000000000002', workspace_id: WS_2 },
        { id: '00000000-0000-4000-8000-000000000003', workspace_id: WS_1 },
        { id: '00000000-0000-4000-8000-000000000004', workspace_id: WS_2 },
        { id: '00000000-0000-4000-8000-000000000005', workspace_id: null },
        { id: '00000000-0000-4000-8000-000000000006', workspace_id: null },
        { id: '00000000-0000-4000-8000-000000000007', workspace_id: null },
      ]);

      const mbCounters = await probeClient.query<{ mailbox_id: string; workspace_id: string }>(
        `SELECT mailbox_id::text, workspace_id::text FROM outreach_mailbox_counter ORDER BY sent`,
      );
      expect(mbCounters.rows).toEqual([
        { mailbox_id: mailbox1, workspace_id: WS_1 },
        { mailbox_id: mailbox2, workspace_id: WS_2 },
      ]);

      const domCounters = await probeClient.query<{ domain_id: string; workspace_id: string }>(
        `SELECT domain_id::text, workspace_id::text FROM outreach_domain_counter ORDER BY sent`,
      );
      expect(domCounters.rows).toEqual([
        { domain_id: domain1, workspace_id: WS_1 },
        { domain_id: domain2, workspace_id: WS_2 },
      ]);

      const expAssigns = await probeClient.query<{ id: string; workspace_id: string }>(
        `SELECT id::text, workspace_id::text FROM outreach_experiment_assignment`,
      );
      expect(expAssigns.rows).toEqual([{ id: assignment1, workspace_id: WS_1 }]);

      // Verify NOT NULL constraint is enforced on outreach child tables
      await expect(
        probeClient.query(
          `INSERT INTO outreach_mailbox_counter (mailbox_id, day, sent) VALUES ($1, '2026-11-26', 1)`,
          [mailbox1],
        ),
      ).rejects.toThrow(/null value in column "workspace_id"/i);
    } finally {
      await probeClient.end();
    }
  }, 120_000);
});
