/**
 * GainOS 业务 API(BFF 路由表透传；错误已由 request.ts 统一解包/映射,PRD §14)。
 * 字段命名跟随引擎 OpenAPI(packages/engine-client);未知字段一律防御性可选。
 */
import { baseRequestClient, requestClient } from '#/api/request';

export interface CompanyProfile {
  id?: string;
  name?: string | null;
  website?: string | null;
  domain?: string | null;
  status?: string;
  industry?: string | null;
  summary?: string | null;
  publicContacts?: Array<{ label?: string; value?: string; sourceUrl?: string | null; status?: string | null }>;
  completeness?: unknown;
  created_at?: string;
}

export interface CompanyCompleteness {
  status: string;
  approvedClaims: number;
  pendingClaims: number;
  offerings: number;
  conflictsOpen: number;
}

export interface CompanyConflict {
  id: string;
  companyId?: string;
  claimType?: string;
  status?: string;
  createdAt?: string;
  claimA?: { id: string; statement: string; status: string; type: string } | null;
  claimB?: { id: string; statement: string; status: string; type: string } | null;
}

export interface CompanyOffering {
  id: string;
  name: string;
  description?: string | null;
  attributes?: Record<string, unknown> | null;
  sourceUrl?: string | null;
  evidence?: string | null;
  confidence?: number | null;
  createdAt?: string;
}

/** 企业事实（引擎 Claim）：只有「已通过」的事实会进入目标买家设计。 */
export interface CompanyClaim {
  id: string;
  companyId: string;
  type: string;
  factKey?: string | null;
  statement: string;
  status: 'INGESTED' | 'EXTRACTED' | 'NEEDS_REVIEW' | 'APPROVED' | 'EXPIRED' | 'REVOKED' | string;
  confidence?: number | null;
  version: number;
  evidence?: Array<{ sourceUrl?: string | null; snippet?: string | null; confidence?: number | null }>;
  createdAt?: string;
}

export interface MembersResponse {
  members: Array<{ id: string; email: string; role: 'admin' | 'member'; joinedAt: string }>;
  invitations: Array<{ id: string; email: string; role: string; expiresAt: string }>;
}

export interface SessionInfo {
  user: { id: string; email: string };
  workspace: { id: string; role: 'admin' | 'member' };
  workspaces: Array<{ id: string; name: string; role: string }>;
}

/** 引擎 Lead 列表行(§14.2:界面用「买家线索」,不暴露 Lead 术语) */
export interface LeadCompanySummary {
  id?: string;
  name?: string | null;
  domain?: string | null;
  country?: string | null;
  industry?: string | null;
  employeeCount?: number | null;
}

export interface Lead {
  id: string;
  icpId?: string;
  canonicalCompanyId?: string;
  status?: string;
  queue?: string;
  fitVerdict?: string | null;
  fitReasons?: unknown;
  totalScore?: number | null;
  scores?: Record<string, unknown> | null;
  scored?: boolean;
  queueBasis?: string;
  createdAt?: string;
  updatedAt?: string;
  scoredAt?: string | null;
  company?: LeadCompanySummary | null;
}

export interface LeadOutcomeInput {
  relevance?: number;
  willingToContact?: boolean;
  reasonCode?: string;
  note?: string;
  contacted?: boolean;
  source?: 'customer' | 'operator';
}

export interface LeadPackage {
  lead_id: string;
  status: string;
  company: {
    canonical_company_id: string;
    name: string;
    domain?: string | null;
    country?: string | null;
    city?: string | null;
  };
  company_profile?: Record<string, unknown>;
  registered_address?: string | null;
  identifiers?: Record<string, string | null>;
  contact_points?: Array<{ kind: string; url: string; status: string }>;
  suggested_contact_path?: { kind: string; url: string; legal_note: string } | null;
  signals?: Array<Record<string, unknown>>;
  scores?: Record<string, unknown>;
  fit?: Record<string, unknown>;
  evidence?: Array<Record<string, unknown>>;
  sanctions?: { status: string; screened_at: string | null };
  valid_until?: string | null;
}

export interface LeadQueueCounts {
  recommended: number;
  needs_review: number;
  rejected: number;
  suppressed: number;
  sanctions_hold: number;
  scored: boolean;
  queueBasis: {
    fit_gate_preset: number;
    score: number;
    human_accept: number;
    human_reject: number;
  };
}

export interface LeadDecisionInput {
  reasonCode?: string;
  reason?: string;
}

export interface IcpPersona {
  title: string;
  goals: string[];
  painPoints: string[];
}

export interface IcpBuyingRole {
  role: string;
  title?: string | null;
  concerns: string[];
}

export interface IcpRule {
  id: string;
  kind: string;
  field: string;
  operator: string;
  value: unknown;
  weight: number;
  rationale?: string | null;
}

export interface Icp {
  id: string;
  companyId: string;
  name: string;
  status: string;
  companyAttributes: Record<string, unknown>;
  painPoints: string[];
  triggerSignals: string[];
  exclusions: string[];
  valueProps: string[];
  targetMarkets: string[];
  version: number;
  personas: IcpPersona[];
  buyingCommittee: IcpBuyingRole[];
  rules: IcpRule[];
  ruleLint: string[];
  createdAt: string;
}

export interface IcpUpdateInput {
  name?: string;
  companyAttributes?: Record<string, unknown>;
  painPoints?: string[];
  triggerSignals?: string[];
  exclusions?: string[];
  valueProps?: string[];
  targetMarkets?: string[];
  expectedVersion: number;
}

export interface IcpRuleInput {
  kind: string;
  field: string;
  operator: string;
  value: unknown;
  weight?: number;
  rationale?: string;
}

export interface BacktestSample {
  name: string;
  domain?: string;
  attributes: Record<string, unknown>;
  expected: 'match' | 'exclude';
}

export interface Backtest {
  id: string;
  icpId: string;
  results: Array<Record<string, unknown>>;
  metrics: Record<string, unknown>;
  createdAt: string;
}

export interface QueryPlan {
  id: string;
  icpId: string;
  status: string;
  queries: Array<Record<string, unknown>>;
  estimatedVolume?: number | null;
  version: number;
  createdAt: string;
}

export interface DiscoveryRun {
  id: string;
  planId: string;
  icpId: string;
  status: string;
  stats: Record<string, unknown>;
  createdAt: string;
  completedAt?: string | null;
}

/** SaaS 侧的 run → plan/ICP 引用，用于关闭页面后找回寻源任务。 */
export interface DiscoveryRunLink {
  runId: string;
  planId: string;
  icpId: string;
  startedAt: string;
}

export interface AppNotification {
  id: string;
  type: string;
  refId?: string | null;
  title?: string | null;
  readAt?: string | null;
  createdAt: string;
  link?: string;
}

export interface NotificationPage {
  unreadCount: number;
  items: AppNotification[];
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
  current: boolean;
}

export interface DeletionRequestView {
  id: string;
  status: string;
  subjectType: string;
  subjectId: string;
  reason?: string | null;
  requestRef?: string | null;
  createdAt: string;
  completedAt?: string | null;
  receipt?: {
    contactsErased: number;
    contactPointsErased: number;
    fieldEvidenceErased: number;
    signalsRevoked: number;
    companiesSuppressed: number;
    leadsRescoreRequested: number;
    patentCacheErased: number;
    ruleVersion: string;
    createdAt: string;
  } | null;
}

export interface AuditEntry {
  id: string;
  realm: string;
  actorId: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  at: string;
}

export const gainosApi = {
  session: () => requestClient.get<SessionInfo>('/auth/session'),
  audit: (limit = 100) => requestClient.get<{ entries: AuditEntry[] }>('/audit', { params: { limit } }),
  createDeletionRequest: (input: { subjectType: 'company' | 'contact'; subjectId: string; reason?: string; requestRef?: string }) =>
    requestClient.post<DeletionRequestView>('/deletion-requests', input),
  deletionRequest: (id: string) => requestClient.get<DeletionRequestView>(`/deletion-requests/${id}`),
  members: () => requestClient.get<MembersResponse>('/members'),
  inviteMember: (email: string, role: 'admin' | 'member') =>
    requestClient.post<{
      id: string;
      email: string;
      role: string;
      expiresAt: string;
      token: string;
      invitePath: string;
    }>('/members/invite', { email, role }),
  changeRole: (membershipId: string, role: 'admin' | 'member') =>
    requestClient.request<{ id: string; role: string }>(`/members/${membershipId}`, {
      data: { role },
      method: 'PATCH',
    }),
  removeMember: (membershipId: string) => requestClient.delete(`/members/${membershipId}`),
  companies: () => requestClient.get<CompanyProfile[] | { data?: CompanyProfile[] }>('/companies'),
  createCompany: (input: { website: string; name?: string }) =>
    requestClient.post<CompanyProfile>('/companies', input),
  confirmCompany: (companyId: string) =>
    requestClient.post<CompanyProfile>(`/companies/${companyId}/confirm`, {}),
  companyDetail: (companyId: string) => requestClient.get<CompanyProfile>(`/companies/${companyId}`),
  companyCompleteness: (companyId: string) =>
    requestClient.get<CompanyCompleteness>(`/companies/${companyId}/completeness`),
  companyOfferings: (companyId: string) =>
    requestClient.get<CompanyOffering[]>(`/companies/${companyId}/offerings`),
  createClaim: (companyId: string, input: { type: string; statement: string; evidence?: string }) =>
    requestClient.post<CompanyClaim>(`/companies/${companyId}/claims`, input),
  claims: (companyId: string, status?: string) =>
    requestClient.get<CompanyClaim[]>(`/companies/${companyId}/claims`, {
      params: status ? { status } : {},
    }),
  approveClaim: (claimId: string) => requestClient.post<CompanyClaim>(`/claims/${claimId}/approve`, {}),
  rejectClaim: (claimId: string) => requestClient.post<CompanyClaim>(`/claims/${claimId}/reject`, {}),
  revokeClaim: (claimId: string) => requestClient.post<CompanyClaim>(`/claims/${claimId}/revoke`, {}),
  companyConflicts: (companyId: string) =>
    requestClient.get<CompanyConflict[]>(`/companies/${companyId}/conflicts`, { params: { status: 'OPEN' } }),
  resolveConflict: (conflictId: string, keep: 'a' | 'b') =>
    requestClient.post<CompanyConflict>(`/conflicts/${conflictId}/resolve`, { keep }),
  leads: (params: { icpId?: string; queue?: string; status?: string; limit?: number } = {}) =>
    requestClient.get<Lead[]>('/leads', { params }),
  leadPackage: (leadId: string) => requestClient.get<LeadPackage>(`/leads/${leadId}/package`),
  leadOutcome: (leadId: string, input: LeadOutcomeInput) =>
    requestClient.post<Record<string, unknown>>(`/leads/${leadId}/outcomes`, input),
  leadQueues: (icpId: string) =>
    requestClient.get<LeadQueueCounts>(`/icps/${icpId}/lead-queues`),
  acceptLead: (leadId: string, input: LeadDecisionInput = {}) =>
    requestClient.post<{ accepted: boolean; eventId: string }>(`/leads/${leadId}/accept`, input),
  rejectLead: (leadId: string, input: LeadDecisionInput) =>
    requestClient.post<Lead>(`/leads/${leadId}/reject`, input),
  sanctionsReview: (
    leadId: string,
    decision: 'cleared_false_positive' | 'confirmed_true_hit',
    note?: string,
  ) => requestClient.post<{ leadId: string; reviewState: string }>(
    `/leads/${leadId}/sanctions-review`,
    { decision, ...(note ? { note } : {}) },
  ),
  outreachDraft: (leadId: string) =>
    requestClient.post<Record<string, unknown>>(`/leads/${leadId}/outreach-drafts`, {}),
  // 草稿读取是可选增强：旧引擎没有该端点时返回 404，不能弹全局错误。
  outreachDrafts: async (leadId: string) => {
    const response = await baseRequestClient.get<{ data?: Record<string, unknown> | null }>(
      `/leads/${leadId}/outreach-drafts`,
    );
    return response?.data?.data ?? null;
  },
  icps: (companyId?: string) =>
    requestClient.get<Icp[]>('/icps', { params: companyId ? { companyId } : {} }),
  icp: (icpId: string) => requestClient.get<Icp>(`/icps/${icpId}`),
  createIcp: (companyId: string) => requestClient.post<Icp>(`/companies/${companyId}/icps`, {}),
  updateIcp: (icpId: string, input: IcpUpdateInput) =>
    requestClient.request<Icp>(`/icps/${icpId}`, { data: input, method: 'PATCH' }),
  activateIcp: (icpId: string) => requestClient.post<Icp>(`/icps/${icpId}/activate`, {}),
  createIcpRule: (icpId: string, input: IcpRuleInput) =>
    requestClient.post<IcpRule>(`/icps/${icpId}/rules`, input),
  updateIcpRule: (ruleId: string, input: Partial<IcpRuleInput>) =>
    requestClient.request<IcpRule>(`/icp-rules/${ruleId}`, { data: input, method: 'PATCH' }),
  deleteIcpRule: (ruleId: string) => requestClient.delete(`/icp-rules/${ruleId}`),
  runBacktest: (icpId: string, samples: BacktestSample[]) =>
    requestClient.post<Backtest>(`/icps/${icpId}/backtests`, { samples }),
  queryPlans: (icpId: string) => requestClient.get<QueryPlan[]>(`/icps/${icpId}/query-plans`),
  createQueryPlan: (icpId: string) => requestClient.post<QueryPlan>(`/icps/${icpId}/query-plans`, {}),
  confirmQueryPlan: (planId: string) =>
    requestClient.post<QueryPlan>(`/query-plans/${planId}/confirm`, {}),
  executeQueryPlan: (planId: string) =>
    requestClient.post<{ runId: string; status: string }>(`/query-plans/${planId}/execute`, {}),
  discoveryRun: (runId: string) => requestClient.get<DiscoveryRun>(`/discovery-runs/${runId}`),
  discoveryRunLinks: (icpId: string) =>
    requestClient.get<DiscoveryRunLink[]>('/runs', { params: { icpId } }),
  recordDiscoveryRun: (input: { runId: string; planId: string; icpId: string }) =>
    requestClient.post<DiscoveryRunLink>('/runs', input),
  workspaces: () => requestClient.get<WorkspaceSummary[]>('/workspaces'),
  createWorkspace: (name: string) => requestClient.post<WorkspaceSummary>('/workspaces', { name }),
  renameWorkspace: (workspaceId: string, name: string) =>
    requestClient.request<{ id: string; name: string }>(`/workspaces/${workspaceId}`, {
      data: { name },
      method: 'PATCH',
    }),
  leaveWorkspace: (workspaceId: string) =>
    requestClient.post<{ left: boolean; currentWorkspace: boolean }>(`/workspaces/${workspaceId}/leave`, {}),
  switchWorkspace: (workspaceId: string) =>
    requestClient.post<{ workspace: { id: string }; role: string }>('/auth/switch-workspace', { workspaceId }),
  notifications: () => requestClient.get<NotificationPage>('/notifications'),
  readNotification: (id: string) => requestClient.post<{ ok: boolean }>(`/notifications/${id}/read`, {}),
  readAllNotifications: () => requestClient.post<{ updated: number }>('/notifications/read-all', {}),
  deleteNotification: (id: string) => requestClient.delete<{ ok: boolean }>(`/notifications/${id}`),
};

/** 引擎/合同错误信息提取(三层文案优先) */
export function failureText(error: unknown): { title: string; next: string | undefined } {
  const detail = (error as { response?: { data?: { error?: { userCopy?: { title?: string; why?: string; next?: string }; message?: string } } } })?.response?.data?.error;
  if (detail?.userCopy?.title) return { title: detail.userCopy.title, next: detail.userCopy.next };
  return { title: detail?.message ?? (error as Error)?.message ?? '请求失败，请稍后重试', next: undefined };
}
