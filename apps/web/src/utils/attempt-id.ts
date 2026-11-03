/**
 * RFC4122 v4 幂等键。
 * crypto.randomUUID 只在 secure context 存在;HTTP 访问(如 100.68.31.20:4020)下不可用,
 * 因此退回 getRandomValues 手工拼 v4。用于理解重试、联系人发现等按次隔离预算账户的操作。
 */
export function newAttemptId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
