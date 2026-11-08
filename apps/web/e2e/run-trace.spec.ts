/**
 * M2 步 9b-4 / 14-3：run「寻源过程」渲染断言（零术语红线 + 技术详情折叠）。
 *
 * 轨迹数据形状取自引擎 #880 真实响应（agent_decision_trace 租户只读面）：
 * source.route 选源/跳过；fit.judge 批量判定与被否候选（candidateRef 为公司 UUID，绝不能上屏）。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-08T10:12:30.000Z';
const COMPANY_UUID = 'f813bd46-f52b-43ed-9cd3-3c83a428ccd7';

const TRACE_ROWS = [
  {
    actorType: 'agent',
    agentKey: 'discovery.source_scout',
    attempt: 1,
    chosenOption: { sourceClass: 'company_registry', sources: ['wikidata', 'ted'] },
    costActualMicros: null,
    costEstimatedMicros: null,
    createdAt: NOW,
    decisionType: 'source.route',
    evidence: [],
    id: 'trace-1',
    reasonCode: null,
    rejectedCandidates: [
      { candidateRef: 'openstreetmap', rejectReason: 'SOURCE_DISABLED', revivable: true },
    ],
    score: null,
    stepType: 'discovery.query',
  },
  {
    actorType: 'agent',
    agentKey: 'discovery.qualifier',
    attempt: 2,
    chosenOption: { batchSize: 8, judged: 8, verdicts: { match: 1, mismatch: 6, weak: 1 } },
    costActualMicros: null,
    costEstimatedMicros: null,
    createdAt: NOW,
    decisionType: 'fit.judge',
    evidence: [],
    id: 'trace-2',
    reasonCode: null,
    rejectedCandidates: [
      { candidateRef: COMPANY_UUID, rejectReason: 'VERDICT_MISMATCH', revivable: true },
      { candidateRef: '353f2494-2306-4b16-8577-22a119185f1c', rejectReason: 'VERDICT_MISMATCH', revivable: true },
      { candidateRef: 'f4814bb9-70e2-425a-a7b4-9a389b4f3dd8', rejectReason: 'VERDICT_MISMATCH', revivable: true },
      { candidateRef: 'ca68a2f1-3064-4d52-a579-a69a125ad25c', rejectReason: 'VERDICT_MISMATCH', revivable: true },
      { candidateRef: '960bac1f-12a1-433e-a83c-a4ce7e41e99c', rejectReason: 'VERDICT_MISMATCH', revivable: true },
      { candidateRef: 'c8d9edc4-b527-40f3-9c83-2b940f972726', rejectReason: 'VERDICT_MISMATCH', revivable: true },
    ],
    score: null,
    stepType: 'discovery.quick_scan',
  },
  {
    actorType: 'agent',
    agentKey: 'discovery.unregistered_agent',
    attempt: 1,
    chosenOption: null,
    costActualMicros: null,
    costEstimatedMicros: null,
    createdAt: NOW,
    decisionType: 'mystery.decision',
    evidence: [],
    id: 'trace-3',
    reasonCode: 'SOME_NEW_CODE',
    rejectedCandidates: [],
    score: null,
    stepType: 'discovery.query',
  },
];

test('寻源过程：人话时间线、无裸值（UUID/引擎标识不上屏）、技术详情折叠', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/discovery-runs/run-1', {
    createdAt: NOW,
    id: 'run-1',
    icpId: 'icp-1',
    mode: 'quick',
    planId: 'plan-1',
    stats: {},
    status: 'RUNNING',
  });
  backend.set('GET', '/discovery-runs/run-1/jobs', []);
  backend.set('GET', '/discovery-runs/run-1/events', { events: [], nextAfter: 0, status: 'RUNNING' });
  backend.set('GET', '/runs/run-1/trace', {
    data: TRACE_ROWS,
    page: { has_more: false, next_cursor: null },
  });

  await loginAs(page);
  await page.goto('/runs/run-1');

  await expect(page.getByRole('heading', { name: '寻源过程' })).toBeVisible();
  // 选源：采用/跳过都用人话名称
  await expect(page.getByText('源侦察员 · 选择数据源')).toBeVisible();
  await expect(page.getByText('采用的源：维基数据、TED 招标公告')).toBeVisible();
  await expect(page.getByText('跳过的源：OpenStreetMap 地图（已停用）')).toBeVisible();
  // 判定：批次进度、结论与被否计数；重试尝试有徽标
  await expect(page.getByText('资格判定员 · 批量判定')).toBeVisible();
  await expect(page.getByText('第 2 次尝试')).toBeVisible();
  await expect(page.getByText('判定 8/8 家')).toBeVisible();
  await expect(page.getByText('匹配 1 · 待定 1 · 不符 6')).toBeVisible();
  await expect(page.getByText('未通过：判定不符 6 家')).toBeVisible();
  // 未登记值回退人话
  await expect(page.getByText('智能体 · 决策')).toBeVisible();
  await expect(page.getByText('原因：其它原因')).toBeVisible();

  // 红线：可见文本不含裸 UUID、引擎标识/原因码（技术详情默认收起）
  const visible = await page.locator('main').innerText();
  for (const banned of [
    COMPANY_UUID,
    'openstreetmap',
    'wikidata',
    'source.route',
    'fit.judge',
    'VERDICT_MISMATCH',
    'SOME_NEW_CODE',
    'discovery.source_scout',
  ]) {
    expect(visible, `可见文本不应包含 ${banned}`).not.toContain(banned);
  }

  // 技术详情：展开后才可见原始决策类型/智能体标识
  const tech = page.locator('.run__trace-tech').first();
  await expect(tech.locator('summary')).toHaveText('技术详情');
  await tech.locator('summary').click();
  await expect(tech.getByText('source.route', { exact: true })).toBeVisible();
  await expect(tech.getByText('discovery.source_scout', { exact: true })).toBeVisible();
});
