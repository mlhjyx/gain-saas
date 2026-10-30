import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { csvFilename, toCsv, type CsvColumn } from './ops-csv.js';
import { OpsDatabase } from './ops-database.service.js';
import { OpsTemporalService, SCHEDULE_WORKFLOW_WHITELIST } from './ops-temporal.service.js';

type Row = Record<string, unknown>;

const PROVIDER_STATUSES = new Set(['ENABLED', 'DISABLED']);
const SOURCE_STATUSES = new Set(['ACTIVE', 'PAUSED', 'ARCHIVED']);

const sourceCadence = z.union([
  z.object({ kind: z.literal('fixed'), everyMs: z.number().int().positive() }),
  z.object({ kind: z.literal('adaptive'), state: z.record(z.string(), z.unknown()).optional() }),
]);

const createSourceSchema = z.object({
  providerKey: z.string().trim().min(1).max(100),
  sourceKey: z.string().trim().regex(/^[a-z0-9][a-z0-9_.:-]*$/i, 'source_key 只允许字母数字与 _ . : -').max(200),
  label: z.string().trim().min(1).max(300),
  config: z.record(z.string(), z.unknown()).default({}),
  sectorTags: z.array(z.string().max(80)).max(20).optional(),
  region: z.string().trim().max(120).optional(),
  seriesKey: z.string().trim().max(160).optional(),
  cadence: sourceCadence.optional(),
  nextFetchAt: z.string().trim().min(1).optional(),
});

const updateSourceSchema = z
  .object({
    label: z.string().trim().min(1).max(300).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    sectorTags: z.array(z.string().max(80)).max(20).nullable().optional(),
    region: z.string().trim().max(120).nullable().optional(),
    seriesKey: z.string().trim().max(160).nullable().optional(),
    cadence: sourceCadence.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有可更新字段' });

function validationError(error: z.ZodError): BadRequestException {
  return new BadRequestException({
    error: { code: 'VALIDATION', message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') },
  });
}

const SOURCE_EXPORT_COLUMNS: CsvColumn[] = [
  { key: 'source_key', label: '源Key' },
  { key: 'label', label: '名称' },
  { key: 'provider_key', label: 'Provider' },
  { key: 'status', label: '状态' },
  { key: 'cadence', label: '节奏' },
  { key: 'region', label: '地区' },
  { key: 'last_fetch_at', label: '上次抓取' },
  { key: 'next_fetch_at', label: '下次抓取' },
  { key: 'fetch_count', label: '抓取次数' },
  { key: 'entity_count', label: '实体数' },
  { key: 'created_at', label: '创建时间' },
];

const FETCH_EXPORT_COLUMNS: CsvColumn[] = [
  { key: 'started_at', label: '开始' },
  { key: 'finished_at', label: '结束' },
  { key: 'source_key', label: '源' },
  { key: 'status', label: '状态' },
  { key: 'total', label: '总数' },
  { key: 'added', label: '新增' },
  { key: 'updated', label: '更新' },
  { key: 'removed', label: '移除' },
  { key: 'cost_cents', label: '成本分' },
  { key: 'error', label: '错误' },
];

const ENTITY_EXPORT_COLUMNS: CsvColumn[] = [
  { key: 'source_key', label: '源' },
  { key: 'external_id', label: '外部ID' },
  { key: 'name', label: '名称' },
  { key: 'domain', label: '域名' },
  { key: 'country', label: '国家' },
  { key: 'entity_kind', label: '类型' },
  { key: 'first_seen_at', label: '首次出现' },
  { key: 'last_seen_at', label: '最近出现' },
  { key: 'withdrawn_at', label: '退出时间' },
];

const LEAD_EXPORT_COLUMNS: CsvColumn[] = [
  { key: 'created_at', label: '创建' },
  { key: 'company_name', label: '公司' },
  { key: 'domain', label: '域名' },
  { key: 'country', label: '国家' },
  { key: 'queue', label: '队列' },
  { key: 'fit_verdict', label: 'Fit' },
  { key: 'total_score', label: '总分' },
  { key: 'scored_at', label: '评分时间' },
  { key: 'status', label: '状态' },
];

@Injectable()
export class OpsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: OpsDatabase,
    private readonly temporal: OpsTemporalService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  private async safe<T extends Row>(query: () => Promise<T[]>, fallback: T[] = []): Promise<T[]> {
    try { return await query(); } catch { return fallback; }
  }

  async probe() {
    return { data: await this.database.ready() };
  }

  async overview() {
    const db = this.database.db;
    const [health, probe, engine, temporalReachable] = await Promise.all([
      db.health(),
      this.database.ready(),
      this.engineReadiness(),
      this.temporal.health(),
    ]);
    const [providersByStatus, sourcesByStatus, dueSources, fetchStats24h, failedFetches, sanctions, leases, exhaustedBudgets] =
      await Promise.all([
        this.safe(() => db.query(`SELECT status, count(*)::text n FROM data_provider GROUP BY status`)),
        this.safe(() => db.query(`SELECT status, count(*)::text n FROM monitored_source GROUP BY status`)),
        this.safe(() => db.query(`SELECT count(*)::text n FROM monitored_source WHERE status = 'ACTIVE' AND next_fetch_at IS NOT NULL AND next_fetch_at <= now()`)),
        this.safe(() => db.query(`SELECT status, count(*)::text n FROM source_fetch WHERE started_at > now() - interval '24 hours' GROUP BY status`)),
        this.safe(() => db.query(
          `SELECT f.id::text, s.source_key, s.label, left(f.error, 300) AS error, f.started_at
           FROM source_fetch f JOIN monitored_source s ON s.id = f.source_id
           WHERE f.status = 'FAILED' ORDER BY f.started_at DESC LIMIT 10`,
        )),
        this.safe(() => db.query(`SELECT key, label, status, last_refreshed_at, last_fetch_status, record_count FROM sanctions_source ORDER BY key`)),
        this.safe(() => db.query(
          `SELECT DISTINCT ON (role) role, state, last_seen_at FROM runtime_process_lease ORDER BY role, last_seen_at DESC`,
        )),
        this.safe(() => db.query(`SELECT count(*)::text n FROM tool_budget_account WHERE exhausted = true`), [{ n: '-1' }]),
      ]);
    const deadDeliveries = db.ownerPool
      ? await this.safe(() => db.ownerQuery(`SELECT count(*)::text n FROM outbox_delivery WHERE status = 'DEAD'`), [{ n: '-1' }])
      : [{ n: '-1' }];
    return {
      engine,
      db: health,
      probe,
      providersByStatus,
      sourcesByStatus,
      dueSources: Number(dueSources[0]?.n ?? 0),
      fetchStats24h,
      failedFetches,
      sanctions,
      leases,
      redLights: {
        deadDeliveries: Number(deadDeliveries[0]?.n ?? -1),
        exhaustedBudgetAccounts: Number(exhaustedBudgets[0]?.n ?? -1),
        temporal: { reachable: temporalReachable },
      },
    };
  }

  private async engineReadiness(): Promise<Record<string, unknown>> {
    try {
      const res = await fetch(`${this.config.ENGINE_ORIGIN}/api/v1/health/ready`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json().catch(() => ({}))) as { status?: string; components?: Record<string, { status?: string }> };
      const failedComponents = Object.entries(body.components ?? {})
        .filter(([, value]) => value.status && value.status !== 'ok')
        .map(([name, value]) => ({ name, status: value.status }));
      return { reachable: true, httpStatus: res.status, ready: res.status === 200, failedComponents };
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async providers(): Promise<Row[]> {
    return this.database.db.query(
      `SELECT id::text, key, class, status, cost_per_call_cents, config, created_at FROM data_provider ORDER BY key`,
    );
  }

  async setProviderStatus(key: string, status: string, actorId: string): Promise<Row> {
    if (!PROVIDER_STATUSES.has(status)) throw new BadRequestException({ error: { code: 'VALIDATION', message: 'status 需要 ENABLED|DISABLED' } });
    const db = await this.database.writable();
    const before = await db.query(`SELECT key, status FROM data_provider WHERE key = $1`, [key]);
    if (before.length === 0) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: `provider ${key} 不存在` } });
    const after = await db.ownerQuery(
      `UPDATE data_provider SET status = $2 WHERE key = $1 RETURNING key, status`,
      [key, status],
    );
    await this.audit.record({ realm: 'ops', actorId, action: 'provider.status', target: key, detail: { before: before[0], after: after[0] } });
    return {
      provider: after[0],
      note: '运行时 Kill Switch 已翻转;机器真值仍在引擎仓 docs/governance/provider-registry.json,此处不回写该文件。',
    };
  }

  async sources(query: { status?: string; q?: string; limit?: number }): Promise<Row[]> {
    const limit = Math.min(query.limit ?? 100, 500);
    return this.database.db.query(
      `SELECT s.id::text, s.provider_key, s.source_key, s.label, s.region, s.series_key, s.status,
              s.cadence, s.sector_tags, s.last_fetch_at, s.next_fetch_at, s.created_at,
              (SELECT count(*)::text FROM source_fetch f WHERE f.source_id = s.id) AS fetch_count,
              (SELECT count(*)::text FROM source_entity e WHERE e.source_id = s.id AND e.withdrawn_at IS NULL) AS entity_count,
              (SELECT f.status FROM source_fetch f WHERE f.source_id = s.id ORDER BY f.started_at DESC LIMIT 1) AS last_fetch_status
       FROM monitored_source s
       WHERE ($1::text IS NULL OR s.status = $1)
         AND ($2::text IS NULL OR s.source_key ILIKE '%' || $2 || '%' OR s.label ILIKE '%' || $2 || '%')
       ORDER BY s.created_at DESC LIMIT $3`,
      [query.status ?? null, query.q ?? null, limit],
    );
  }

  async source(id: string): Promise<{ source: Row; recentFetches: Row[] }> {
    const db = this.database.db;
    const rows = await db.query(
      `SELECT s.id::text, s.provider_key, s.source_key, s.label, s.config, s.sector_tags, s.region, s.series_key,
              s.status, s.cadence, s.last_fetch_at, s.next_fetch_at, s.created_at, s.updated_at,
              (SELECT count(*)::text FROM source_fetch f WHERE f.source_id = s.id) AS fetch_count,
              (SELECT count(*)::text FROM source_fetch f WHERE f.source_id = s.id AND f.status = 'FAILED') AS failed_fetch_count,
              (SELECT count(*)::text FROM source_entity e WHERE e.source_id = s.id AND e.withdrawn_at IS NULL) AS entity_count
       FROM monitored_source s WHERE s.id = $1`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '源不存在' } });
    const fetches = await db.query(
      `SELECT id::text, status, total, added, updated, removed, unchanged, cost_cents, parser_version,
              left(error, 500) AS error, started_at, finished_at
       FROM source_fetch WHERE source_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [id],
    );
    return { source: rows[0], recentFetches: fetches };
  }

  async acquireNow(id: string, actorId: string): Promise<Row> {
    const db = await this.database.writable();
    const before = await db.query(`SELECT id::text, source_key, status, next_fetch_at FROM monitored_source WHERE id = $1`, [id]);
    if (before.length === 0) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '源不存在' } });
    if (before[0].status !== 'ACTIVE') {
      throw new ConflictException({ error: { code: 'NOT_ACTIVE', message: `源状态为 ${String(before[0].status)},sweep 只调度 ACTIVE 源` } });
    }
    const rows = await db.query(
      `UPDATE monitored_source SET next_fetch_at = now(), updated_at = now() WHERE id = $1
       RETURNING id::text, source_key, status, next_fetch_at`,
      [id],
    );
    await this.audit.record({ realm: 'ops', actorId, action: 'source.acquire-now', target: String(before[0].source_key), detail: { before: before[0], after: rows[0] } });
    return { source: rows[0], note: '已置为立即到期;实际抓取由 ACQ_SWEEP 调度执行。' };
  }

  async setSourceStatus(id: string, status: string, actorId: string): Promise<Row> {
    if (!SOURCE_STATUSES.has(status)) throw new BadRequestException({ error: { code: 'VALIDATION', message: 'status 需要 ACTIVE|PAUSED|ARCHIVED' } });
    const db = await this.database.writable();
    const before = await db.query(`SELECT id::text, source_key, status FROM monitored_source WHERE id = $1`, [id]);
    if (before.length === 0) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '源不存在' } });
    const rows = await db.query(
      `UPDATE monitored_source SET status = $2, updated_at = now() WHERE id = $1 RETURNING id::text, source_key, status`,
      [id, status],
    );
    await this.audit.record({ realm: 'ops', actorId, action: 'source.status', target: String(before[0].source_key), detail: { before: before[0], after: rows[0] } });
    return { source: rows[0] };
  }

  async deleteSource(id: string, actorId: string): Promise<Row> {
    const db = await this.database.writable();
    const before = await db.query(`SELECT id::text, source_key, status FROM monitored_source WHERE id = $1`, [id]);
    if (before.length === 0) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '源不存在' } });
    const used = await db.query(
      `SELECT (SELECT count(*) FROM source_fetch WHERE source_id = $1) + (SELECT count(*) FROM source_entity WHERE source_id = $1) AS n`,
      [id],
    );
    if (Number(used[0]?.n ?? 0) > 0) {
      throw new ConflictException({ error: { code: 'HAS_DATA', message: '该源已有抓取/实体数据,不能删除;请改用 ARCHIVED' } });
    }
    if (!db.ownerPool) throw new BadRequestException({ error: { code: 'OWNER_REQUIRED', message: '删除需要 OWNER_DATABASE_URL' } });
    const rows = await db.ownerQuery<{ source_key: string }>(`DELETE FROM monitored_source WHERE id = $1 RETURNING source_key`, [id]);
    await this.audit.record({ realm: 'ops', actorId, action: 'source.delete', target: String(rows[0]?.source_key ?? id), detail: { before: before[0] } });
    return { deleted: rows[0]?.source_key };
  }

  async createSource(input: unknown, actorId: string): Promise<Row> {
    const parsed = createSourceSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const b = parsed.data;
    if (b.nextFetchAt && Number.isNaN(Date.parse(b.nextFetchAt))) {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: 'nextFetchAt 需要 ISO 时间' } });
    }
    const db = await this.database.writable();
    const dup = await db.query(`SELECT source_key FROM monitored_source WHERE source_key = $1`, [b.sourceKey]);
    if (dup.length > 0) throw new ConflictException({ error: { code: 'DUPLICATE', message: `source_key 已存在:${b.sourceKey}` } });
    const id = randomUUID();
    const rows = await db.query(
      `INSERT INTO monitored_source
         (id, provider_key, source_key, label, config, sector_tags, region, series_key, status, cadence, next_fetch_at, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 'ACTIVE', $9::jsonb, $10, now(), now())
       RETURNING id::text, provider_key, source_key, label, config, sector_tags, region, series_key, status, cadence, next_fetch_at, created_at, updated_at`,
      [
        id,
        b.providerKey,
        b.sourceKey,
        b.label,
        JSON.stringify(b.config ?? {}),
        b.sectorTags && b.sectorTags.length > 0 ? JSON.stringify(b.sectorTags) : null,
        b.region ?? null,
        b.seriesKey ?? null,
        b.cadence ? JSON.stringify(b.cadence) : null,
        b.nextFetchAt ? new Date(b.nextFetchAt).toISOString() : null,
      ],
    );
    await this.audit.record({
      realm: 'ops',
      actorId,
      action: 'source.create',
      target: b.sourceKey,
      detail: { after: rows[0] },
    });
    return { source: rows[0] };
  }

  async updateSource(id: string, input: unknown, actorId: string): Promise<Row> {
    const parsed = updateSourceSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const db = await this.database.writable();
    const before = await db.query(
      `SELECT id::text, source_key, label, config, sector_tags, region, series_key, cadence FROM monitored_source WHERE id = $1`,
      [id],
    );
    if (before.length === 0) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '源不存在' } });
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    const b = parsed.data;
    if (b.label !== undefined) add('label', b.label);
    if (b.config !== undefined) add('config', JSON.stringify(b.config), '::jsonb');
    if (b.sectorTags !== undefined) add('sector_tags', b.sectorTags === null ? null : JSON.stringify(b.sectorTags), '::jsonb');
    if (b.region !== undefined) add('region', b.region);
    if (b.seriesKey !== undefined) add('series_key', b.seriesKey);
    if (b.cadence !== undefined) add('cadence', b.cadence === null ? null : JSON.stringify(b.cadence), '::jsonb');
    sets.push('updated_at = now()');
    params.push(id);
    const rows = await db.query(
      `UPDATE monitored_source SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id::text, provider_key, source_key, label, config, sector_tags, region, series_key, status, cadence, next_fetch_at, created_at, updated_at`,
      params,
    );
    await this.audit.record({
      realm: 'ops',
      actorId,
      action: 'source.update',
      target: String(before[0].source_key),
      detail: { before: before[0], after: rows[0] },
    });
    return { source: rows[0] };
  }

  async budget(): Promise<Row> {
    const db = this.database.db;
    const accountSql = `SELECT id::text, account_key, scope_key, generation, cap_cents, reserved_cents, charged_cents,
              reserved_microusd, charged_microusd, exhausted, ref_count, closed_at, created_at, updated_at
       FROM tool_budget_account ORDER BY updated_at DESC LIMIT 100`;
    const accounts = db.ownerPool
      ? await this.safe(() => db.ownerQuery(accountSql))
      : await this.safe(() => db.query(accountSql));
    const authorities = db.ownerPool
      ? await this.safe(() => db.ownerQuery(
        `SELECT id::text, workspace_id::text, jti, purpose, authority_kind, scope_key,
                cap_microusd, cap_per_run_microusd, campaign_cap_microusd, max_runs, runs_consumed,
                issued_at, not_before, expires_at, consumed_at, revoked_at, admission_lease_expires_at, workflow_id, schedule_id
         FROM execution_budget_authority ORDER BY issued_at DESC LIMIT 100`,
      ))
      : [];
    return { accounts, authorities };
  }

  async workspaces(): Promise<Row[]> {
    const db = this.database.db;
    const sql = `SELECT id::text, name, created_at FROM workspace ORDER BY created_at`;
    return db.ownerPool ? db.ownerQuery(sql) : db.query(sql);
  }

  /** 平台运营查看 SaaS 注册用户（SaaS 自有库，不是引擎 workspace 影子行）。 */
  async users(query?: string): Promise<Row[]> {
    const q = query?.trim();
    const rows = await this.prisma.user.findMany({
      where: q ? { email: { contains: q, mode: 'insensitive' } } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        memberships: {
          where: { status: 'active' },
          include: { workspace: { select: { id: true, name: true } } },
        },
      },
    });
    const ids = rows.map((row) => row.id);
    const sessions = ids.length
      ? await this.prisma.session.findMany({
          where: { realm: 'tenant', subjectType: 'user', subjectId: { in: ids }, revokedAt: null, expiresAt: { gt: new Date() } },
          select: { subjectId: true, createdAt: true },
        })
      : [];
    const sessionMap = new Map<string, { count: number; lastSeenAt: Date | null }>();
    for (const session of sessions) {
      const current = sessionMap.get(session.subjectId) ?? { count: 0, lastSeenAt: null };
      current.count += 1;
      if (!current.lastSeenAt || session.createdAt > current.lastSeenAt) current.lastSeenAt = session.createdAt;
      sessionMap.set(session.subjectId, current);
    }
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      workspaces: row.memberships.map((membership) => ({
        id: membership.workspace.id,
        name: membership.workspace.name,
        role: membership.role,
      })),
      activeSessions: sessionMap.get(row.id)?.count ?? 0,
      lastSeenAt: sessionMap.get(row.id)?.lastSeenAt?.toISOString() ?? null,
    }));
  }

  async setUserStatus(userId: string, status: string, actorId: string): Promise<Row> {
    if (status !== 'active' && status !== 'disabled') {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: 'status 只能是 active 或 disabled' } });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'user not found' } });
    const updated = await this.prisma.user.update({ where: { id: userId }, data: { status } });
    if (status === 'disabled') {
      await this.prisma.session.updateMany({
        where: { realm: 'tenant', subjectType: 'user', subjectId: userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await this.audit.record({
      realm: 'ops',
      actorId,
      action: 'ops.user.status',
      target: userId,
      detail: { status, email: user.email },
    });
    return { id: updated.id, email: updated.email, status: updated.status };
  }

  async runs(workspaceId: string): Promise<Row[]> {
    return this.database.db.withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query(
        `SELECT id::text, plan_id::text, icp_id::text, status, stats, created_at, completed_at
         FROM discovery_run ORDER BY created_at DESC LIMIT 50`,
      );
      return rows;
    });
  }

  async leads(workspaceId: string): Promise<Row[]> {
    return this.database.db.withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query(
        `SELECT l.id::text, l.status, l.queue, l.fit_verdict, l.total_score, l.scored_at, l.created_at,
                c.name AS company_name, c.domain AS company_domain, c.country AS company_country
         FROM lead l JOIN canonical_company c ON c.id = l.canonical_company_id
         ORDER BY l.created_at DESC LIMIT 100`,
      );
      return rows;
    });
  }

  async outbox(workspaceId: string): Promise<Row[]> {
    return this.database.db.withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query(
        `SELECT id::text, event_id::text, event_type, occurred_at, published_at, parked_at
         FROM outbox_event ORDER BY occurred_at DESC LIMIT 100`,
      );
      return rows;
    });
  }

  async fetches(query: { status?: string; limit?: number }): Promise<Row[]> {
    const limit = Math.min(query.limit ?? 50, 200);
    return this.database.db.query(
      `SELECT f.id::text, f.source_id::text, s.source_key, s.label AS source_label, f.status,
              f.total, f.added, f.updated, f.removed, f.unchanged, f.cost_cents,
              left(f.error, 500) AS error, f.started_at, f.finished_at
       FROM source_fetch f JOIN monitored_source s ON s.id = f.source_id
       WHERE ($1::text IS NULL OR f.status = $1)
       ORDER BY f.started_at DESC LIMIT $2`,
      [query.status ?? null, limit],
    );
  }

  async changes(query: { type?: string; limit?: number }): Promise<Row[]> {
    const limit = Math.min(query.limit ?? 50, 200);
    return this.database.db.query(
      `SELECT c.id::text, s.source_key, c.external_id, c.change_type, c.detail, c.created_at,
              (SELECT e.name FROM source_entity e WHERE e.source_id = c.source_id AND e.external_id = c.external_id) AS entity_name
       FROM source_entity_change c JOIN monitored_source s ON s.id = c.source_id
       WHERE ($1::text IS NULL OR c.change_type = $1)
       ORDER BY c.created_at DESC LIMIT $2`,
      [query.type ?? null, limit],
    );
  }

  async traces(workspaceId: string, query: { status?: string; limit?: number }): Promise<Row[]> {
    const limit = Math.min(query.limit ?? 100, 500);
    return this.database.db.withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query(
        `SELECT id::text, task, op, provider, model, status, left(error_message, 500) AS error_message,
                latency_ms, input_tokens, output_tokens, cost_usd, created_at
         FROM ai_trace
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at DESC LIMIT $2`,
        [query.status ?? null, limit],
      );
      return rows;
    });
  }

  async exportSources(status?: string): Promise<{ csv: string; filename: string }> {
    const rows = await this.database.db.query(
      `SELECT s.source_key, s.label, s.provider_key, s.status, s.cadence, s.region, s.series_key,
              s.last_fetch_at, s.next_fetch_at, s.created_at,
              (SELECT count(*) FROM source_fetch f WHERE f.source_id = s.id) AS fetch_count,
              (SELECT count(*) FROM source_entity e WHERE e.source_id = s.id AND e.withdrawn_at IS NULL) AS entity_count
       FROM monitored_source s
       WHERE ($1::text IS NULL OR s.status = $1)
       ORDER BY s.created_at DESC LIMIT 5000`,
      [status ?? null],
    );
    return { csv: toCsv(rows, SOURCE_EXPORT_COLUMNS), filename: csvFilename('sources') };
  }

  async exportFetches(status?: string): Promise<{ csv: string; filename: string }> {
    const rows = await this.database.db.query(
      `SELECT f.started_at, f.finished_at, s.source_key, f.status, f.total, f.added, f.updated,
              f.removed, f.unchanged, f.cost_cents, f.error
       FROM source_fetch f JOIN monitored_source s ON s.id = f.source_id
       WHERE ($1::text IS NULL OR f.status = $1)
       ORDER BY f.started_at DESC LIMIT 5000`,
      [status ?? null],
    );
    return { csv: toCsv(rows, FETCH_EXPORT_COLUMNS), filename: csvFilename('fetches') };
  }

  async exportEntities(sourceId?: string, search?: string): Promise<{ csv: string; filename: string }> {
    if (sourceId && !/^[0-9a-f-]{36}$/i.test(sourceId)) {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: 'sourceId 需要 UUID' } });
    }
    const rows = await this.database.db.query(
      `SELECT s.source_key, e.external_id, e.name, e.domain, e.country, e.entity_kind,
              e.first_seen_at, e.last_seen_at, e.withdrawn_at
       FROM source_entity e JOIN monitored_source s ON s.id = e.source_id
       WHERE ($1::uuid IS NULL OR e.source_id = $1)
         AND ($2::text IS NULL OR e.name ILIKE '%' || $2 || '%' OR e.domain ILIKE '%' || $2 || '%')
       ORDER BY e.last_seen_at DESC LIMIT 5000`,
      [sourceId ?? null, search ?? null],
    );
    return { csv: toCsv(rows, ENTITY_EXPORT_COLUMNS), filename: csvFilename('entities') };
  }

  async exportLeads(workspaceId: string | undefined, queue?: string): Promise<{ csv: string; filename: string }> {
    if (!workspaceId) {
      throw new BadRequestException({ error: { code: 'WORKSPACE_REQUIRED', message: 'lead 是租户表(RLS),必须带 ?workspaceId=' } });
    }
    const rows = await this.database.db.withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query(
        `SELECT l.created_at, c.name AS company_name, c.domain, c.country, l.queue, l.fit_verdict,
                l.total_score, l.scored_at, l.status
         FROM lead l JOIN canonical_company c ON c.id = l.canonical_company_id
         WHERE ($1::text IS NULL OR l.queue = $1)
         ORDER BY l.created_at DESC LIMIT 5000`,
        [queue ?? null],
      );
      return rows;
    });
    return { csv: toCsv(rows, LEAD_EXPORT_COLUMNS), filename: csvFilename('leads') };
  }

  async schedules() {
    try {
      return { schedules: await this.temporal.listSchedules(), workflowWhitelist: SCHEDULE_WORKFLOW_WHITELIST };
    } catch (error) {
      throw new ServiceUnavailableException({
        error: { code: 'TEMPORAL_UNAVAILABLE', message: `Temporal 不可达:${error instanceof Error ? error.message : String(error)}` },
      });
    }
  }

  async pauseSchedule(id: string, note: string | undefined, actorId: string): Promise<Row> {
    await this.temporal.pause(id, note);
    await this.audit.record({ realm: 'ops', actorId, action: 'schedule.pause', target: id, detail: { note } });
    return { paused: id };
  }

  async unpauseSchedule(id: string, actorId: string): Promise<Row> {
    await this.temporal.unpause(id);
    await this.audit.record({ realm: 'ops', actorId, action: 'schedule.unpause', target: id });
    return { unpaused: id };
  }

  async triggerSchedule(id: string, actorId: string): Promise<Row> {
    await this.temporal.trigger(id);
    await this.audit.record({ realm: 'ops', actorId, action: 'schedule.trigger', target: id });
    return { triggered: id, note: '已触发一次立即执行(overlap=SKIP 时上一轮仍在跑会被跳过)' };
  }

  async deleteSchedule(id: string, actorId: string): Promise<Row> {
    await this.temporal.remove(id);
    await this.audit.record({ realm: 'ops', actorId, action: 'schedule.delete', target: id });
    return { deleted: id };
  }

  async createSchedule(
    input: { scheduleId: string; workflowType: string; intervalMinutes: number; note?: string },
    actorId: string,
  ): Promise<Row> {
    await this.temporal.create(input);
    await this.audit.record({ realm: 'ops', actorId, action: 'schedule.create', target: input.scheduleId, detail: { ...input } });
    return { created: input.scheduleId };
  }

  async workflows(status?: string, limit?: number): Promise<Row[]> {
    try {
      return await this.temporal.listWorkflows(status, Math.min(limit ?? 50, 200));
    } catch (error) {
      throw new ServiceUnavailableException({
        error: { code: 'TEMPORAL_UNAVAILABLE', message: `Temporal 不可达:${error instanceof Error ? error.message : String(error)}` },
      });
    }
  }

  async auditLog(limit = 100): Promise<Row[]> {
    const take = Math.min(limit, 500);
    const rows = await this.prisma.auditLog.findMany({ where: { realm: 'ops' }, orderBy: { at: 'desc' }, take });
    return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
  }
}
