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
  /** 引擎同步模型生成(ICP/查询计划/草稿)最长等待;BFF 默认 30s 会提前掐断。 */
  readonly timeoutMs?: number;
}

export const BFF_ROUTES: readonly BffRoute[] = [
  // ── 模块 02 卖家知识中心 ──
  { method: 'POST', saasPath: 'companies', enginePath: '/companies', access: 'member', grant: true },
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
): Record<string, unknown> | null {
  if (!route.grant) return null;
  switch (route.enginePath) {
    case '/companies':
      return { operation: 'POST /companies', body: body ?? {} };
    case '/companies/:companyId/icps':
      return { operation: 'POST /companies/:companyId/icps', companyId: params.companyId };
    case '/icps/:icpId/query-plans':
      return { operation: 'POST /icps/:icpId/query-plans', icpId: params.icpId };
    case '/query-plans/:planId/execute':
      return { operation: 'POST /query-plans/:planId/execute', planId: params.planId };
    case '/leads/:leadId/outreach-drafts':
      return { operation: 'POST /leads/:leadId/outreach-drafts', leadId: params.leadId };
    default:
      return null;
  }
}
