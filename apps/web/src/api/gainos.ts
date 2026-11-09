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
  /** 目标市场（ISO 3166-1 alpha-2；注册引导填写的卖家事实）。 */
  targetMarkets?: string[];
  /** 公司级询盘接收缺省邮箱（注册引导填写）。 */
  businessEmail?: string | null;
  summary?: string | null;
  publicContacts?: Array<{ label?: string; value?: string; sourceUrl?: string | null; status?: string | null }>;
  completeness?: unknown;
  /** 最近一次理解失败的时间（ISO）；非空且 status=DRAFT 时允许重试。 */
  understandingFailedAt?: string | null;
  /** 理解失败的错误标签（stage:ErrorType），仅诊断展示。 */
  understandingLastError?: string | null;
  /** 仅创建响应携带：无官网时理解不会触发（引擎 D17）。 */
  understanding?: 'started' | 'not_started';
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

/** 企业事实（引擎 Claim）：只有「已通过」的事实会进入目标客户画像设计。 */
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

/** 联系方式状态（引擎 contact_point.status；BLOCKED 是验证时合规门拦截的结果，也会回写状态）。 */
export type ContactPointStatus = 'UNVERIFIED' | 'VALID' | 'RISKY' | 'INVALID' | 'BLOCKED' | string;

export interface CanonicalContactPoint {
  id: string;
  type: 'email' | 'phone' | 'linkedin' | 'external_id' | string;
  value: string;
  status: ContactPointStatus;
  verifiedAt?: string | null;
}

/** 决策人（具名联系人）：引擎 canonical_contact，姓名/职位/部门 + 联系方式。 */
export interface CanonicalContact {
  id: string;
  companyId?: string;
  fullName: string;
  title?: string | null;
  seniority?: string | null;
  department?: string | null;
  createdAt?: string;
  contactPoints?: CanonicalContactPoint[];
}

/** 字段级证据：来源页/时间/许可都在这（联系人证据按 entityId = 联系人 id 关联）。 */
export interface ContactEvidence {
  id?: string;
  entityType?: 'company' | 'contact' | string;
  entityId: string;
  field: string;
  value?: Record<string, unknown> | null;
  providerKey?: string;
  license?: string;
  sourceUrl?: string | null;
  fetchedAt?: string;
  allowedActions?: string[] | null;
}

export interface CanonicalCompanyDetail {
  company: {
    id: string;
    name?: string | null;
    domain?: string | null;
    country?: string | null;
    status?: string;
    contacts?: CanonicalContact[];
  };
  evidence: ContactEvidence[];
}

/** GDPR Art.6 的合法性基础；发现决策人必须显式给出，猜测/验证人名邮箱同理。 */
export type LawfulBasisKind = 'legitimate_interest' | 'consent' | 'contract' | 'legal_obligation';

export interface ContactComplianceInput {
  /** D6 起由 BFF 按租户「数据处理声明」自动注入；仅在需要覆盖声明时才显式携带。 */
  lawfulBasis?: LawfulBasisKind;
  lawfulBasisRef?: string;
  lawfulBasisNote?: string;
}

export interface DiscoverContactsInput extends ContactComplianceInput {
  /** 每次点击生成的幂等键；引擎支持后用于把重复发现隔离到各自的预算账户。 */
  attemptId?: string;
}

export interface DiscoverContactsResult {
  contacts: CanonicalContact[];
  skippedSuppressed?: number;
  skippedInvalid?: number;
  diagnostics?: Record<string, number>;
}

export interface GuessEmailsResult {
  emaillessContacts: number;
  attempted: number;
  persisted: number;
  verified: number;
  unverified: number;
  blocked: number;
  perContact: Array<{ fullName: string; status: string; email: string | null; pointStatus: string | null }>;
}

export interface VerifyContactPointResult extends CanonicalContactPoint {
  verification?: {
    status: string;
    detail?: string | null;
    kind?: string | null;
    providerKey?: string;
    lawfulBasis?: unknown;
  };
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

export interface CampaignPlanV0View {
  schemaVersion: string;
  goal: { objective: string; successMetric?: string };
  audience: { icpIds: string[]; sizeCap: number };
  motions: Array<{ type: string; icpIds: string[] }>;
  budget: { capMicros?: number; currency: string };
  approvalPolicy: { required: boolean };
  decisionPolicy: { maxReplans: number };
}

export interface CampaignSummary {
  id: string;
  name: string;
  objective: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  latestRevision: {
    id: string;
    revisionNo: number;
    state: string;
    planHash: string;
  } | null;
}

export interface CampaignApprovalView {
  id: string;
  state: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  expiresAt: string;
}

export interface CampaignRevisionView {
  id: string;
  revisionNo: number;
  state: string;
  planHash: string;
  plan: CampaignPlanV0View;
  createdAt: string;
  audience: { icpIds: string[]; sizeCap: number } | null;
  approvals: CampaignApprovalView[];
}

export interface CampaignAuthorizationView {
  id: string;
  revisionId: string;
  planHash: string;
  scope: unknown;
  state: string;
  uses: number;
  maxUses: number;
  issuedAt: string;
  expiresAt: string;
}

export interface CampaignTraceEntry {
  traceId: string;
  stepType: string;
  actor: string;
  actorType: string;
  decisionType: string;
  chosenOption: string | null;
  reasonCode: string | null;
  createdAt: string;
}

export interface CampaignDetail {
  id: string;
  name: string;
  objective: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  revisions: CampaignRevisionView[];
  authorizations: CampaignAuthorizationView[];
  recentTrace: CampaignTraceEntry[];
}

export interface CampaignPlanJobView {
  id: string;
  campaignId: string;
  state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  objective: string;
  error: string | null;
  issues: Array<{ path: string; message: string }> | null;
  planHash: string | null;
  revisionId: string | null;
  createdAt: string;
  updatedAt: string;
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

/** Run 2.0（M0②）：任务对象（AcquisitionTask / TaskRun）。 */
export interface TaskRunView {
  id: string;
  runId: string | null;
  /** P1 attempt 维度：本次尝试对应的计划、任务内第 N 次尝试、重试来源（同任务同 plan 的上一 TaskRun）。 */
  planId?: string | null;
  attempt?: number;
  rerunOf?: string | null;
  trigger: 'manual' | 'schedule' | string;
  status: 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | string;
  startedAt: string;
  finishedAt: string | null;
}

export interface OutreachReplyView {
  id: string;
  contactRef: string;
  recipientEmail: string | null;
  kind: 'REPLY' | 'BOUNCE' | 'UNSUBSCRIBE' | string;
  classification: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'OUT_OF_OFFICE' | 'UNKNOWN' | string;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
}

export interface AcquisitionTaskView {
  id: string;
  icpId: string | null;
  name: string;
  status: 'active' | 'paused' | 'archived' | string;
  createdBy: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  runs: TaskRunView[];
}

export interface QueryPlan {
  id: string;
  icpId: string;
  status: string;
  queries: Array<Record<string, unknown>>;
  estimatedVolume?: number | null;
  /** 引擎对该计划的技术报价上限（美分）；读接口透出，页面做费用预期展示。 */
  estimatedCostCents?: number | null;
  version: number;
  createdAt: string;
}

export interface DiscoveryRun {
  id: string;
  planId: string;
  icpId: string;
  status: string;
  stats: Record<string, unknown>;
  /** Run 2.0（M0）：任务归因 {taskId, taskRunId}；旧 run 为 null。 */
  taskRef?: { taskId: string; taskRunId: string } | null;
  phases?: Record<string, unknown> | null;
  mode?: string;
  createdAt: string;
  completedAt?: string | null;
}

/** M1 渠道数据源：平台渠道注册表（状态/治理/最近运行）。 */
export interface SourceChannelView {
  id: string;
  name: string;
  mode: 'api' | 'crawl' | 'import' | string;
  category: string;
  status: 'DISABLED' | 'ENABLED' | 'AUTO_DISABLED' | string;
  license?: string | null;
  tosUrl?: string | null;
  robotsPolicy?: string | null;
  failureStreak: number;
  lastRunAt: string | null;
  runs: Array<{
    id: string;
    status: string;
    pagesFetched: number;
    recordsFound: number;
    recordsMaterialized: number;
    failures: number;
    errorCode: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
}

/** 租户可用渠道 + 本工作空间是否已启用。 */
export interface AvailableChannelView extends Omit<SourceChannelView, 'config' | 'runs'> {
  enabled: boolean;
}

/** M2 反馈闭环：ICP 建议卡与聚合。 */
export interface IcpSuggestion {
  type: string;
  dimension: 'source' | 'channel' | 'industry' | 'country' | string;
  key: string;
  sampleSize: number;
  acceptanceRate: number;
  message: string;
}

export interface IcpFeedbackReport {
  rows: Array<{
    dimension: string;
    dimensionKey: string;
    accepted: number;
    rejected: number;
    reasonCounts: Record<string, number>;
  }>;
  families: Array<{ queryFamily: string; samples: number; accepted: number; qualityEma: number }>;
  suggestions: IcpSuggestion[];
}

export interface ImportPreviewView {
  headers: string[];
  mapping: { name: string; domain?: string; website?: string; country?: string; industry?: string };
  totalRows: number;
  validRows: number;
  invalid: Array<{ rowNumber: number; reason: string }>;
  invalidCount: number;
  preview: { duplicate: number; suppressed: number };
  sample: Array<{ rowNumber: number; name: string; domain: string | null; country: string | null; industry: string | null }>;
}

export interface ImportResultView {
  batchId: string;
  totalRows: number;
  validRows: number;
  materialized: number;
  duplicates: number;
  suppressed: number;
  invalidCount: number;
}

/** M0⑤：run 进度事件（按 seq 增量拉取）。 */
export interface DiscoveryRunEvent {
  seq: number;
  at: string;
  level: string;
  type: string;
  payload: Record<string, unknown> | null;
}

export interface DiscoveryRunEventsPage {
  status: string;
  events: DiscoveryRunEvent[];
  nextAfter: number;
}

/** M0⑤：公司级 job 队列（快扫名单 + 深挖逐家状态）。 */
export interface DiscoveryRunJob {
  id: string;
  companyId: string;
  name: string | null;
  domain: string | null;
  country: string | null;
  stage: string;
  verdictQuick: string | null;
  verdictDeep: string | null;
  lastErrorCode: string | null;
  costCents: number;
  startedAt: string | null;
  finishedAt: string | null;
}

/** M2 步 9b-4：run 决策轨迹（过程时间线）——引擎 `agent_decision_trace` 的只读投影。 */
export interface DiscoveryRunTrace {
  id: string;
  stepType: string;
  agentKey: string;
  actorType: string;
  attempt: number;
  decisionType: string;
  chosenOption: Record<string, unknown> | null;
  score: number | null;
  reasonCode: string | null;
  evidence: Array<Record<string, unknown>>;
  rejectedCandidates: Array<Record<string, unknown>>;
  costEstimatedMicros: string | null;
  costActualMicros: string | null;
  createdAt: string;
}

/** SaaS 侧的 run → plan/ICP 引用，用于关闭页面后找回挖掘任务。 */
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
  /** 英文标题（en 界面优先；历史通知为空时回落中文 title）。 */
  titleEn?: string | null;
  readAt?: string | null;
  createdAt: string;
  link?: string;
}

export interface NotificationPage {
  unreadCount: number;
  items: AppNotification[];
}

export type SuppressionType = 'company_name' | 'domain' | 'email';
export type SuppressionReason = 'bounce' | 'complaint' | 'legal' | 'manual' | 'unsubscribe';

export interface SuppressionRecordView {
  createdAt: string;
  id: string;
  protectionClass: 'LEGAL' | 'PREFERENCE' | string;
  reason: SuppressionReason | string | null;
  type: SuppressionType | string;
  value: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
  current: boolean;
}

/** 工作空间上下文（SD11）：界面按 allowedActions 渲染，服务端仍是强校验方。 */
export interface WorkspaceContextView {
  user: { id: string; email: string };
  workspace: { id: string; name: string; role: 'admin' | 'member' };
  onboarding: { complete: boolean; companyId: string | null };
  allowedActions: string[];
}

/** 注册引导建档入参（与引擎 CreateCompanyDto 同构；name/website 至少一个）。 */
export interface OnboardingCompanyInput {
  name?: string;
  website?: string;
  industry?: string;
  targetMarkets?: string[];
  products?: string[];
  businessEmail?: string;
}

/** 企业档案建档入参（官网可选；无官网时必须给名称）。 */
export interface UpdateCompanyInput {
  name?: string;
  website?: string;
  industry?: string;
  targetMarkets?: string[];
  businessEmail?: string;
}

export interface SellerDocument {
  id: string;
  companyId?: string;
  filename: string;
  mime?: string;
  sizeBytes?: string | number;
  kind?: string;
  status: string;
  chunkCount?: number;
  processingErrorCode?: string | null;
  createdAt?: string;
}

export interface WebsiteCandidate {
  url: string;
  title: string;
  score: number;
}

export type CreateCompanyInput = OnboardingCompanyInput;

/** D6 历史：租户合法依据声明（2026-11-04 起只读留存，不再写入）。 */
export interface ComplianceDeclarationView {
  id: string;
  workspaceId: string;
  version: number;
  basis: 'legitimate_interest' | 'consent' | 'contract' | 'legal_obligation';
  ref?: string | null;
  note?: string | null;
  declaredBy: string;
  declaredAt: string;
}

/** 2026-11-04 取消租户声明：平台统一合法依据 + 只读历史（对应 BFF /settings/compliance）。 */
export interface ComplianceInfoView {
  platform: {
    basis: 'legitimate_interest' | 'consent' | 'contract' | 'legal_obligation';
    ref: string;
    note: string;
  };
  declarations: ComplianceDeclarationView[];
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
  audit: (
    params: { action?: string; cursor?: string; from?: string; limit?: number; to?: string } = {},
  ) =>
    requestClient.get<{ entries: AuditEntry[]; nextCursor?: null | string; total?: number }>(
      '/audit',
      { params },
    ),
  createDeletionRequest: (input: { subjectType: 'company' | 'contact'; subjectId: string; reason?: string; requestRef?: string }) =>
    requestClient.post<DeletionRequestView>('/deletion-requests', input),
  deletionRequest: (id: string) => requestClient.get<DeletionRequestView>(`/deletion-requests/${id}`),
  /** 2026-11-04 取消租户声明：平台统一合法依据 + 本工作空间只读历史。requestClient 已解包 {data}。 */
  complianceInfo: () => requestClient.get<ComplianceInfoView>('/settings/compliance'),
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
  createCompany: (input: CreateCompanyInput) =>
    requestClient.post<CompanyProfile>('/companies', input),
  retryCompanyUnderstanding: (companyId: string, attemptId: string) =>
    requestClient.post<CompanyProfile>(`/companies/${companyId}/understanding/retry`, { attemptId }),
  updateCompany: (companyId: string, input: UpdateCompanyInput) =>
    requestClient.patch<CompanyProfile>(`/companies/${companyId}`, input),
  deleteCompany: (companyId: string) =>
    requestClient.delete<{ id: string }>(`/companies/${companyId}`),
  companyWebsiteCandidates: (companyId: string) =>
    requestClient.post<WebsiteCandidate[]>(`/companies/${companyId}/website-candidates`, {}),
  presignSellerDocument: (companyId: string, input: { filename: string; mime: string; size: number }) =>
    requestClient.post<{ documentId: string; uploadUrl: string; expiresAt: string }>(
      `/companies/${companyId}/seller-documents/presign`,
      input,
    ),
  commitSellerDocument: (companyId: string, documentId: string) =>
    requestClient.post<SellerDocument>(`/companies/${companyId}/seller-documents/${documentId}/commit`, {}),
  sellerDocuments: (companyId: string, cursor?: string) =>
    requestClient.get<{ data: SellerDocument[]; page?: { next_cursor?: string; has_more?: boolean } }>(
      `/companies/${companyId}/seller-documents`,
      { params: cursor ? { cursor } : {} },
    ),
  searchSellerDocuments: (companyId: string, q: string, limit = 10) =>
    requestClient.get<Array<{ documentId: string; filename: string; seq: number; text: string; score: number }>>(
      `/companies/${companyId}/seller-documents/search`,
      { params: { q, limit } },
    ),
  retrySellerDocument: (documentId: string) =>
    requestClient.post<SellerDocument>(`/seller-documents/${documentId}/retry`, {}),
  deleteSellerDocument: (documentId: string) =>
    requestClient.delete<{ id: string }>(`/seller-documents/${documentId}`),
  sellerDocumentDownloadUrl: (documentId: string) =>
    requestClient.get<{ url: string; expiresAt: string }>(`/seller-documents/${documentId}/download-url`),
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
  /** P5：从公司档案（注册引导字段/产品）生成待审事实草稿（幂等）。 */
  synthesizeClaimDrafts: (companyId: string) =>
    requestClient.post<{ created: number; skipped: number; claims: CompanyClaim[] }>(
      `/onboarding/companies/${companyId}/claim-drafts`,
      {},
    ),
  approveClaim: (claimId: string) => requestClient.post<CompanyClaim>(`/claims/${claimId}/approve`, {}),
  rejectClaim: (claimId: string) => requestClient.post<CompanyClaim>(`/claims/${claimId}/reject`, {}),
  revokeClaim: (claimId: string) => requestClient.post<CompanyClaim>(`/claims/${claimId}/revoke`, {}),
  companyConflicts: (companyId: string) =>
    requestClient.get<CompanyConflict[]>(`/companies/${companyId}/conflicts`, { params: { status: 'OPEN' } }),
  resolveConflict: (conflictId: string, keep: 'a' | 'b') =>
    requestClient.post<CompanyConflict>(`/conflicts/${conflictId}/resolve`, { keep }),
  // ── 决策人（联系人挖掘 M4；引擎只对管理员身份的 compliance:manage 放行）──
  canonicalCompany: (companyId: string) =>
    requestClient.get<CanonicalCompanyDetail>(`/canonical-companies/${companyId}`),
  discoverContacts: (companyId: string, input: DiscoverContactsInput) =>
    requestClient.post<DiscoverContactsResult>(`/canonical-companies/${companyId}/discover-contacts`, input),
  guessEmails: (companyId: string, input: ContactComplianceInput & { maxContacts?: number; maxProbe?: number }) =>
    requestClient.post<GuessEmailsResult>(`/canonical-companies/${companyId}/guess-emails`, input),
  verifyContactPoint: (pointId: string, input?: ContactComplianceInput) =>
    requestClient.post<VerifyContactPointResult>(`/contact-points/${pointId}/verify`, input ?? {}),
  leads: (params: { icpId?: string; queue?: string; status?: string; limit?: number } = {}) =>
    requestClient.get<Lead[]>('/leads', { params }),
  leadPackage: (leadId: string) => requestClient.get<LeadPackage>(`/leads/${leadId}/package`),
  leadOutcome: (leadId: string, input: LeadOutcomeInput) =>
    requestClient.post<Record<string, unknown>>(`/leads/${leadId}/outcomes`, input),
  leadQueues: (icpId: string) =>
    requestClient.get<LeadQueueCounts>(`/icps/${icpId}/lead-queues`),
  acceptLead: (
    leadId: string,
    input: LeadDecisionInput = {},
    idempotencyKey?: string,
  ) =>
    requestClient.post<{ accepted: boolean; eventId: string }>(
      `/leads/${leadId}/accept`,
      input,
      idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
    ),
  rejectLead: (leadId: string, input: LeadDecisionInput, idempotencyKey?: string) =>
    requestClient.post<Lead>(
      `/leads/${leadId}/reject`,
      input,
      idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : undefined,
    ),
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
  // ── M2 步 10：商机域（QGO/SAO/Outcome）──
  qgos: (params: { state?: string; campaignId?: string; limit?: number; cursor?: string } = {}) =>
    requestClient.get<QgoView[]>('/qgos', { params }),
  qgo: (id: string) => requestClient.get<QgoView>(`/qgos/${id}`),
  promoteQgo: (input: PromoteQgoInput) =>
    requestClient.post<{ qgo: QgoView; created: boolean }>('/qgos', input),
  acceptQgo: (id: string) => requestClient.post<QgoView>(`/qgos/${id}/accept`, {}),
  declineQgo: (id: string, reason: string) => requestClient.post<QgoView>(`/qgos/${id}/decline`, { reason }),
  addQgoOutcome: (
    saoId: string,
    input: { outcome: QgoOutcomeValue; occurredAt?: string; note?: string; evidenceRef?: string },
  ) => requestClient.post<QgoOutcomeView>(`/saos/${saoId}/outcomes`, input),
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
  /** M2：ICP 反馈聚合与建议卡（只读）。 */
  icpFeedback: (icpId: string) => requestClient.get<IcpFeedbackReport>(`/icps/${icpId}/feedback`),
  createQueryPlan: (icpId: string, attemptId?: string) =>
    requestClient.post<QueryPlan>(`/icps/${icpId}/query-plans`, attemptId ? { attemptId } : {}),
  confirmQueryPlan: (planId: string) =>
    requestClient.post<QueryPlan>(`/query-plans/${planId}/confirm`, {}),
  executeQueryPlan: (planId: string, attemptId?: string) =>
    requestClient.post<{ runId: string; status: string }>(
      `/query-plans/${planId}/execute`,
      attemptId ? { attemptId } : {},
    ),
  /** Run 2.0（M0②）：任务列表（含最近运行）。 */
  acquisitionTasks: (icpId?: string) =>
    requestClient.get<AcquisitionTaskView[]>('/tasks', { params: icpId ? { icpId } : {} }),
  createAcquisitionTask: (input: { icpId?: string; name: string }) =>
    requestClient.post<AcquisitionTaskView>('/tasks', input),
  /**
   * 发起一次任务执行：SaaS 建 TaskRun，BFF 走 quote→Grant 调引擎 execute（带 taskRef）。
   * P1：attemptId 是前端在「用户意图」粒度生成的幂等键——双击复用同一键只算一次；
   * 引擎侧同键重放会被预算防重放拒绝，BFF 侧命中既有 TaskRun 时直接返回（replayed）。
   */
  startAcquisitionTaskRun: (taskId: string, planId: string, attemptId?: string) =>
    requestClient.post<{
      taskRunId: string;
      runId: string | null;
      status: string;
      attempt?: number;
      rerunOf?: string | null;
      replayed?: boolean;
    }>(`/tasks/${taskId}/runs`, attemptId ? { planId, attemptId } : { planId }),
  /** 回复收件箱：任何回复/退信/退订（append-only）。 */
  outreachReplies: () =>
    requestClient.get<{ data: OutreachReplyView[] }>('/outreach/replies'),

  discoveryRun: (runId: string) => requestClient.get<DiscoveryRun>(`/discovery-runs/${runId}`),
  /** M0⑤：增量拉取 run 事件（after=上次的 nextAfter；事件可重放）。 */
  runEvents: (runId: string, after = 0, limit = 200) =>
    requestClient.get<DiscoveryRunEventsPage>(`/discovery-runs/${runId}/events`, {
      params: { after, limit },
    }),
  /** M0⑤：run 的公司级队列（默认取第一页 200 家）。 */
  runJobs: (runId: string, limit = 200) =>
    requestClient.get<DiscoveryRunJob[]>(`/discovery-runs/${runId}/jobs`, { params: { limit } }),
  /** M2 步 9b-4：run 的「过程」时间线（键集分页；不传 cursor 即第一页）。 */
  runTrace: (runId: string, params: { limit?: number; cursor?: string } = {}) =>
    requestClient.get<{
      data: DiscoveryRunTrace[];
      page?: { next_cursor?: string | null; has_more?: boolean };
    }>(`/runs/${runId}/trace`, { params }),

  /** M0④/⑤：停止深挖（保留已完成结果；未完成公司下一次 run 重新排队）。 */
  cancelDiscoveryRun: (runId: string) =>
    requestClient.post<{ runId: string; status: string }>(`/discovery-runs/${runId}/cancel`, {}),
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
  // ── 设置 · 禁联名单（C2，M2 P6）：经 BFF 代理引擎 suppressions（admin）──
  suppressions: (params: { limit?: number; cursor?: string } = {}) =>
    requestClient.get<{ data: SuppressionRecordView[]; page?: { has_more?: boolean; next_cursor?: string } }>(
      '/suppressions',
      { params },
    ),
  createSuppression: (input: { type: SuppressionType; value: string; reason?: SuppressionReason }) =>
    requestClient.post<SuppressionRecordView>('/suppressions', input),
  /** 解除申请：引擎语义为 append-only release request（不物理删除），响应 deleted 恒为 false。 */
  requestSuppressionRelease: (id: string) =>
    requestClient.delete<{ deleted: boolean; releaseRequested: boolean; decisionId?: string }>(
      `/suppressions/${id}`,
    ),
  /** 注册策略（公开）：邀请码是否由部署侧启用。 */
  registrationPolicy: () =>
    requestClient.get<{ inviteCodeRequired: boolean }>('/auth/registration-policy'),
  /** 工作空间上下文（SD11）：角色、允许动作与引导状态。 */
  workspaceContext: () => requestClient.get<WorkspaceContextView>('/workspace/context'),
  /** M1：租户可用渠道（已批准）+ 是否已启用。平台渠道的注册/治理只属于运营台（P3）。 */
  availableChannels: () => requestClient.get<AvailableChannelView[]>('/source-channels/available'),
  enableChannel: (channelId: string) =>
    requestClient.post<{ channelId: string; enabled: boolean }>(`/source-channels/${channelId}/enable`, {}),
  disableChannel: (channelId: string) =>
    requestClient.delete<{ channelId: string; enabled: boolean }>(`/source-channels/${channelId}/enable`),
  importTemplate: () =>
    requestClient.get<{ csv: string; columns?: string[]; mapping?: Record<string, string> }>(
      '/source-channels/import-template',
    ),
  previewImport: (input: { csv: string; mapping: Record<string, string> }) =>
    requestClient.post<ImportPreviewView>('/imported-buyers/preview', input),
  commitImport: (input: { csv: string; mapping: Record<string, string>; channelId?: string }) =>
    requestClient.post<ImportResultView>('/imported-buyers', input),
  importedBuyers: (batchId: string) =>
    requestClient.get<Array<Record<string, unknown>>>(`/imported-buyers/${batchId}`),
  /** 注册引导：状态查询与一次性建档（quote → Grant → 引擎 POST /companies）。 */
  onboardingStatus: () =>
    requestClient.get<{ complete: boolean; companyId: string | null }>('/onboarding/status'),
  completeOnboarding: (input: OnboardingCompanyInput) =>
    requestClient.post<CompanyProfile>('/onboarding/company', input),
  // ── M2.1 Campaign 控制面（docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md）──
  campaigns: () => requestClient.get<CampaignSummary[]>('/campaigns'),
  campaign: (campaignId: string) => requestClient.get<CampaignDetail>(`/campaigns/${campaignId}`),
  createCampaign: (input: { name: string; objective?: string }) =>
    requestClient.post<CampaignSummary>('/campaigns', input),
  /** 触发一次受限规划（异步 job）；计划由引擎回调落成草稿 revision。 */
  createCampaignPlanDraft: (
    campaignId: string,
    input: {
      objective?: string;
      icpId?: string;
      audienceSizeCap?: number;
      budgetCapMicros?: number;
    } = {},
  ) =>
    requestClient.post<CampaignPlanJobView>(`/campaigns/${campaignId}/plan-drafts`, input),
  campaignPlanDraft: (campaignId: string, jobId: string) =>
    requestClient.get<CampaignPlanJobView>(`/campaigns/${campaignId}/plan-drafts/${jobId}`),
  submitCampaignRevision: (campaignId: string, revisionId: string) =>
    requestClient.post<{
      revision: { id: string; revisionNo: number; state: string };
      approval: { id: string; state: string; expiresAt: string };
    }>(`/campaigns/${campaignId}/revisions/${revisionId}/submit`, {}),
  decideCampaignApproval: (
    campaignId: string,
    approvalId: string,
    input: { decision: 'approve' | 'decline'; reason?: string },
  ) =>
    requestClient.post<{
      approval: { id: string; state: string; decidedBy: string | null; decidedAt: string | null };
      authorization: {
        id: string;
        state: string;
        expiresAt: string;
        maxUses: number;
      } | null;
    }>(`/campaigns/${campaignId}/approvals/${approvalId}/decide`, input),
  campaignTrace: (campaignId: string) =>
    requestClient.get<{ items: CampaignTraceEntry[]; nextCursor: string | null }>(
      `/campaigns/${campaignId}/trace`,
    ),
  notifications: () => requestClient.get<NotificationPage>('/notifications'),
  readNotification: (id: string) => requestClient.post<{ ok: boolean }>(`/notifications/${id}/read`, {}),
  readAllNotifications: () => requestClient.post<{ updated: number }>('/notifications/read-all', {}),
  deleteNotification: (id: string) => requestClient.delete<{ ok: boolean }>(`/notifications/${id}`),
  // ── M2 步 11-2：触达批次与草稿审批 ───────────────────────────────────────
  outreachBatches: () => requestClient.get<OutreachBatchSummary[]>('/outreach/batches'),
  outreachBatch: (batchId: string) =>
    requestClient.get<OutreachBatchDetail>(`/outreach/batches/${batchId}`),
  createOutreachBatch: (input: { name: string; campaignId?: string }) =>
    requestClient.post<OutreachBatchSummary>('/outreach/batches', input),
  addOutreachDraft: (batchId: string, input: OutreachDraftInput) =>
    requestClient.post<OutreachDraftView>(`/outreach/batches/${batchId}/drafts`, input),
  updateOutreachDraft: (batchId: string, draftId: string, input: OutreachDraftInput) =>
    requestClient.patch<OutreachDraftView>(
      `/outreach/batches/${batchId}/drafts/${draftId}`,
      input,
    ),
  removeOutreachDraft: (batchId: string, draftId: string) =>
    requestClient.delete<{ removed: boolean }>(
      `/outreach/batches/${batchId}/drafts/${draftId}`,
    ),
  submitOutreachBatch: (batchId: string) =>
    requestClient.post<OutreachApprovalView>(`/outreach/batches/${batchId}/submit`, {}),
  decideOutreachBatch: (
    batchId: string,
    approvalId: string,
    input: { decision: 'approve' | 'decline'; reason?: string },
  ) =>
    requestClient.post<OutreachBatchDetail>(
      `/outreach/batches/${batchId}/approvals/${approvalId}/decide`,
      input,
    ),
  reopenOutreachBatch: (batchId: string) =>
    requestClient.post<OutreachBatchDetail>(`/outreach/batches/${batchId}/reopen`, {}),
  // ── 判定复核队列（引擎 P3 J17；requestClient 已解一层 {data}，列表值是 {items,nextCursor}）──
  judgmentReviews: (
    params: { cursor?: string; limit?: number; priority?: number; status?: string } = {},
  ) => requestClient.get<JudgmentReviewTaskPage>('/judgment-reviews', { params }),
  claimJudgmentReview: (reviewId: string) =>
    requestClient.post<{ status: string }>(`/judgment-reviews/${reviewId}/claim`, {}),
  resolveJudgmentReview: (
    reviewId: string,
    input: { verdict: ReviewVerdict; note?: string; criterionOverrides?: Array<{ id: string; score?: number | null; label?: string }> },
  ) =>
    requestClient.post<{ recordId: string; goldenLabelId: string }>(
      `/judgment-reviews/${reviewId}/resolve`,
      input,
    ),
  judgment: (judgmentId: string) => requestClient.get<JudgmentDetail>(`/judgments/${judgmentId}`),
  judgmentStats: (window = 7) =>
    requestClient.get<JudgmentReviewStats>('/judgments/stats', { params: { window } }),
  // ── 度量（ch01 PR-04）：分页端点保留引擎 page 信封（游标/截断）──
  vricSeries: (
    params: { from?: string; granularity?: 'daily' | 'weekly'; limit?: number; to?: string } = {},
  ) => pagedGet<VricBucket>('/metrics/vric', params),
  metricCatalog: () => pagedGet<MetricCatalogItem>('/metrics/catalog'),
  metricObservations: (
    params: { cursor?: string; from?: string; limit?: number; metricId?: string; to?: string } = {},
  ) => pagedGet<MetricObservation>('/metrics/observations', params),
  metricRollups: (
    params: { cursor?: string; from?: string; granularity?: 'daily' | 'weekly'; limit?: number; metricId?: string; to?: string } = {},
  ) => pagedGet<MetricRollup>('/metrics/rollups', params),
};

export interface OutreachDraftInput {
  contactRef: string;
  recipientEmail: string;
  companyName?: string;
  subject: string;
  body: string;
}

export interface OutreachDraftView {
  id: string;
  batchId: string;
  contactRef: string;
  recipientEmail: string;
  companyName?: string | null;
  subject: string;
  body: string;
  status: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectionReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OutreachApprovalView {
  id: string;
  batchId: string;
  contentHash: string;
  state: string;
  requestedBy: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decisionReason?: string | null;
  expiresAt: string;
  createdAt?: string;
}

export interface OutreachBatchEventView {
  id: string;
  type: string;
  actor: string;
  detail?: unknown;
  createdAt: string;
}

export interface OutreachBatchSummary {
  id: string;
  name: string;
  status: string;
  campaignId?: string | null;
  draftCount: number;
  pendingApproval?: { id: string; expiresAt: string } | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OutreachBatchDetail {
  id: string;
  name: string;
  status: string;
  campaignId?: string | null;
  contentHash?: string | null;
  drafts: OutreachDraftView[];
  approvals: OutreachApprovalView[];
  events: OutreachBatchEventView[];
  submittedAt?: string | null;
  decidedAt?: string | null;
  queuedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ── M2 步 10：商机域（QGO/SAO/Outcome）──────────────────────────────────────
export interface QgoEvidenceItem {
  type: string;
  url?: string;
  retrievedAt?: string;
  support?: string;
}

export interface QgoOutcomeView {
  id: string;
  outcome: string;
  occurredAt: string;
  source: string;
  evidenceRef?: string | null;
  note?: string | null;
  createdAt: string;
}

export interface QgoView {
  id: string;
  leadRef: string;
  canonicalCompanyRef: string;
  icpRef: string | null;
  campaignId: string | null;
  title: string;
  score: number | null;
  evidence: QgoEvidenceItem[];
  nextStep: string;
  state: 'OPEN' | 'CONVERTED' | 'DROPPED' | string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  sao: { id: string; state: string; decidedAt: string; reason: string | null } | null;
  outcomes?: QgoOutcomeView[];
}

export interface PromoteQgoInput {
  leadRef: string;
  evidence: QgoEvidenceItem[];
  nextStep: string;
  campaignId?: string;
}

// ── 判定复核队列（引擎 P3 J17，BFF /judgment-reviews 与 /judgments）────────────
export type ReviewVerdict = 'FIT' | 'NOT_FIT' | 'UNKNOWN';

export interface JudgmentReviewTask {
  id: string;
  judgmentRecordId: string;
  reason: string;
  /** 0=P0 … 3=P3；展示前经 glossaryStatus('reviewPriority', String(priority))。 */
  priority: number;
  status: string;
  dueAt: string | null;
  verdictAtJudge: string;
  companyName: string | null;
}

export interface JudgmentReviewTaskPage {
  items: JudgmentReviewTask[];
  nextCursor: string | null;
}

export interface JudgmentCriterionEvidence {
  kind: string;
  url: string;
  span: string;
  fetched_at?: string;
}

export interface JudgmentCriterion {
  id: string;
  applicable: boolean;
  score: number | null;
  label: string;
  evidence: JudgmentCriterionEvidence[];
  rationale: string;
}

/** 单条判定明细（引擎 getJudgment：criteria/verdict/model/failureCode）。 */
export interface JudgmentDetail {
  id: string;
  verdict: string;
  criteria: JudgmentCriterion[];
  canonicalCompanyId: string;
  modelRequested: string | null;
  failureCode: string | null;
  createdAt: string;
}

export interface JudgmentReviewStats {
  windowDays: number;
  byStatus: Record<string, number>;
  byReason: Record<string, number>;
  byPriority: Record<string, number>;
  overturn: { resolved: number; overturned: number; rate: number | null };
}

// ── 度量（引擎 ch01 PR-04：catalog / observations / rollups / vric）────────────
/** 一桶一侧的口径值（STRICT=T0-001 / PLUS=T0-002）。 */
export interface VricValue {
  metricVersion: number;
  numerator: number;
  denominator: number | null;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  sampleN: number | null;
  refreshedAt: string;
}

/** VRIC 成对桶：同一 bucket + stratum 下 STRICT/PLUS 并排；缺哪侧哪侧为 null。 */
export interface VricBucket {
  bucket: string;
  stratumKey: string;
  strict: VricValue | null;
  plus: VricValue | null;
}

export interface MetricCatalogItem {
  metricId: string;
  version: number;
  name: string;
  tier: string;
  unit: string;
  status: string;
  owner: string;
  effectiveFrom: string;
  definition: string;
}

export interface MetricObservation {
  id: string;
  metricId: string;
  metricVersion: number;
  stratum: unknown;
  windowStart: string;
  windowEnd: string;
  numerator: number;
  denominator: number | null;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  sampleN: number | null;
  computedAt: string;
}

export interface MetricRollup {
  bucket: string;
  metricId: string;
  metricVersion: number;
  stratum: unknown;
  stratumKey: string;
  numerator: number;
  denominator: number | null;
  value: number;
  ciLow: number | null;
  ciHigh: number | null;
  sampleN: number | null;
  refreshedAt: string;
}

/** 引擎分页信封 `{data, page:{next_cursor,has_more}}`（requestClient 只解 data，会丢 page）。 */
export interface PagedResult<T> {
  data: T[];
  page?: { next_cursor?: string | null; has_more?: boolean };
}

/**
 * 分页只读端点的原样信封：用 baseRequestClient 保留 `page`（游标/截断标记）。
 * 返回 `response.data`——即 BFF 透传的引擎信封本体。
 */
async function pagedGet<T>(
  url: string,
  params: Record<string, unknown> = {},
): Promise<PagedResult<T>> {
  const response = await baseRequestClient.get<unknown>(url, { params });
  const body = (response as { data?: PagedResult<T> }).data;
  return { data: body?.data ?? [], ...(body?.page ? { page: body.page } : {}) };
}

export type QgoOutcomeValue =
  | 'REPLIED'
  | 'MEETING_BOOKED'
  | 'QUOTE_SENT'
  | 'WON'
  | 'LOST'
  | 'NO_RESPONSE'
  | 'DISQUALIFIED';

/** 引擎/合同错误信息提取(三层文案优先:发生了什么/为什么/怎么办;code 供技术详情折叠) */
export function failureText(error: unknown): {
  title: string;
  why: string | undefined;
  next: string | undefined;
  code?: string;
} {
  const detail = (error as { response?: { data?: { error?: { code?: string; userCopy?: { title?: string; why?: string; next?: string }; message?: string }; meta?: { engineCode?: string } } } })?.response?.data?.error;
  const code = detail?.code ?? (detail as { meta?: { engineCode?: string } } | undefined)?.meta?.engineCode;
  if (detail?.userCopy?.title) {
    return { title: detail.userCopy.title, why: detail.userCopy.why, next: detail.userCopy.next, code };
  }
  return { title: detail?.message ?? (error as Error)?.message ?? '请求失败，请稍后重试', why: undefined, next: undefined, code };
}
