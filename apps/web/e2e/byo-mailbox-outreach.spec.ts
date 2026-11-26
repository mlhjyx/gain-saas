/**
 * M9-PR3 企业自有外联发信箱与 DNS 核验独立 E2E（100% spec 内自包含 page.route mock，不改 mock-backend.ts）：
 * 覆盖 /settings/outreach-mailboxes：新增发信箱、配置加密凭据（绝不回显密码）、连通性自检、
 * Google OAuth2 授权启动、SPF/DKIM/DMARC/MX DNS 实时核验与模板展示、零裸 UUID 与零术语红线。
 */
import type { Page, Route } from '@playwright/test';

import { expect, test } from '@playwright/test';

const MAILBOX_ID = '11111111-cccc-4ccc-8ccc-111111111111';
const DOMAIN_ID = '22222222-cccc-4ccc-8ccc-222222222222';

async function installSelfContainedMock(
  page: Page,
  handlers: Record<
    string,
    (ctx: { body: unknown; route: Route; url: URL }) => Promise<void> | void
  >,
): Promise<void> {
  let signedIn = false;
  const session = {
    user: { email: 'byo-e2e@gainos.local', id: 'user-byo' },
    workspace: { id: 'ws-byo', role: 'admin' },
    workspaces: [{ id: 'ws-byo', name: '外联测试企业', role: 'admin' }],
  };

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const defaultOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || 4173}`;
    if (url.origin !== (process.env.PLAYWRIGHT_BASE_URL ?? defaultOrigin)) {
      await route.continue();
      return;
    }
    if (req.isNavigationRequest() && req.resourceType() === 'document') {
      await route.continue();
      return;
    }
    const path = url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname;
    const method = req.method().toUpperCase();
    if (
      method === 'GET' &&
      (path === '/' ||
        path.startsWith('/assets/') ||
        /\.(?:css|ico|js|json|map|png|svg|woff2?)$/.test(path))
    ) {
      await route.continue();
      return;
    }

    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }

    const exact = handlers[`${method} ${path}`];
    if (exact) {
      await exact({ body, route, url });
      return;
    }

    const json = (payload: unknown, status = 200) =>
      route.fulfill({
        body: JSON.stringify(payload),
        contentType: 'application/json',
        status,
      });

    if (method === 'POST' && path === '/auth/login') {
      signedIn = true;
      await json({ data: session });
      return;
    }
    if (method === 'GET' && path === '/auth/registration-policy') {
      await json({ data: { inviteCodeRequired: false } });
      return;
    }
    if (method === 'GET' && path === '/auth/session') {
      if (!signedIn) {
        await json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401);
        return;
      }
      await json({ data: session });
      return;
    }
    if (method === 'GET' && path === '/onboarding/status') {
      await json({ data: { complete: true } });
      return;
    }
    if (method === 'GET' && path === '/workspace/context') {
      await json({
        data: {
          allowedActions: [],
          onboarding: { companyId: null, complete: true },
          user: session.user,
          workspace: { id: 'ws-byo', name: '外联测试企业', role: 'admin' },
        },
      });
      return;
    }
    if (method === 'GET' && path === '/notifications') {
      await json({ data: { items: [], unreadCount: 0 } });
      return;
    }
    if (method === 'GET' && path === '/workspaces') {
      await json({ data: session.workspaces });
      return;
    }
    await json({ data: method === 'GET' ? [] : {} });
  });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/auth\/login/);
  await page.locator('input[type="email"]').fill('byo-e2e@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();
  await page.waitForURL(/\/workspace|\/onboarding/);
}

test('BYO 外联发信箱与域名 DNS 自检端到端流程（无明文凭据回显、零裸 UUID）', async ({ page }) => {
  const mailboxes: Array<Record<string, unknown>> = [];
  const domains: Array<Record<string, unknown>> = [];
  let savedCredPayload: Record<string, unknown> | null = null;
  let testConnCalled = 0;

  await installSelfContainedMock(page, {
    'GET /outreach/mailboxes': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({ data: mailboxes }),
        contentType: 'application/json',
        status: 200,
      });
    },
    'POST /outreach/mailboxes': async ({ body, route }) => {
      const input = body as { address: string; displayName: string; warmupStage?: string };
      const domainName = input.address.split('@')[1] ?? 'exporter.example';
      const mb = {
        address: input.address,
        authMode: 'password',
        createdAt: '2026-11-26T10:00:00.000Z',
        credentialsKeyId: null,
        credentialsUpdatedAt: null,
        dailyCap: 10,
        displayName: input.displayName,
        domainId: DOMAIN_ID,
        hasCredentials: false,
        healthState: 'CLOSED',
        id: MAILBOX_ID,
        imapHost: null,
        imapMailbox: 'INBOX',
        imapPort: null,
        imapSecure: true,
        lastSendAt: null,
        lastVerifiedAt: null,
        lastVerifyError: null,
        lastVerifyStatus: null,
        oauthConnected: false,
        oauthTokenExpiresAt: null,
        provider: 'smtp',
        smtpHost: null,
        smtpPort: null,
        smtpSecure: true,
        state: 'ACTIVE',
        timezone: 'Europe/Berlin',
        warmupStage: input.warmupStage ?? 'W1',
        weeklyCap: 50,
        workspaceId: 'ws-byo',
      };
      mailboxes.push(mb);
      if (domains.length === 0) {
        domains.push({
          createdAt: '2026-11-26T10:00:00.000Z',
          dkimSelector: 'google',
          dnsReady: false,
          dnsReport: null,
          dnsVerifiedAt: null,
          domain: domainName,
          id: DOMAIN_ID,
          kind: 'cold_outbound',
          state: 'ACTIVE',
          workspaceId: 'ws-byo',
        });
      }
      await route.fulfill({
        body: JSON.stringify({ data: mb }),
        contentType: 'application/json',
        status: 201,
      });
    },
    [`POST /outreach/mailboxes/${MAILBOX_ID}/credentials`]: async ({ body, route }) => {
      savedCredPayload = body as Record<string, unknown>;
      Object.assign(mailboxes[0]!, {
        credentialsKeyId: 'k1',
        credentialsUpdatedAt: '2026-11-26T10:05:00.000Z',
        hasCredentials: true,
        imapHost: savedCredPayload.imapHost,
        imapPort: savedCredPayload.imapPort,
        smtpHost: savedCredPayload.smtpHost,
        smtpPort: savedCredPayload.smtpPort,
      });
      await route.fulfill({
        body: JSON.stringify({ data: mailboxes[0] }),
        contentType: 'application/json',
        status: 200,
      });
    },
    [`POST /outreach/mailboxes/${MAILBOX_ID}/test-connection`]: async ({ route }) => {
      testConnCalled += 1;
      Object.assign(mailboxes[0]!, {
        lastVerifiedAt: '2026-11-26T10:06:00.000Z',
        lastVerifyError: null,
        lastVerifyStatus: 'OK',
      });
      await route.fulfill({
        body: JSON.stringify({
          data: {
            imap: { latencyMs: 42, ok: true },
            mailboxId: MAILBOX_ID,
            ready: true,
            smtp: { latencyMs: 38, ok: true },
            verifiedAt: '2026-11-26T10:06:00.000Z',
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
    [`POST /outreach/mailboxes/${MAILBOX_ID}/oauth/google/start`]: async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=enc-state-demo',
            provider: 'google',
            stateExpiresAt: '2026-11-26T10:16:00.000Z',
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
    'GET /outreach/domains': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({ data: domains }),
        contentType: 'application/json',
        status: 200,
      });
    },
    [`POST /outreach/domains/${DOMAIN_ID}/verify-dns`]: async ({ route }) => {
      const report = {
        dkim: { present: true, selector: 'google' },
        dmarc: {
          hasRua: true,
          pct: 100,
          policy: 'quarantine',
          present: true,
          record: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@exporter.example',
        },
        domain: 'exporter.example',
        mx: [{ exchange: 'aspmx.l.google.com', priority: 1 }],
        ok: { dkim: true, dmarc: true, mx: true, spf: true },
        ready: true,
        spf: {
          present: true,
          qualifier: '~all',
          record: 'v=spf1 include:_spf.google.com ~all',
        },
      };
      Object.assign(domains[0]!, {
        dnsReady: true,
        dnsReport: report,
        dnsVerifiedAt: '2026-11-26T10:07:00.000Z',
      });
      await route.fulfill({
        body: JSON.stringify({
          data: {
            advice: { level: 'ready', summary: 'DNS 配置就绪' },
            domain: domains[0],
            report,
            template: 'exporter.example. TXT "v=spf1 include:_spf.google.com ~all"',
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
  });

  await signIn(page);
  await page.goto('/settings/outreach-mailboxes');

  const panel = page.locator('[data-gs="byo-mailbox-panel"]');
  await expect(panel).toBeVisible();

  // 1. 新增企业发信箱
  await page.locator('[data-gs="byo-create-address"]').fill('sales@exporter.example');
  await page.locator('[data-gs="byo-create-display-name"]').fill('Anna Sales');
  await page.locator('[data-gs="byo-create-submit"]').click();
  await expect(page.locator('[data-gs="byo-mailbox-list-card"]')).toContainText(
    'sales@exporter.example',
  );

  // 2. 配置加密凭据并保存
  await page.locator('[data-gs="byo-config-cred-btn"]').click();
  await page.locator('[data-gs="byo-cred-smtp-host"]').fill('smtp.gmail.com');
  await page.locator('[data-gs="byo-cred-imap-host"]').fill('imap.gmail.com');
  await page.locator('[data-gs="byo-cred-password"]').fill('my-app-secret-pw');
  await page.getByRole('button', { name: '加密保存' }).click();

  await expect.poll(() => savedCredPayload).toMatchObject({
    imapHost: 'imap.gmail.com',
    password: 'my-app-secret-pw',
    smtpHost: 'smtp.gmail.com',
  });
  await expect(page.locator('[data-gs="byo-mailbox-list-card"]')).toContainText('凭据已加密托管');
  // 密码绝不回显在页面 DOM 中
  expect(await panel.innerText()).not.toContain('my-app-secret-pw');

  // 3. 实时测试连通性
  await page.locator('[data-gs="byo-test-conn-btn"]').click();
  await expect.poll(() => testConnCalled).toBe(1);
  await expect(page.locator('[data-gs="byo-mailbox-list-card"]')).toContainText('连通正常');

  // 4. 启动 Google OAuth2 授权
  await page.locator('[data-gs="byo-oauth-google-btn"]').click();
  await expect(page.locator('[data-gs="byo-oauth-banner"]')).toBeVisible();

  // 5. 触发发信域名实时 DNS 核验并展示模板
  await page.locator('[data-gs="byo-verify-dns-btn"]').click();
  await expect(page.locator('[data-gs="byo-domains-card"]')).toContainText('配置就绪');
  await expect(page.locator('[data-gs="byo-dns-template"]')).toContainText('v=spf1');

  // 6. 零裸 UUID 校验
  const fullText = await panel.innerText();
  expect(fullText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});
