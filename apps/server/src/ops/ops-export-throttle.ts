/**
 * 运营台批量导出的操作员级限流（进程内滑动窗口）。
 * ops 域单实例运行；重启清零可接受（限流是防滥用兜底，不是计费依据）。
 */
export class OpsExportThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  allow(actorId: string, now: number = Date.now()): boolean {
    const from = now - this.windowMs;
    const list = (this.hits.get(actorId) ?? []).filter((t) => t > from);
    if (list.length >= this.limit) {
      this.hits.set(actorId, list);
      return false;
    }
    list.push(now);
    this.hits.set(actorId, list);
    return true;
  }
}
