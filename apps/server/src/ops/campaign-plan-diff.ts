/**
 * 计划 JSON 的叶子字段结构 diff（M2.2 设计 §5「人工修改距离 = 审批版本与首稿的叶子字段
 * diff 数」，D-M2.2-c：结构距离，不做语义相似度）。
 *
 * 叶子 = 原始值（字符串/数字/布尔/null）与空容器；对象与数组按容器展开，数组以数字下标
 * 寻址。与 backend 的 golden 跑批器同口径，便于两份证据互相引用。
 */

export interface CampaignPlanDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

function isContainer(value: unknown): value is Record<string, unknown> | readonly unknown[] {
  return Boolean(value) && typeof value === 'object';
}

function collectLeaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, '[]');
      return;
    }
    value.forEach((item, index) =>
      collectLeaves(item, prefix === '' ? String(index) : `${prefix}.${String(index)}`, out),
    );
    return;
  }
  if (isContainer(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) {
      out.set(prefix, '{}');
      return;
    }
    for (const key of keys.sort()) {
      collectLeaves(record[key], prefix === '' ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  out.set(prefix, value);
}

export function diffPlanLeaves(baseline: unknown, current: unknown): CampaignPlanDiff {
  const left = new Map<string, unknown>();
  const right = new Map<string, unknown>();
  collectLeaves(baseline, '', left);
  collectLeaves(current, '', right);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, value] of right) {
    if (!left.has(path)) added.push(path);
    else if (JSON.stringify(left.get(path)) !== JSON.stringify(value)) changed.push(path);
  }
  for (const path of left.keys()) {
    if (!right.has(path)) removed.push(path);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** 修改距离 = 新增 + 删除 + 修改的叶子字段数（0 = 零修改通过）。 */
export function modificationDistance(baseline: unknown, current: unknown): number {
  const diff = diffPlanLeaves(baseline, current);
  return diff.added.length + diff.removed.length + diff.changed.length;
}
