import { createHash } from 'node:crypto';

/**
 * CampaignPlan 的规范化 JSON：对象键按 UTF-16 码元排序（RFC 8785 JCS 等价子集），
 * 与序列化顺序无关、跨平台稳定；plan_hash 由此计算并被审批与授权绑定。
 * schema 已把数值限制为整数；此处对浮点/非有限数仍显式拒绝——防止将来 schema
 * 放宽时指纹语义静默漂移。
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error('canonical JSON 只接受有限整数');
      }
      return String(value);
    case 'string':
      return JSON.stringify(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeJson(v)}`).join(',')}}`;
  }
  throw new Error(`canonical JSON 不支持的类型: ${typeof value}`);
}

export function planHashOf(plan: unknown): string {
  return createHash('sha256').update(canonicalizeJson(plan), 'utf8').digest('hex');
}
