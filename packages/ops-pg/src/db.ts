/**
 * 运营域对引擎 PostgreSQL 的访问层——自获客中台(acquisition-admin)server/src/db.ts
 * 原样移植(SD9:服务端集成资产照搬),仅做包化与最小适配。
 *
 * 安全边界(不得弱化):
 * - appPool(app_user):RLS 生效。平台表(无 RLS)直查;租户表必须走 withWorkspace。
 *   白名单写:monitored_source 的 INSERT/UPDATE/DELETE。
 * - ownerPool(迁移 owner):仅当 OWNER_DATABASE_URL 配置时创建,只服务于
 *   data_provider.status 白名单语句(app_user 无该表写权限,属预期)。
 * - schema 探针 fail-closed:探针未通过时,写端点整体拒绝。
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export type Row = QueryResultRow;

export interface OpsPgConfig {
  readonly APP_DATABASE_URL: string;
  readonly OWNER_DATABASE_URL?: string;
}

export class SchemaDriftError extends Error {
  readonly code = 'SCHEMA_DRIFT';
  constructor(public readonly missing: string[]) {
    super(`数据库 schema 与运营域预期不符:${missing.join('；')}`);
  }
}

/** 运营域依赖的引擎表与列。探针失败时写端点整体拒绝(fail-closed)。 */
export const EXPECTED_SCHEMA: Record<string, string[]> = {
  monitored_source: ['id', 'provider_key', 'source_key', 'label', 'config', 'sector_tags', 'region', 'series_key', 'status', 'cadence', 'last_fetch_at', 'next_fetch_at', 'created_at', 'updated_at'],
  data_provider: ['id', 'key', 'class', 'status', 'cost_per_call_cents', 'config', 'created_at'],
  source_fetch: ['id', 'source_id', 'status', 'total', 'added', 'updated', 'removed', 'unchanged', 'cost_cents', 'parser_version', 'error', 'started_at', 'finished_at'],
  source_entity: ['id', 'source_id', 'external_id', 'entity_kind', 'name', 'domain', 'country', 'cleaned', 'content_hash', 'first_seen_at', 'last_seen_at', 'withdrawn_at', 'miss_count'],
  source_entity_change: ['id', 'source_id', 'fetch_id', 'external_id', 'change_type', 'detail', 'created_at'],
  discovery_run: ['id', 'workspace_id', 'plan_id', 'icp_id', 'status', 'stats', 'created_at', 'completed_at'],
  lead: ['id', 'workspace_id', 'icp_id', 'canonical_company_id', 'status', 'fit_verdict', 'fit_reasons', 'queue', 'total_score', 'scores', 'score_detail', 'scored_at', 'created_at'],
  canonical_company: ['id', 'workspace_id', 'name', 'domain', 'country', 'status', 'dedupe_key'],
  outbox_event: ['id', 'event_id', 'workspace_id', 'event_type', 'payload', 'occurred_at', 'published_at', 'parked_at'],
  outbox_delivery: ['id', 'workspace_id', 'event_id', 'sink', 'status', 'attempts', 'last_error', 'next_attempt_at', 'delivered_at', 'acked_at', 'created_at'],
  workspace: ['id', 'name', 'created_at'],
  sanctions_source: ['key', 'label', 'status', 'publish_date', 'record_count', 'last_refreshed_at', 'last_fetch_status'],
  runtime_process_lease: ['role', 'state', 'task_queue', 'started_at', 'last_seen_at', 'stopped_at'],
  ai_trace: ['id', 'workspace_id', 'task', 'op', 'provider', 'model', 'status', 'error_message', 'latency_ms', 'input_tokens', 'output_tokens', 'cost_usd', 'created_at'],
};

export interface ProbeResult {
  ok: boolean;
  missing: string[];
  checkedAt: string;
}

/** 探针核心(纯函数,单测覆盖):按 information_schema 行比对期望表/列。 */
export function diffSchema(
  rows: ReadonlyArray<{ table_name: string; column_name: string }>,
  expected: Record<string, readonly string[]> = EXPECTED_SCHEMA,
): string[] {
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(expected)) {
    if (!rows.some((r) => r.table_name === table)) {
      missing.push(`缺表 ${table}`);
    } else {
      for (const col of cols) if (!have.has(`${table}.${col}`)) missing.push(`${table} 缺列 ${col}`);
    }
  }
  return missing;
}

export class OpsPg {
  private readonly appPool: Pool;
  readonly ownerPool: Pool | null;
  private probeResult: ProbeResult | null = null;

  constructor(config: OpsPgConfig) {
    this.appPool = new Pool({ connectionString: config.APP_DATABASE_URL, max: 8, connectionTimeoutMillis: 4000 });
    this.ownerPool = config.OWNER_DATABASE_URL
      ? new Pool({ connectionString: config.OWNER_DATABASE_URL, max: 2, connectionTimeoutMillis: 4000 })
      : null;
  }

  get probe(): ProbeResult | null {
    return this.probeResult;
  }

  async start(): Promise<ProbeResult> {
    const { rows } = await this.appPool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [Object.keys(EXPECTED_SCHEMA)],
    );
    const missing = diffSchema(rows);
    this.probeResult = { ok: missing.length === 0, missing, checkedAt: new Date().toISOString() };
    return this.probeResult;
  }

  assertWritable(): void {
    if (!this.probeResult?.ok) {
      throw new SchemaDriftError(this.probeResult?.missing ?? ['探针未运行']);
    }
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { rows } = await this.appPool.query<T>(sql, params as never[]);
    return rows;
  }

  /** 租户表(RLS)读取:事务内绑定 workspace。 */
  async withWorkspace<T>(workspaceId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.current_workspace_id', workspaceId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      await this.appPool.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 仅限已登记的 owner 白名单语句(当前:data_provider 启停、monitored_source 删除)。 */
  async ownerQuery<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.ownerPool) throw new Error('OWNER_DATABASE_URL 未配置,该操作不可用');
    const { rows } = await this.ownerPool.query<T>(sql, params as never[]);
    return rows;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.appPool.end(), this.ownerPool?.end()]);
  }
}
