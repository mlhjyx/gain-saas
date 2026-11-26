/**
 * PR-OB1 端到端验收：
 * 1) /companies 标题统一为「企业档案」、72px 紧凑身份头（0 重复数字块、0 重复刷新键）与三一等分段（?tab=facts|documents|markets）；
 * 2) > 5 MiB 大画册走 presign(5 MiB) -> multipart/init -> 2+ 次 PUT .../parts/:partNumber -> multipart/complete -> commit；
 * 3) 上传中途切去 /workspace 再切回 /companies，右下角浮窗持续存在且不断传；
 * 4) > 30 MB 大画册非阻塞琥珀色温和提示，仍可继续分段上传；
 * 5) parsedMeta 先返 priority_pages（15/48 页、visionUsed）再返 full 自动刷新资料与待审事实（不清空未保存草稿），并过滤远端孤儿 pending_upload 噪声。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-27T01:00:00.000Z';
const FIVE_MIB = 5 * 1024 * 1024;

const PRIMARY_COMPANY = {
  created_at: NOW,
  domain: 'solar-peak.example.com',
  id: '11111111-1111-4111-8111-111111111111',
  industry: '新能源储能设备',
  name: '盛光新能源科技有限公司',
  status: 'REVIEW',
  summary: '专注工商业储能系统、逆变器与便携电源研发制造。',
  targetMarkets: ['DE', 'NL', 'AU'],
  website: 'https://solar-peak.example.com',
};

const COMPANY_ID = PRIMARY_COMPANY.id;

async function injectDropFile(
  page: import('@playwright/test').Page,
  name: string,
  sizeBytes: number,
  mime = 'application/pdf',
): Promise<void> {
  await page.evaluate(
    ({ fileMime, fileName, size }) => {
      const target = document.querySelector<HTMLElement>('[data-gs="docs-dropzone"]');
      if (!target) throw new Error('docs-dropzone not found');
      const bytes = new Uint8Array(size);
      // PDF 魔数头
      bytes[0] = 0x25;
      bytes[1] = 0x50;
      bytes[2] = 0x44;
      bytes[3] = 0x46;
      const file = new File([bytes], fileName, { type: fileMime });
      const dt = new DataTransfer();
      dt.items.add(file);
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      target.dispatchEvent(dropEvent);
    },
    { fileMime: mime, fileName: name, size: sizeBytes },
  );
}

test('PR-OB1：/companies 紧凑去重身份头、三一等分段（?tab=markets 直达）与直通买家画像 CTA', async ({
  page,
}) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/workspace/context', {
    allowedActions: [],
    onboarding: { companyId: COMPANY_ID, complete: true },
    user: backend.session.user,
    workspace: { ...backend.session.workspaces[0], role: 'admin' },
  });
  backend.set('GET', '/companies', [PRIMARY_COMPANY]);
  backend.set('GET', `/companies/${COMPANY_ID}`, PRIMARY_COMPANY);
  backend.set('GET', `/companies/${COMPANY_ID}/completeness`, {
    approvedClaims: 14,
    conflictsOpen: 0,
    offerings: 6,
    pendingClaims: 2,
  });
  backend.set('GET', `/companies/${COMPANY_ID}/offerings`, [
    { description: '215kWh 工商业储能一体柜', id: 'off-1', name: '工商业储能系统' },
  ]);
  backend.set('GET', `/companies/${COMPANY_ID}/conflicts`, []);
  backend.set('GET', `/companies/${COMPANY_ID}/claims`, [
    {
      companyId: COMPANY_ID,
      createdAt: NOW,
      id: 'claim-1',
      statement: '通过 IEC 62619 与 UN38.3 储能电池安全认证',
      status: 'NEEDS_REVIEW',
      type: 'certification',
      version: 1,
    },
  ]);
  backend.set('GET', `/companies/${COMPANY_ID}/market-candidate-sets/latest`, {
    status: 'NOT_ANALYZED',
  });

  await loginAs(page);
  await page.goto('/companies');

  // 1) H1 统一为「企业档案」，紧凑身份头无重复 4 块 KPI 与重复刷新按钮
  await expect(page.getByRole('heading', { level: 1, name: '企业档案', exact: true })).toBeVisible();
  const primary = page.locator('[data-gs="primary-company"]');
  await expect(primary).toBeVisible();
  await expect(primary.locator('.co-kpi')).toHaveCount(0);
  await expect(primary.locator('[data-gs="refresh"]')).toHaveCount(0);

  const primaryBox = await primary.boundingBox();
  expect(primaryBox?.height ?? 999, '紧凑企业身份头高度应精悍（<= 120px）').toBeLessThanOrEqual(120);

  // 工作台唯一刷新键存在，且三一等分段完整渲染
  await expect(page.locator('[data-gs="workspace-refresh"]')).toHaveCount(1);
  const segButtons = page.getByRole('group', { name: '企业档案工作台视图' }).getByRole('button');
  await expect(segButtons).toHaveText(['企业事实', '企业资料库', '目标市场']);

  // 2) 点击「目标市场」分段：同步 URL ?tab=markets 且页内直接渲染 MarketCandidatesPanel
  await segButtons.nth(2).click();
  await page.waitForURL(/\/companies\?.*tab=markets/);
  const marketsPane = page.locator('[data-gs="company-markets"]');
  await expect(marketsPane).toBeVisible();
  await expect(marketsPane.getByTestId('mc-panel-inline')).toBeVisible();
  await expect(marketsPane).toContainText('DE');

  // 3) 点击「带入目标市场新建买家画像」直跳 /find-buyers?action=create&companyId=...
  await marketsPane.locator('[data-gs="markets-create-buyer-profile"]').click();
  await page.waitForURL(new RegExp(`/find-buyers\\?.*action=create.*companyId=${COMPANY_ID}`));
  const createDialog = page.getByRole('dialog');
  await expect(createDialog.getByText(`${PRIMARY_COMPANY.name}（注册公司）`, { exact: true })).toBeVisible();
  await expect(createDialog.locator('[data-gs="icp-create-markets"]')).toHaveValue('DE, NL, AU');
});

test('PR-OB1：>5 MiB 分片上传跨页不断传、>30 MB 温和提示、前 15 页优先解析自动刷新且过滤 pending_upload', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const backend = await installMockBackend(page);
  backend.set('GET', '/workspace/context', {
    allowedActions: [],
    onboarding: { companyId: COMPANY_ID, complete: true },
    user: backend.session.user,
    workspace: { ...backend.session.workspaces[0], role: 'admin' },
  });
  backend.set('GET', '/companies', [PRIMARY_COMPANY]);
  backend.set('GET', `/companies/${COMPANY_ID}`, PRIMARY_COMPANY);
  backend.set('GET', `/companies/${COMPANY_ID}/completeness`, {
    approvedClaims: 4,
    conflictsOpen: 0,
    offerings: 2,
    pendingClaims: 1,
  });
  backend.set('GET', `/companies/${COMPANY_ID}/offerings`, [
    { description: '原有主营产品', id: 'off-1', name: '便携储能电源' },
  ]);
  backend.set('GET', `/companies/${COMPANY_ID}/conflicts`, []);

  const claimsList = [
    {
      companyId: COMPANY_ID,
      createdAt: NOW,
      id: 'claim-existing',
      statement: '已有工厂产能 2 GWh/年',
      status: 'NEEDS_REVIEW',
      type: 'capability',
      version: 1,
    },
  ];
  backend.set('GET', `/companies/${COMPANY_ID}/claims`, async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ data: claimsList }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  // 资料列表包含一条远端孤儿 pending_upload 噪声（必须被前端过滤不展示！）
  const serverDocs: Array<Record<string, unknown>> = [
    {
      chunkCount: 0,
      createdAt: NOW,
      filename: 'ghost-abandoned-upload.pdf',
      id: 'doc-orphan',
      sizeBytes: 980_000,
      status: 'pending_upload',
    },
    {
      chunkCount: 8,
      createdAt: NOW,
      filename: '原有产品手册.pdf',
      id: 'doc-existing',
      sizeBytes: 1_500_000,
      status: 'ready',
    },
  ];
  backend.set('GET', `/companies/${COMPANY_ID}/seller-documents`, async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ data: serverDocs, page: { has_more: false } }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  // 协调第 2 片上传闸门：让我们在上传进行中切去 /workspace，再放行第 2 片以验证跨页不断传！
  let releasePart2!: () => void;
  const part2Gate = new Promise<void>((resolve) => {
    releasePart2 = resolve;
  });
  let part2StartedResolve!: () => void;
  const part2Started = new Promise<void>((resolve) => {
    part2StartedResolve = resolve;
  });

  let presignSeq = 0;
  const uploadedParts: Array<{ documentId: string; partNumber: number; uploadId: string }> = [];
  let completedMultipartBody: unknown = null;

  backend.set('POST', `/companies/${COMPANY_ID}/seller-documents/presign`, async ({ route }) => {
    presignSeq += 1;
    const docId = `doc-mp-${presignSeq}`;
    await route.fulfill({
      body: JSON.stringify({
        data: {
          directUploadSupported: false,
          documentId: docId,
          expiresAt: '2026-11-27T02:00:00.000Z',
          partSizeBytes: FIVE_MIB,
          uploadMode: 'multipart',
          uploadUrl: `https://storage.local/staging/${docId}`,
        },
      }),
      contentType: 'application/json',
      status: 201,
    });
    return true;
  });

  for (const docId of ['doc-mp-1', 'doc-mp-2']) {
    backend.set(
      'POST',
      `/companies/${COMPANY_ID}/seller-documents/${docId}/multipart/init`,
      async ({ route }) => {
        await route.fulfill({
          body: JSON.stringify({
            data: {
              documentId: docId,
              partSizeBytes: FIVE_MIB,
              uploadId: `upload-${docId}`,
            },
          }),
          contentType: 'application/json',
          status: 201,
        });
        return true;
      },
    );

    for (let p = 1; p <= 8; p += 1) {
      backend.set(
        'PUT',
        `/companies/${COMPANY_ID}/seller-documents/${docId}/parts/${p}`,
        async ({ route, url }) => {
          const uploadId = url.searchParams.get('uploadId') ?? '';
          uploadedParts.push({ documentId: docId, partNumber: p, uploadId });
          if (docId === 'doc-mp-1' && p === 2) {
            part2StartedResolve();
            await part2Gate;
          }
          await route.fulfill({
            body: JSON.stringify({
              data: { etag: `"etag-${docId}-${p}"`, partNumber: p },
            }),
            contentType: 'application/json',
            status: 200,
          });
          return true;
        },
      );
    }

    backend.set(
      'POST',
      `/companies/${COMPANY_ID}/seller-documents/${docId}/multipart/complete`,
      async ({ body, route }) => {
        if (docId === 'doc-mp-1') completedMultipartBody = body;
        await route.fulfill({
          body: JSON.stringify({
            data: { filename: 'brochure-6mb.pdf', id: docId, status: 'pending_upload' },
          }),
          contentType: 'application/json',
          status: 200,
        });
        return true;
      },
    );

    backend.set(
      'POST',
      `/companies/${COMPANY_ID}/seller-documents/${docId}/commit`,
      async ({ route }) => {
        if (docId === 'doc-mp-1') {
          serverDocs.unshift({
            chunkCount: 15,
            createdAt: NOW,
            filename: 'brochure-6mb.pdf',
            id: 'doc-mp-1',
            parsedMeta: {
              aiClaimsCount: 9,
              aiProductsCount: 6,
              fullParsePending: true,
              mode: 'priority_pages',
              parsedPages: 15,
              totalPages: 48,
              visionUsed: true,
            },
            sizeBytes: 6 * 1024 * 1024 + 200_000,
            status: 'ready',
          });
        }
        await route.fulfill({
          body: JSON.stringify({
            data: { filename: 'brochure-6mb.pdf', id: docId, status: 'queued' },
          }),
          contentType: 'application/json',
          status: 200,
        });
        return true;
      },
    );
  }

  // 按资料 ID 读取状态，和 SaaS BFF 已有的详情路由一致。
  let polls = 0;
  backend.set('GET', '/seller-documents/doc-mp-1', async ({ route }) => {
    polls += 1;
    const document = serverDocs.find((row) => row.id === 'doc-mp-1');
    if (!document) throw new Error('Committed document fixture is missing');
    if (polls === 2) {
      claimsList.unshift({
        companyId: COMPANY_ID,
        createdAt: NOW,
        id: 'claim-ai-new',
        statement: '从 48 页画册新提取：支持 -30°C 低温液冷储能系统',
        status: 'NEEDS_REVIEW',
        type: 'capability',
        version: 1,
      });
      document.parsedMeta = {
        aiClaimsCount: 14,
        aiProductsCount: 9,
        fullParsePending: false,
        mode: 'full',
        parsedPages: 48,
        totalPages: 48,
        visionUsed: true,
      };
    }
    await route.fulfill({
      body: JSON.stringify({ data: document }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('GET', '/seller-documents/doc-mp-2', {
    filename: 'print-brochure-32mb.pdf',
    id: 'doc-mp-2',
    parsedMeta: { mode: 'full', parsedPages: 12, totalPages: 12 },
    status: 'ready',
  });

  await loginAs(page);
  await page.goto('/companies?tab=documents');

  // 验证孤儿 pending_upload 噪声被彻底隐藏
  const docsArea = page.locator('[data-gs="company-docs"]');
  await expect(docsArea).toBeVisible();
  await expect(docsArea).toContainText('原有产品手册.pdf');
  await expect(docsArea).not.toContainText('ghost-abandoned-upload.pdf');

  // 拖入 6.2 MiB 大画册（> 5 MiB -> 2 片 multipart 上传）
  await injectDropFile(page, 'brochure-6mb.pdf', 6 * 1024 * 1024 + 200_000);
  await part2Started;

  // 右下角全局浮窗出现并展示白话段进度（0 内部术语）
  const tray = page.locator('[data-gs="upload-queue-tray"]');
  await expect(tray).toBeVisible();
  await expect(tray).toContainText('brochure-6mb.pdf');
  await expect(tray).toContainText('第 2 / 2 段');
  await expect(tray).not.toContainText(/multipart|etag|Docling|pending_upload|chunk/i);

  // ★ 跨页不断传：上传进行中切去 /workspace，浮窗持续存在不卸载
  await page.getByRole('menuitem', { name: '工作台' }).click();
  await page.waitForURL(/\/workspace/);
  await expect(tray).toBeVisible();
  await expect(tray).toContainText('brochure-6mb.pdf');

  // 放行第 2 片，等待 multipart/complete + commit + priority_pages 轮询完成
  releasePart2();
  await expect(tray).toContainText('前 15 / 48 页已识别，可先确认产品', { timeout: 15_000 });
  await expect(tray).toContainText('已提取 6 个产品');
  await expect(tray.locator('[data-gs="upload-vision-badge"]')).toContainText(
    '已自动启用图文识别提取产品与要点',
  );
  await expect(tray.locator('[data-gs="upload-tray-safety"]')).toContainText(
    '文件已在云端识别，切换或关闭页面不受影响',
  );

  // 验证分片契约完全精准
  const mp1Parts = uploadedParts.filter((p) => p.documentId === 'doc-mp-1');
  expect(mp1Parts.map((p) => p.partNumber)).toEqual([1, 2]);
  expect(mp1Parts[0]?.uploadId).toBe('upload-doc-mp-1');
  expect(completedMultipartBody).toEqual({
    parts: [
      { etag: '"etag-doc-mp-1-1"', partNumber: 1 },
      { etag: '"etag-doc-mp-1-2"', partNumber: 2 },
    ],
    uploadId: 'upload-doc-mp-1',
  });

  // 从浮窗点「去确认产品」跳回 /companies?tab=facts，并在手动表单里写草稿测试不清空
  await tray.getByRole('button', { name: '去确认产品' }).click();
  await page.waitForURL(/\/companies\?.*tab=facts/);
  await page.getByRole('button', { name: '补充一条事实' }).click();
  const draftInput = page.locator('.cp__manual-form textarea');
  await draftInput.fill('用户正在手写中的未保存草稿');

  // 等待 10s 轮询推进到 full（48/48 页），验证自动刷新待审事实且绝不清空手写草稿
  await expect(tray).toContainText('全部 48 页识别完成', { timeout: 18_000 });
  await expect(page.locator('[data-gs="company-facts"]')).toContainText(
    '从 48 页画册新提取：支持 -30°C 低温液冷储能系统',
  );
  await expect(draftInput).toHaveValue('用户正在手写中的未保存草稿');

  // 切回企业资料库，测试 >30 MB 印刷级画册温和提示（非阻塞琥珀 GsAlert，且仍继续上传）
  await page
    .getByRole('group', { name: '企业档案工作台视图' })
    .getByRole('button', { name: '企业资料库' })
    .click();
  await injectDropFile(page, 'print-brochure-32mb.pdf', 32 * 1024 * 1024);

  const largeAlert = page.locator('[data-gs="large-pdf-alert"]');
  await expect(largeAlert).toBeVisible();
  await expect(largeAlert).toContainText('检测到较大画册');
  await expect(largeAlert).toContainText('32.0 MB');
  await expect(tray).toContainText('print-brochure-32mb.pdf');
});

test('另一标签页更换登录时清理旧上传，并提示刷新后再上传', async ({ context, page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/workspace/context', {
    allowedActions: [],
    onboarding: { companyId: COMPANY_ID, complete: true },
    user: backend.session.user,
    workspace: { ...backend.session.workspaces[0], role: 'admin' },
  });
  backend.set('GET', '/companies', [PRIMARY_COMPANY]);
  const prefix = `/companies/${COMPANY_ID}/seller-documents`;
  backend.set('POST', `${prefix}/presign`, { documentId: 'doc-tab-test', partSizeBytes: FIVE_MIB });
  let releaseUpload!: () => void;
  const heldUpload = new Promise<void>((resolve) => { releaseUpload = resolve; });
  backend.set('PUT', `${prefix}/doc-tab-test/content`, async ({ route }) => {
    await heldUpload;
    await route.fulfill({ status: 200 }).catch(() => {});
    return true;
  });

  await loginAs(page);
  await page.goto('/companies?tab=documents');
  await expect(page.locator('[data-gs="docs-dropzone"]')).toBeVisible();
  try {
    await injectDropFile(page, 'account-switch.pdf', 1024);
    await expect.poll(() => backend.callsTo('PUT', `${prefix}/doc-tab-test/content`).length).toBe(1);
    await expect(page.locator('[data-gs="upload-queue-tray"]')).toBeVisible();

    const otherTab = await context.newPage();
    await installMockBackend(otherTab);
    await otherTab.goto('/workspace');
    await otherTab.locator('[data-gs="account-trigger"]').click();
    await otherTab.getByRole('menuitem', { name: '退出登录' }).click();
    await otherTab.waitForURL(/\/auth\/login/);
    await expect(page.locator('[data-gs="upload-queue-tray"]')).toHaveCount(0);
    await loginAs(otherTab, 'new-session@example.test');
    await otherTab.close();
    releaseUpload();
    await expect(page.locator('[data-gs="upload-queue-tray"]')).toHaveCount(0);
    await injectDropFile(page, 'should-wait.pdf', 1024);
    await expect(page.getByRole('alert')).toContainText('请刷新页面后再上传');
    expect(backend.callsTo('POST', `${prefix}/presign`)).toHaveLength(1);
    expect(backend.callsTo('POST', `${prefix}/doc-tab-test/commit`)).toHaveLength(0);
  } finally {
    releaseUpload();
  }
});
