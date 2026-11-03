/**
 * BFF 路由表(SD7 铁律 1:只透传、映射与审计,不写业务逻辑)。
 *
 * - saasPath:前端调用路径(/api 下);enginePath:引擎 /api/v1 下的路径(支持 :param)
 * - access:'member' = 登录即可;'admin' = 追加 AdminGuard(对应 PRD §2.2 的角色→scope 划分:
 *   identity:review / compliance:manage / acquisition:export 只映射给 saas-admin)
 * - raw:true = 非 JSON 直通(周报 CSV)
 * - grant:true = 引擎写接口要求一次性的 Execution Budget Grant;BFF 先取 quote 再签 Grant
 *   (deploy/engine-integration.md §4/§5)。只有引擎 OpenAPI 声明 402/`X-Execution-Budget-Grant`
 *   的写路由才标这一位。
 *
 * 新增透传只在此表加一行;任何"业务逻辑"都不得进 BFF(铁律 1),否则退回。
 */

export interface BffRoute {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly saasPath: string;
  readonly enginePath: string;
  readonly access: 'member' | 'admin';
  readonly raw?: boolean;
  /** text/csv 原样透传(周报反馈上传),body 不经过 JSON 序列化。 */
  readonly csv?: boolean;
  readonly grant?: true;
  /** D6：请求未带 lawfulBasis 时由 BFF 注入租户的合法依据声明。 */
  readonly complianceInject?: true;
  /** 引擎同步模型生成(ICP/查询计划/草稿)最长等待;BFF 默认 30s 会提前掐断。 */
  readonly timeoutMs?: number;
}

export const BFF_ROUTES: readonly BffRoute[] = [
  // ── 模块 02 卖家知识中心 ──
  { method: 'POST', saasPath: 'companies', enginePath: '/companies', access: 'member', grant: true },
  { method: 'POST', saasPath: 'companies/:companyId/understanding/retry', enginePath: '/companies/:companyId/understanding/retry', access: 'member', grant: true },
  { method: 'PATCH', saasPath: 'companies/:companyId', enginePath: '/companies/:companyId', access: 'member' },
  { method: 'DELETE', saasPath: 'companies/:companyId', enginePath: '/companies/:companyId', access: 'member' },
  { method: 'POST', saasPath: 'companies/:companyId/website-candidates', enginePath: '/companies/:companyId/website-candidates', access: 'member' },
  { method: 'GET', saasPath: 'companies', enginePath: '/companies', access: 'member' },
  { method: 'GET', saasPath: 'companies/:companyId', enginePath: '/companies/:companyId', access: 'member' },
  { method: 'GET', saasPath: 'companies/:companyId/completeness', enginePath: '/companies/:companyId/completeness', access: 'member' },
  { method: 'POST', saasPath: 'companies/:companyId/confirm', enginePath: '/companies/:companyId/confirm', access: 'member' },
  { method: 'GET', saasPath: 'companies/:companyId/offerings', enginePath: '/companies/:companyId/offerings', access: 'member' },
  { method: 'GET', saasPath: 'companies/:companyId/claims', enginePath: '/companies/:companyId/claims', access: 'member' },
  { method: 'POST', saasPath: 'companies/:companyId/claims', enginePath: '/companies/:companyId/claims', access: 'member' },
  { method: 'POST', saasPath: 'claims/:claimId/approve', enginePath: '/claims/:claimId/approve', access: 'admin' },
  { method: 'POST', saasPath: 'claims/:claimId/reject', enginePath: '/claims/:claimId/reject', access: 'admin' },
  { method: 'POST', saasPath: 'claims/:claimId/revoke', enginePath: '/claims/:claimId/revoke', access: 'admin' },
  { method: 'GET', saasPath: 'companies/:companyId/conflicts', enginePath: '/companies/:companyId/conflicts', access: 'member' },
  { method: 'POST', saasPath: 'conflicts/:conflictId/resolve', enginePath: '/conflicts/:conflictId/resolve', access: 'admin' },

  // ── 模块 04 ICP 与发现 ──
  { method: 'POST', saasPath: 'companies/:companyId/icps', enginePath: '/companies/:companyId/icps', access: 'member', grant: true, timeoutMs: 240_000 },
  { method: 'GET', saasPath: 'icps', enginePath: '/icps', access: 'member' },
  { method: 'GET', saasPath: 'icps/:icpId', enginePath: '/icps/:icpId', access: 'member' },
  { method: 'PATCH', saasPath: 'icps/:icpId', enginePath: '/icps/:icpId', access: 'member' },
  { method: 'POST', saasPath: 'icps/:icpId/activate', enginePath: '/icps/:icpId/activate', access: 'member' },
  { method: 'POST', saasPath: 'icps/:icpId/rules', enginePath: '/icps/:icpId/rules', access: 'member' },
  { method: 'PATCH', saasPath: 'icp-rules/:ruleId', enginePath: '/icp-rules/:ruleId', access: 'member' },
  { method: 'DELETE', saasPath: 'icp-rules/:ruleId', enginePath: '/icp-rules/:ruleId', access: 'member' },
  { method: 'POST', saasPath: 'icps/:icpId/backtests', enginePath: '/icps/:icpId/backtests', access: 'member' },
  { method: 'GET', saasPath: 'icps/:icpId/backtests', enginePath: '/icps/:icpId/backtests', access: 'member' },
  { method: 'POST', saasPath: 'icps/:icpId/query-plans', enginePath: '/icps/:icpId/query-plans', access: 'member', grant: true, timeoutMs: 240_000 },
  { method: 'GET', saasPath: 'icps/:icpId/query-plans', enginePath: '/icps/:icpId/query-plans', access: 'member' },
  { method: 'POST', saasPath: 'query-plans/:planId/confirm', enginePath: '/query-plans/:planId/confirm', access: 'member' },
  { method: 'POST', saasPath: 'query-plans/:planId/execute', enginePath: '/query-plans/:planId/execute', access: 'member', grant: true },
  { method: 'GET', saasPath: 'discovery-runs/:runId', enginePath: '/discovery-runs/:runId', access: 'member' },

  // ── 模块 04 线索工作台 ──
  { method: 'POST', saasPath: 'icps/:icpId/qualify', enginePath: '/icps/:icpId/qualify', access: 'member' },
  { method: 'GET', saasPath: 'leads', enginePath: '/leads', access: 'member' },
  { method: 'GET', saasPath: 'icps/:icpId/lead-queues', enginePath: '/icps/:icpId/lead-queues', access: 'member' },
  { method: 'GET', saasPath: 'leads/:leadId/package', enginePath: '/leads/:leadId/package', access: 'member' },
  { method: 'POST', saasPath: 'leads/:leadId/outcomes', enginePath: '/leads/:leadId/outcomes', access: 'member' },
  { method: 'GET', saasPath: 'leads/:leadId/outreach-drafts', enginePath: '/leads/:leadId/outreach-drafts', access: 'member' },
  { method: 'POST', saasPath: 'leads/:leadId/outreach-drafts', enginePath: '/leads/:leadId/outreach-drafts', access: 'member', grant: true, timeoutMs: 240_000 },
  { method: 'POST', saasPath: 'leads/:leadId/accept', enginePath: '/leads/:leadId/accept', access: 'member' },
  { method: 'POST', saasPath: 'leads/:leadId/reject', enginePath: '/leads/:leadId/reject', access: 'member' },
  { method: 'POST', saasPath: 'leads/:leadId/sanctions-review', enginePath: '/leads/:leadId/sanctions-review', access: 'admin' },

  // ── 模块 03 知识视图与禁联 ──
  { method: 'GET', saasPath: 'canonical-companies', enginePath: '/canonical-companies', access: 'member' },
  // 决策人（联系人挖掘 M4）：引擎这些端点要求 compliance:manage + contact-discovery:read,
  // 两个 scope 都只映射给 saas-admin(见 deploy/engine-integration.md 的 role map)。
  // 部署侧 scope 未就绪时这些路由按「授权对接未就绪」502 降级。
  { method: 'GET', saasPath: 'canonical-companies/:id', enginePath: '/canonical-companies/:id', access: 'admin' },
  { method: 'POST', saasPath: 'canonical-companies/:id/discover-contacts', enginePath: '/canonical-companies/:id/discover-contacts', access: 'admin', grant: true, timeoutMs: 240_000, complianceInject: true },
  { method: 'POST', saasPath: 'canonical-companies/:id/guess-emails', enginePath: '/canonical-companies/:id/guess-emails', access: 'admin', grant: true, timeoutMs: 240_000, complianceInject: true },
  { method: 'POST', saasPath: 'contact-points/:pointId/verify', enginePath: '/contact-points/:pointId/verify', access: 'admin', grant: true, timeoutMs: 120_000, complianceInject: true },
  { method: 'GET', saasPath: 'data-providers', enginePath: '/data-providers', access: 'admin' },
  // 引擎这些端点都要求 compliance:manage（仅 SaaS admin 映射），不能给 member 放行。
  { method: 'GET', saasPath: 'suppressions', enginePath: '/suppressions', access: 'admin' },
  { method: 'POST', saasPath: 'suppressions', enginePath: '/suppressions', access: 'admin' },
  { method: 'POST', saasPath: 'suppressions/:id/decisions', enginePath: '/suppressions/:id/decisions', access: 'admin' },
  { method: 'GET', saasPath: 'suppressions/:id/decisions', enginePath: '/suppressions/:id/decisions', access: 'admin' },
  { method: 'DELETE', saasPath: 'suppressions/:id', enginePath: '/suppressions/:id', access: 'admin' },

  // ── 周报(D10/D11)──
  { method: 'GET', saasPath: 'reports/weekly', enginePath: '/reports/weekly', access: 'admin', raw: true },
  { method: 'POST', saasPath: 'reports/weekly/feedback', enginePath: '/reports/weekly/feedback', access: 'member', csv: true },

  // ── 数据主体删除请求(DSR,A6)──
  { method: 'POST', saasPath: 'deletion-requests', enginePath: '/deletion-requests', access: 'admin' },
  { method: 'GET', saasPath: 'deletion-requests/:id', enginePath: '/deletion-requests/:id', access: 'admin' },
];

export interface BudgetQuoteOptions {
  /** 引擎是否已支持 discover-contacts 的 attemptId。默认关闭，兼容未升级的引擎镜像。 */
  readonly discoverAttemptId?: boolean;
}

/** D6：租户声明的快照（服务层 Prisma 行的子集）。 */
export interface ComplianceDeclarationSnapshot {
  basis: string;
  ref?: string | null;
  note?: string | null;
  version: number;
  declaredAt: Date;
}

/**
 * D6：请求未显式携带 lawfulBasis 时，注入租户当前声明（带版本快照，审计可追溯）。
 * 必须在 quote 构造之前调用——guess/verify 的 quote 绑定 body，注入晚于 quote 会 SCOPE_MISMATCH。
 */
export function injectDeclaredCompliance(
  body: unknown,
  declared: ComplianceDeclarationSnapshot | null,
): unknown {
  if (!declared) return body;
  if (body && typeof body === 'object' && (body as Record<string, unknown>).lawfulBasis) return body;
  // 引擎合同：lawfulBasisRef ≤512、lawfulBasisNote ≤1000，且两者均禁 C0/DEL 控制字符
  // （backend discovery.controller.ts NO_CONTROL_CHARS）。声明全文（可多行、最长 4000）
  // 只存 SaaS 声明表供审计；注入固定版本戳 + 压成单行并截断的 ref，历史脏行也不会打挂操作。
  const stamp = `declared v${declared.version} ${declared.declaredAt.toISOString().slice(0, 10)}`;
  const ref = declared.ref
    ?.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 480);
  return {
    ...(typeof body === 'object' && body ? body : {}),
    lawfulBasis: declared.basis,
    ...(ref ? { lawfulBasisRef: ref } : {}),
    lawfulBasisNote: stamp,
  };
}

/**
 * 把 BFF 请求映射成引擎 `POST /execution-budget/workspace-technical-quote` 的 body。
 * 必须与引擎 `workspaceExecutionBudgetRequestScope` 的 operation/字段逐项一致,
 * 否则 quote 的 requestSha256 与业务请求对不上,Grant 会被 SCOPE_MISMATCH 拒绝。
 * 只用于标了 grant:true 的路由。
 */
export function budgetQuoteRequest(
  route: BffRoute,
  params: Record<string, string>,
  body: unknown,
  options: BudgetQuoteOptions = {},
): Record<string, unknown> | null {
  if (!route.grant) return null;
  switch (route.enginePath) {
    case '/companies':
      return { operation: 'POST /companies', body: body ?? {} };
    case '/companies/:companyId/understanding/retry': {
      const attemptId = (body as { attemptId?: unknown } | null)?.attemptId;
      return {
        operation: 'POST /companies/:companyId/understanding/retry',
        companyId: params.companyId,
        body: { attemptId },
      };
    }
    case '/companies/:companyId/icps':
      return { operation: 'POST /companies/:companyId/icps', companyId: params.companyId };
    case '/icps/:icpId/query-plans':
      return { operation: 'POST /icps/:icpId/query-plans', icpId: params.icpId };
    case '/query-plans/:planId/execute':
      return { operation: 'POST /query-plans/:planId/execute', planId: params.planId };
    case '/leads/:leadId/outreach-drafts':
      return { operation: 'POST /leads/:leadId/outreach-drafts', leadId: params.leadId };
    // 发现联系人绑定公司 ID；引擎支持 attemptId 后，把每次点击的幂等键并入请求哈希，
    // 重复发现才会落在独立预算账户（未升级的旧引擎不能收到该字段）。
    case '/canonical-companies/:id/discover-contacts': {
      const attemptId = (body as { attemptId?: unknown } | null)?.attemptId;
      const operation = 'POST /canonical-companies/:id/discover-contacts';
      if (!options.discoverAttemptId || typeof attemptId !== 'string' || attemptId.length === 0) {
        return { operation, companyId: params.id };
      }
      return { operation, companyId: params.id, body: { attemptId } };
    }
    // 猜测/验证把请求体一起绑定:引擎按 operation + ID + body 计算 requestSha256,
    // 少传或改写 body 会被 GRANT_SCOPE_MISMATCH 拒绝。
    case '/canonical-companies/:id/guess-emails':
      return {
        operation: 'POST /canonical-companies/:id/guess-emails',
        companyId: params.id,
        ...(body === undefined ? {} : { body }),
      };
    case '/contact-points/:pointId/verify':
      return {
        operation: 'POST /contact-points/:pointId/verify',
        pointId: params.pointId,
        ...(body === undefined ? {} : { body }),
      };
    default:
      return null;
  }
}

/**
 * 引擎未升级时的转发体兼容层：从 discover-contacts 请求体里移除 attemptId，
 * 避免旧 DTO 因未知字段拒绝（SaaS 前端总是发送该幂等键）。
 */
export function engineRequestBody(
  route: BffRoute,
  body: unknown,
  options: BudgetQuoteOptions = {},
): unknown {
  if (
    route.enginePath !== '/canonical-companies/:id/discover-contacts' ||
    options.discoverAttemptId ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    return body;
  }
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(([key]) => key !== 'attemptId'),
  );
}
