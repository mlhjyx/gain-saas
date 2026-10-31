import { z } from 'zod';

/**
 * 启动即校验(仿引擎 config 模式):非法配置拒绝启动。
 * 密钥与会话签名钥走环境注入,不入库不入仓。
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(4020),
  DATABASE_URL: z.string().min(1, 'SaaS 自有库连接串必填(postgresql://...)'),
  ENGINE_ORIGIN: z.string().default('http://127.0.0.1:3000'),
  ENGINE_OPENAPI_URL: z.string().default('http://127.0.0.1:3000/api/docs-json'),
  TEMPORAL_ADDRESS: z.string().default('127.0.0.1:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  // 会话签名(HS256,SaaS 自有会话;与引擎 JWT 的 RS256 双钥分离)
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET 至少 32 字符(openssl rand -hex 32)'),
  // 引擎 JWT 签名钥(RS256):PEM 私钥全文 + kid;JWKS 端点据此出公钥(PRD §2.3)
  ENGINE_JWT_PRIVATE_KEY: z.string().min(1),
  ENGINE_JWT_KEY_ID: z.string().min(1),
  ENGINE_JWT_ISSUER: z.string().min(1, 'ENGINE_JWT_ISSUER 必填,且必须与引擎 AUTH_ISSUER 逐字符一致'),
  ENGINE_JWT_AUDIENCE: z.string().default('global-backend'),
  // 执行预算 Grant 签名钥(RS256,与身份钥分离);必须与引擎 EXECUTION_BUDGET_GRANT_* 一致
  ENGINE_BUDGET_GRANT_PRIVATE_KEY: z.string().min(1, 'ENGINE_BUDGET_GRANT_PRIVATE_KEY 必填(与身份钥分离的 RSA 私钥)'),
  ENGINE_BUDGET_GRANT_KEY_ID: z.string().min(1),
  ENGINE_BUDGET_GRANT_ISSUER: z.string().min(1, 'ENGINE_BUDGET_GRANT_ISSUER 必填,且必须与引擎 EXECUTION_BUDGET_GRANT_ISSUER 逐字符一致'),
  ENGINE_BUDGET_GRANT_TTL_SECONDS: z.coerce.number().min(1).max(300).default(240),
  SESSION_TTL_MINUTES: z.coerce.number().default(60),
  // SD6:design partner 阶段的注册邀请码;不配置 = 不校验(开发期)
  INVITE_CODE: z.string().optional(),
  // 事件消费(SD4):M0 默认关闭,待引擎侧角色映射配置后打开
  EVENT_CONSUMER_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  EVENT_CONSUMER_INTERVAL_MS: z.coerce.number().default(120_000),
  EVENT_CONSUMER_PAGE_LIMIT: z.coerce.number().default(100),
  // 运营域(SD9):未配置时运营域整体 503,不影响租户域
  OPS_APP_DATABASE_URL: z.string().optional(),
  OPS_OWNER_DATABASE_URL: z.string().optional(),
  OPS_SESSION_TTL_MINUTES: z.coerce.number().min(5).max(24 * 60).default(480),
  // 内嵌模型网关:运营台管理上游厂商;引擎用这个 Bearer Key 调 /v1/chat/completions
  MODEL_GATEWAY_API_KEY: z.string().min(16).optional(),
  // 上游 API Key 落库加密材料;缺失时从 SESSION_SECRET 派生(轮换 SESSION_SECRET 会要求重录上游 Key)
  MODEL_GATEWAY_ENC_KEY: z.string().min(32).optional(),
  MODEL_GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
  // 站点构建 settled 调用与读回仍由 new-api 提供;通过内嵌网关透明代理,避免客户 worker 启动检查失败
  MODEL_GATEWAY_SETTLEMENT_ORIGIN: z.string().url().optional(),
  MODEL_GATEWAY_SETTLEMENT_API_KEY: z.string().min(1).optional(),
  SPA_DIST_DIR: z.string().default('../web/dist'),
  // R4 平台权威密钥族(P1)。与身份钥、预算钥完全分离;生产缺失时对应 JWKS 端点 503,
  // 开发/测试缺失时生成临时密钥(仅进程内有效,重启即换)。
  R4_CAPABILITY_PRIVATE_KEY: z.string().optional(),
  R4_CAPABILITY_KEY_ID: z.string().optional(),
  R4_TEMPORAL_RUNTIME_PRIVATE_KEY: z.string().optional(),
  R4_TEMPORAL_RUNTIME_KEY_ID: z.string().optional(),
  R4_SITE_BUILD_BUDGET_PRIVATE_KEY: z.string().optional(),
  R4_SITE_BUILD_BUDGET_KEY_ID: z.string().optional(),
  R4_MACHINE_PRIVATE_KEY: z.string().optional(),
  R4_MACHINE_KEY_ID: z.string().optional(),
  // 机器 token 签发（P2）：issuer/audience 必须与引擎 trust 逐字符一致；
  // subject 与 configurationRevision 由部署侧给出（迁移后在 P7 与 mTLS 身份对齐）。
  R4_MACHINE_TOKEN_ISSUER: z.string().default('https://127.0.0.1:18446/temporal-runtime'),
  // capability 机器 token 的 iss：引擎用 CAPABILITY_MACHINE_ISSUER 逐字比对，与
  // TEMPORAL_MACHINE_ISSUER（带 /temporal-runtime）不是同一个字符串。
  R4_CAPABILITY_MACHINE_ISSUER: z.string().default('https://127.0.0.1:18444/'),
  R4_MACHINE_TOKEN_TEMPORAL_AUDIENCE: z.string().default('global-backend:platform-temporal'),
  R4_MACHINE_SUBJECT: z.string().optional(),
  R4_MACHINE_CONFIGURATION_REVISION: z.string().optional(),
  // capability 签发（P3）：issuer/audience 必须与引擎 PLATFORM_CAPABILITY_* 逐字符一致。
  // TTL 上限 30 秒是引擎的新鲜度硬约束，配置只能更短。
  R4_CAPABILITY_ISSUER: z.string().default('https://127.0.0.1:18446/'),
  R4_CAPABILITY_AUDIENCE: z.string().default('global-backend:platform-temporal'),
  R4_CAPABILITY_NAMESPACE: z.string().default('platform-automation'),
  R4_CAPABILITY_TTL_SECONDS: z.coerce.number().int().min(1).max(30).default(30),
  // 部署绑定文件（backendSha / 摘要 / validUntil，7 天有效，由运维工具生成）
  R4_DEPLOYMENT_BINDING_FILE: z.string().optional(),
  // 后端基址（P4 撤销投递目标；P7 切换前可不配）
  R4_BACKEND_BASE_URL: z.string().url().optional(),
  R4_REVOCATION_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(120),
  // 后端 fence-ack 的签发者（P5 验 ACK 用；与 R4_BACKEND_BASE_URL 一起配置）
  R4_FENCE_ACK_ISSUER: z.string().optional(),
  // egress 期望值文件（引擎容器内推导出的 JSONL，P3d）
  R4_EGRESS_EXPECTED_FILE: z.string().optional(),
  // R4 内部 TLS 监听（P5b）：配置后在同一进程上再起一个 mTLS 服务端，
  // 证书由 r4-pki 签发，引擎侧信任根不变。默认只绑回环。
  R4_TLS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  R4_TLS_HOST: z.string().default('127.0.0.1'),
  R4_TLS_CERT_FILE: z.string().optional(),
  R4_TLS_KEY_FILE: z.string().optional(),
  R4_TLS_CA_FILE: z.string().optional(),
  // none(默认,仅服务端 TLS,供引擎取 JWKS) | required(要求客户端证书,供机器 token)
  R4_TLS_CLIENT_AUTH: z.enum(['none', 'required']).default('none'),
  // 第二个监听：要求客户端证书（机器 token），与 R4_TLS_PORT 并存（P5b）
  R4_MTLS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // 校验客户端证书的 CA（机器客户端 CA）；缺省回退到 R4_TLS_CA_FILE
  R4_MTLS_CA_FILE: z.string().optional(),
  // P3c：真实 Temporal schedule 读取与租约心跳（默认关闭，P7 才开）
  R4_TEMPORAL_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  R4_TEMPORAL_ADDRESS: z.string().default('127.0.0.1:17233'),
  R4_TEMPORAL_NAMESPACE: z.string().default('platform-automation'),
  R4_TEMPORAL_TLS_CERT_FILE: z.string().optional(),
  R4_TEMPORAL_TLS_KEY_FILE: z.string().optional(),
  R4_TEMPORAL_TLS_CA_FILE: z.string().optional(),
  // gRPC 主机名覆盖：reader 身份必须走 SNI temporal-platform-reader 才会被要求客户端证书
  R4_TEMPORAL_SERVER_NAME: z.string().default('temporal-platform-reader'),
  // 平台机器策略里 schedule 只读身份只有一个固定 subject（与 GrowthOS reader 共用）
  R4_TEMPORAL_READER_SUBJECT: z.string().default('growthos-temporal-reader'),
  R4_LEASE_HEARTBEAT_ENABLED: z.string().default('false').transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`配置无效 —— ${issues}(参考 .env.example)`);
  }
  cached = parsed.data;
  return cached;
}

/** 测试用:清缓存 */
export function resetConfigCache(): void {
  cached = null;
}
