import { ServiceUnavailableException } from '@nestjs/common';

/**
 * 内部凭据端点（/api/internal/v1/*）只允许经 TLS 监听口（R4_TLS_PORT/R4_MTLS_PORT）到达。
 *
 * 机器 token 与 capability 是平台权威凭据，绝不能由明文入口（0.0.0.0:4020 及其
 * natfrp 隧道）铸造。此前 machine-token 的门只在 NODE_ENV=production 时生效，
 * 而部署实际以 development 运行——公网可无凭据铸 token（2026-11-08 安全审计实测）。
 * 现在改为无条件要求 TLS 到达：引擎经 R4_TLS_PORT(18447) 访问不受影响。
 */
export function assertInternalTls(req: unknown): void {
  // express 的 Request.socket 是 net.Socket，TLS 专有的 `encrypted` 不在类型里；此处收窄读取。
  const socket = (req as { socket?: { encrypted?: boolean } } | undefined)?.socket;
  if (socket?.encrypted === true) return;
  throw new ServiceUnavailableException({
    error: {
      code: 'INTERNAL_ENDPOINT_TLS_ONLY',
      message: '内部端点仅接受 TLS 监听通道（R4_TLS_PORT/R4_MTLS_PORT）',
    },
  });
}
