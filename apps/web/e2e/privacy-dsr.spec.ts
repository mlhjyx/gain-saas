/**
 * 数据与隐私页（DSR）：买方 canonical-companies 选择器 + 服务端 deletion-requests 分页与状态筛选。
 */
import type { MockHandler } from './support/mock-backend';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const BUYER_1_ID = '11111111-1111-4111-8111-111111111111';
const BUYER_2_ID = '22222222-2222-4222-8222-222222222222';
const REQ_1_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQ_2_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQ_3_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function rawJson(make: (url: URL) => unknown, status = 200): MockHandler {
  return async ({ route, url }) => {
    await route.fulfill({
      body: JSON.stringify(make(url)),
      contentType: 'application/json',
      status,
    });
    return true;
  };
}

test('数据与隐私页：使用买家列表发起删除请求、展示 RECEIVED/COMPLETED、筛选与游标翻页且零 localStorage', async ({
  page,
}) => {
  const backend = await installMockBackend(page);

  const buyers = [
    { domain: 'rhein-cnc.de', id: BUYER_1_ID, name: 'Rhein CNC GmbH' },
    { domain: 'alpen-guss.at', id: BUYER_2_ID, name: 'Alpen Guss AG' },
  ];

  const rows: Array<Record<string, unknown>> = [
    {
      completedAt: '2026-11-25T10:05:00.000Z',
      createdAt: '2026-11-25T10:00:00.000Z',
      id: REQ_2_ID,
      reason: 'erasure',
      receipt: {
        companiesSuppressed: 1,
        contactPointsErased: 4,
        contactsErased: 2,
        createdAt: '2026-11-25T10:05:00.000Z',
        fieldEvidenceErased: 6,
        leadsRescoreRequested: 1,
        patentCacheErased: 0,
        ruleVersion: 'v1',
        signalsRevoked: 0,
      },
      status: 'COMPLETED',
      subjectId: BUYER_2_ID,
      subjectType: 'company',
    },
  ];

  const page2Row = {
    completedAt: null,
    createdAt: '2026-11-24T09:00:00.000Z',
    id: REQ_3_ID,
    reason: 'objection',
    receipt: null,
    status: 'FROZEN',
    subjectId: BUYER_2_ID,
    subjectType: 'company',
  };

  backend.set(
    'GET',
    '/canonical-companies',
    rawJson(() => ({
      data: buyers,
      page: { has_more: false, next_cursor: null },
    })),
  );

  backend.set(
    'GET',
    '/deletion-requests',
    rawJson((url) => {
      const status = url.searchParams.get('status');
      const cursor = url.searchParams.get('cursor');
      if (cursor === 'cursor-1') {
        return {
          data: [page2Row],
          page: { has_more: false, next_cursor: null },
        };
      }
      const filtered = status ? rows.filter((r) => r.status === status) : rows;
      return {
        data: filtered,
        page: status
          ? { has_more: false, next_cursor: null }
          : { has_more: true, next_cursor: 'cursor-1' },
      };
    }),
  );

  backend.set('POST', '/deletion-requests', async ({ body, route }) => {
    const payload = body as { reason?: string; requestRef?: string; subjectId: string; subjectType: string };
    const created = {
      completedAt: null,
      createdAt: '2026-11-25T12:00:00.000Z',
      id: REQ_1_ID,
      reason: payload.reason ?? 'erasure',
      receipt: null,
      requestRef: payload.requestRef ?? null,
      status: 'RECEIVED',
      subjectId: payload.subjectId,
      subjectType: payload.subjectType,
    };
    rows.unshift(created);
    await route.fulfill({
      body: JSON.stringify({ data: created }),
      contentType: 'application/json',
      status: 201,
    });
    return true;
  });

  await loginAs(page);
  await page.goto('/settings/privacy');

  // 1) 验证请求的是 GET /canonical-companies，而非 GET /companies
  await expect
    .poll(() => backend.callsTo('GET', '/canonical-companies').length)
    .toBeGreaterThan(0);
  expect(backend.callsTo('GET', '/companies').length).toBe(0);

  const card = page.locator('[data-gs="privacy-requests-card"]');
  await expect(card).toContainText('Alpen Guss AG');
  await expect(card).toContainText('已完成');
  await expect(card).toContainText('已清理联系人 2 · 联系方式 4 · 关联记录 6');

  // 2) 展开手动删除工具，选择买家公司并提交删除请求（返回 RECEIVED → 「已受理」）
  await page.locator('[data-gs="privacy-toggle-manual"]').click();
  await page.locator('[data-gs="privacy-buyer-select"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: 'Rhein CNC GmbH' }).click();
  await page.locator('[data-gs="privacy-submit"]').click();

  const postCall = backend.take('POST', '/deletion-requests');
  expect(postCall?.body).toMatchObject({
    reason: 'erasure',
    subjectId: BUYER_1_ID,
    subjectType: 'company',
  });

  await expect(card).toContainText('Rhein CNC GmbH');
  await expect(card).toContainText('已受理');

  // 3) 游标加载更多
  await page.locator('[data-gs="privacy-load-more"]').click();
  await expect(card).toContainText('已冻结禁联');
  const cursorCall = backend
    .callsTo('GET', '/deletion-requests')
    .find((call) => call.query.cursor === 'cursor-1');
  expect(cursorCall).toBeTruthy();

  // 4) 状态筛选
  await page.locator('[data-gs="privacy-status-filter"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: '已完成' }).click();
  await expect
    .poll(() =>
      backend
        .callsTo('GET', '/deletion-requests')
        .some((call) => call.query.status === 'COMPLETED'),
    )
    .toBe(true);
  await expect(card).not.toContainText('已受理');
  await expect(card).toContainText('已完成');

  // 5) 零 localStorage 读写 + 零裸 UUID 暴露
  const localStored = await page.evaluate(() => localStorage.getItem('gainos.dsr.requests.v1'));
  expect(localStored).toBeNull();
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});
