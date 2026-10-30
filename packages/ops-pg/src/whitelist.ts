/**
 * 写语句白名单登记制(中台 README 的安全边界,SD9 §13.2):
 * 运营域对引擎库的每一条非 SELECT 语句必须先在此登记(语句与参数化占位),
 * 调用点执行前用 assertAllowed 校验。未登记语句在开发期即抛错,
 * schema 探针 fail-closed 之外的第二道闸。
 */

export interface WhitelistEntry {
  readonly id: string;
  readonly sql: string;
  /** 人话说明:这条写语句为什么存在(进审计) */
  readonly purpose: string;
}

export class WriteNotAllowedError extends Error {
  readonly code = 'WRITE_NOT_ALLOWED';
  constructor(readonly id: string) {
    super(`写语句未登记白名单:${id} —— 新增写语句必须先登记(ops-pg/whitelist)`);
  }
}

export class WriteWhitelist {
  private readonly entries = new Map<string, WhitelistEntry>();

  register(entry: WhitelistEntry): WhitelistEntry {
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): WhitelistEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new WriteNotAllowedError(id);
    return entry;
  }

  list(): readonly WhitelistEntry[] {
    return [...this.entries.values()];
  }
}

/**
 * 运营域白名单(SD9 §13.1)。与中台一致:
 * - app 池:monitored_source 的 INSERT/UPDATE(含"立即抓取"= next_fetch_at 置到期)
 * - owner 池:data_provider 启停(Kill Switch)、monitored_source 删除(仅无数据源)
 */
export const OPS_WRITES = new WriteWhitelist();

OPS_WRITES.register({
  id: 'monitored_source.upsert',
  sql: 'INSERT INTO monitored_source (...) VALUES (...) ON CONFLICT (id) DO UPDATE SET ...',
  purpose: '新建/更新监控源(采集源管理)',
});
OPS_WRITES.register({
  id: 'monitored_source.acquire_now',
  sql: 'UPDATE monitored_source SET next_fetch_at = now(), updated_at = now() WHERE id = $1',
  purpose: '「立即抓取」:置 next_fetch_at 到期,由 ACQ_SWEEP 按完整管线执行',
});
OPS_WRITES.register({
  id: 'monitored_source.status',
  sql: 'UPDATE monitored_source SET status = $2, updated_at = now() WHERE id = $1',
  purpose: '监控源启停',
});
OPS_WRITES.register({
  id: 'monitored_source.delete',
  sql: 'DELETE FROM monitored_source WHERE id = $1',
  purpose: '删除无数据源的监控源(owner 池)',
});
OPS_WRITES.register({
  id: 'data_provider.status',
  sql: 'UPDATE data_provider SET status = $2 WHERE key = $1',
  purpose: '数据源 Kill Switch(owner 池)',
});
