/**
 * Wave B3 设置页专属 API 封装（独立文件，与 gainos.ts 零碰撞）：
 * - GET /api/workspace/usage-summary（PR #215 实体与存储用量全景）
 * - GET /api/deletion-mirrors（B1 PR #233 级联清理回执只读接口，仅管理员）
 * - GET /api/suppressions/:id/decisions（既有 BFF 代理：禁联解除/更正审批决策历史，仅管理员）
 */
import { preferences } from '@vben/preferences';

import { baseRequestClient, requestClient } from './request';

export interface WorkspaceUsageSummaryView {
  canonicalCompanies?: { total: number };
  canonicalContacts?: { total: number };
  companies?: {
    active?: number;
    draft?: number;
    enriching?: number;
    review?: number;
    total: number;
  };
  discoveryRuns?: {
    completed?: number;
    failed?: number;
    running?: number;
    total: number;
  };
  icps?: {
    active?: number;
    total: number;
  };
  operationArtifacts?: {
    personalBytes?: number;
    personalCount?: number;
    total: number;
    totalBytes?: number;
  };
  saas?: {
    activeMembers: number;
    alertLevel: 'critical' | 'ok' | 'warning';
    campaigns: number;
    outreachSent30d: number;
    qgos: number;
    saos: number;
    storageQuota: {
      isDefault: boolean;
      maxBytesPerWorkspace: string;
      maxDocumentsPerCompany: number;
      maxDocumentsPerWorkspace: number;
      maxExportsPerDay: number;
    };
  };
  sellerDocuments?: {
    failed?: number;
    pendingUpload?: number;
    pendingUploadBytes?: number;
    processing?: number;
    quota?: {
      maxBytesPerWorkspace?: number;
      maxPerCompany?: number;
      maxPerWorkspace?: number;
    };
    ready?: number;
    readyBytes?: number;
    total: number;
    totalBytes: number;
  };
  siteAssets?: {
    total: number;
    totalBytes?: number;
  };
  siteReleases?: {
    total: number;
    totalBytes?: number;
  };
  workspaceId: string;
}

export interface DeletionMirrorReceiptView {
  at: string;
  engineRequestId: string;
  id: string;
  saasDeleted: number;
  status: string;
}

export interface DeletionMirrorPageView {
  hasMore: boolean;
  items: DeletionMirrorReceiptView[];
  nextCursor: string | null;
  total: number;
}

export interface SuppressionDecisionView {
  actorId?: string | null;
  createdAt: string;
  decision: string;
  id: string;
  reasonCode?: string | null;
  requestedDecision?: string | null;
  requestedReasonCode?: string | null;
  requestId?: string | null;
  suppressionId?: string;
}

export interface SuppressionDecisionPageView {
  data: SuppressionDecisionView[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

export async function fetchWorkspaceUsageSummary(): Promise<WorkspaceUsageSummaryView | null> {
  const res = await requestClient.get<WorkspaceUsageSummaryView | null>('/workspace/usage-summary');
  if (!res || typeof res !== 'object' || Array.isArray(res)) return null;
  return res;
}

export async function fetchDeletionMirrors(
  params: { cursor?: string; limit?: number; status?: string } = {},
): Promise<DeletionMirrorPageView> {
  const res = await requestClient.get<DeletionMirrorPageView | null>('/deletion-mirrors', {
    params,
  });
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return { hasMore: false, items: [], nextCursor: null, total: 0 };
  }
  const items = Array.isArray(res.items) ? res.items : [];
  return {
    hasMore: Boolean(res.hasMore && res.nextCursor),
    items,
    nextCursor: typeof res.nextCursor === 'string' ? res.nextCursor : null,
    total: typeof res.total === 'number' ? res.total : items.length,
  };
}

export async function fetchSuppressionDecisions(
  suppressionId: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<SuppressionDecisionPageView> {
  const response = await baseRequestClient.get<unknown>(
    `/suppressions/${encodeURIComponent(suppressionId)}/decisions`,
    {
      headers: { 'Accept-Language': preferences.app.locale },
      params,
      withCredentials: true,
    },
  );
  const raw = (response as { data?: unknown })?.data;
  const unwrapped =
    raw &&
    typeof raw === 'object' &&
    !('page' in raw) &&
    'data' in raw &&
    (raw as { data?: unknown }).data &&
    typeof (raw as { data?: unknown }).data === 'object'
      ? (raw as { data: unknown }).data
      : raw;

  if (Array.isArray(unwrapped)) {
    return {
      data: unwrapped as SuppressionDecisionView[],
      page: { has_more: false, next_cursor: null },
    };
  }
  const pageObj = unwrapped as
    | { data?: unknown; page?: { has_more?: boolean; next_cursor?: string | null } }
    | null
    | undefined;
  return {
    data: Array.isArray(pageObj?.data) ? (pageObj.data as SuppressionDecisionView[]) : [],
    page: {
      has_more: Boolean(pageObj?.page?.has_more && pageObj?.page?.next_cursor),
      next_cursor: typeof pageObj?.page?.next_cursor === 'string' ? pageObj.page.next_cursor : null,
    },
  };
}
