import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { baseGetMock, requestGetMock, requestPostMock } = vi.hoisted(() => ({
  baseGetMock: vi.fn(),
  requestGetMock: vi.fn(),
  requestPostMock: vi.fn(),
}));

vi.mock('#/api/request', () => ({
  baseRequestClient: {
    get: baseGetMock,
  },
  requestClient: {
    delete: vi.fn(),
    get: requestGetMock,
    patch: vi.fn(),
    post: requestPostMock,
    request: vi.fn(),
  },
}));

vi.mock('@vben/hooks', () => ({
  useAppConfig: () => ({ apiURL: '/api' }),
}));

vi.mock('@vben/preferences', () => ({
  preferences: {
    app: {
      locale: 'zh-CN',
    },
  },
}));

import { gainosApi } from '#/api/gainos';
import { GROWTH_PAGE_HIDDEN } from '#/feature-flags';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj)
    .flatMap(([key, value]) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? flattenKeys(value as Record<string, unknown>, prefix ? `${prefix}.${key}` : key)
        : [prefix ? `${prefix}.${key}` : key],
    )
    .sort();
}

describe('Wave 1: GROWTH_PAGE_HIDDEN, gainosApi 接线与 gainosUi2 双语对称性', () => {
  beforeEach(() => {
    baseGetMock.mockReset();
    requestGetMock.mockReset();
    requestPostMock.mockReset();
  });

  it('GROWTH_PAGE_HIDDEN 已开放为 false', () => {
    expect(GROWTH_PAGE_HIDDEN).toBe(false);
  });

  it('gainosUi2.json 中英文键 100% 对称', () => {
    const zh = JSON.parse(
      readFileSync(resolve(__dirname, '../../locales/langs/zh-CN/gainosUi2.json'), 'utf8'),
    ) as Record<string, unknown>;
    const en = JSON.parse(
      readFileSync(resolve(__dirname, '../../locales/langs/en-US/gainosUi2.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(flattenKeys(zh)).toEqual(flattenKeys(en));
  });

  it('getCompanySignals / getSourceYieldMetrics 透传分页信封且走 baseRequestClient', async () => {
    baseGetMock.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'sig-1',
            providerKey: 'rss',
            signalKind: 'rss_item',
            sourceUrl: 'https://acme.de/news/1',
            title: 'Expanded Plant',
            excerpt: 'New line opened',
            observedAt: '2026-11-28T08:00:00.000Z',
          },
        ],
        page: { has_more: false, next_cursor: null },
      },
    });
    const signals = await gainosApi.getCompanySignals('comp-1', { limit: 10 });
    expect(baseGetMock).toHaveBeenCalledWith(
      '/companies/comp-1/signals',
      expect.objectContaining({ params: { limit: 10 } }),
    );
    expect(signals.data).toHaveLength(1);
    expect(signals.data[0]?.title).toBe('Expanded Plant');

    baseGetMock.mockResolvedValueOnce({
      data: {
        data: [
          {
            bucket: '2026-11-23',
            providerKey: 'google_places',
            recordCount: 40,
            newQualifiedCount: 8,
            costMicrousd: 1_200_000,
            costPerNewQualifiedUsd: 0.15,
          },
        ],
        page: { has_more: false, next_cursor: null },
      },
    });
    const yieldPage = await gainosApi.getSourceYieldMetrics({ granularity: 'week', limit: 50 });
    expect(baseGetMock).toHaveBeenCalledWith(
      '/metrics/source-yield',
      expect.objectContaining({ params: { granularity: 'week', limit: 50 } }),
    );
    expect(yieldPage.data[0]?.costPerNewQualifiedUsd).toBe(0.15);
  });

  it('getCompanyLegalLinks / recomputeCompanyUnderstanding / recomputeIcpFeedback / rejudgeIcp 正确调用对应路径', async () => {
    requestGetMock.mockResolvedValueOnce([]);
    await gainosApi.getCompanyLegalLinks('comp-1');
    expect(requestGetMock).toHaveBeenCalledWith(
      '/companies/comp-1/legal-links',
      expect.objectContaining({ silentErrorToast: true }),
    );

    requestPostMock.mockResolvedValueOnce({
      companyId: 'comp-1',
      status: 'ACTIVE',
      documentsScanned: 2,
      draftsCreated: 3,
      profileDraftsCreated: 1,
    });
    await gainosApi.recomputeCompanyUnderstanding('comp-1');
    expect(requestPostMock).toHaveBeenCalledWith(
      '/companies/comp-1/understanding/recompute',
      {},
      expect.objectContaining({ silentErrorToast: true }),
    );

    requestPostMock.mockResolvedValueOnce({ ok: true });
    await gainosApi.recomputeIcpFeedback('icp-1');
    expect(requestPostMock).toHaveBeenCalledWith(
      '/icps/icp-1/feedback/recompute',
      {},
      expect.objectContaining({ silentErrorToast: true }),
    );

    requestPostMock.mockResolvedValueOnce({
      rejudgeId: 'rej-1',
      icpId: 'icp-1',
      status: 'ACCEPTED',
      candidateCount: 12,
      batchCount: 1,
      estimatedCostMicros: '50000',
      refreshCorroboration: true,
      refreshWebsiteProfile: false,
    });
    await gainosApi.rejudgeIcp('icp-1');
    const rejudgeCall = requestPostMock.mock.calls.at(-1);
    expect(rejudgeCall?.[0]).toBe('/icps/icp-1/rejudge');
    expect(typeof (rejudgeCall?.[1] as { attemptId?: unknown })?.attemptId).toBe('string');
    expect(((rejudgeCall?.[1] as { attemptId?: string })?.attemptId ?? '').length).toBeGreaterThan(0);
  });

  it('getWeeklyReport 解析 BOM、X-Report-* 响应头与引号转义 CSV 预览行', async () => {
    const csv =
      '\uFEFF公司名,域名,国家,贸易角色,贸易角色置信度,自有制造,在售品牌（中国）,在售品牌（非中国，含产地）,登记号,税号,为什么现在,Fit 分,角色分,意图分,数据质量分,可达性分,互动分,总分\r\n' +
      '"\'=Evil, GmbH",evil.de,DE,,,,,,,,,,,,,,,0.91\r\n' +
      'Nordic Pumps AB,nordic.se,SE,,,,,,,,,,,,,,,0.84\r\n';
    baseGetMock.mockResolvedValueOnce({
      data: csv,
      headers: {
        'content-disposition': 'attachment; filename="weekly-report-2026-W48-icp1.csv"',
        'x-report-id': 'rep-9',
        'x-report-week': '2026-W48',
        'x-report-rows': '2',
        'x-report-withheld-rights': '1',
        'x-report-withheld-sanctions': '0',
        'x-report-withheld-quarantined': '2',
      },
    });
    const summary = await gainosApi.getWeeklyReport({ icpId: 'icp-1' });
    expect(baseGetMock).toHaveBeenCalledWith(
      '/reports/weekly',
      expect.objectContaining({ params: { icpId: 'icp-1' }, responseType: 'text' }),
    );
    expect(summary).toMatchObject({
      reportId: 'rep-9',
      week: '2026-W48',
      rows: 2,
      withheld: { rights: 1, sanctions: 0, quarantined: 2 },
      filename: 'weekly-report-2026-W48-icp1.csv',
      previewRows: [
        { companyName: '=Evil, GmbH', domain: 'evil.de', country: 'DE', score: '0.91' },
        { companyName: 'Nordic Pumps AB', domain: 'nordic.se', country: 'SE', score: '0.84' },
      ],
    });
  });
});
