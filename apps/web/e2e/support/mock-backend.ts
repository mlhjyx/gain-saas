/**
 * 共享的 BFF mock 层（M2 步 14-3）。
 *
 * 设计 §5 允许「无法稳定提供的步骤用 BFF mock」：本层按 gain-saas 的信封契约
 * （成功 `{data}`、失败 `{error:{code,userCopy}}`）应答，并记录全部请求供断言。
 * 每个用例只覆盖自己关心的端点，其余走默认：集合类 GET → []，其它 GET → null，
 * 写操作 → 成功空回执。
 */
import type { Page, Route } from '@playwright/test';

export interface RecordedCall {
  body: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
}

export interface SessionShape {
  user: { email: string; id: string };
  workspace: { id: string; role: 'admin' | 'member' };
  workspaces: Array<{ id: string; name: string; role: string }>;
}

export type MockHandler = (context: {
  backend: MockBackend;
  body: unknown;
  route: Route;
  url: URL;
}) => boolean | Promise<boolean>;

export interface MockBackend {
  calls: RecordedCall[];
  callsTo(method: string, pathPrefix: string): RecordedCall[];
  onboardingComplete: boolean;
  /** 精确路径覆盖：data 直接作为 data 返回；handler 返回 false 表示未处理、继续默认逻辑。 */
  set(method: string, path: string, dataOrHandler: MockHandler | unknown): void;
  session: SessionShape;
  take(method: string, path: string): RecordedCall | undefined;
}

export interface MockBackendOptions {
  displayName?: string;
  onboardingComplete?: boolean;
  role?: 'admin' | 'member';
}

const COLLECTIONS = new Set([
  '/campaigns',
  '/companies',
  '/discovery-runs',
  '/icps',
  '/leads',
  '/members',
  '/notifications',
  '/outreach/batches',
  '/qgos',
  '/runs',
  '/source-channels/available',
  '/tasks',
  '/workspaces',
]);

export function defaultSession(options: MockBackendOptions = {}): SessionShape {
  const role = options.role ?? 'admin';
  const workspace = {
    id: 'ws-e2e',
    name: options.displayName ?? 'E2E 测试公司',
    role,
  };
  return {
    user: { email: 'e2e@gainos.local', id: 'user-e2e' },
    workspace: { id: workspace.id, role },
    workspaces: [workspace],
  };
}

/** 失败信封：模拟 BFF 的三层文案错误（PRD §14.4）。 */
export function errorPayload(
  code: string,
  userCopy?: { next?: string; title: string; why?: string },
): { error: { code: string; userCopy?: { next?: string; title: string; why?: string } } } {
  return { error: { code, ...(userCopy ? { userCopy } : {}) } };
}

export async function installMockBackend(
  page: Page,
  options: MockBackendOptions = {},
): Promise<MockBackend> {
  const session = defaultSession(options);
  const backend: MockBackend = {
    calls: [],
    callsTo(method, pathPrefix) {
      return this.calls.filter((call) => call.method === method && call.path.startsWith(pathPrefix));
    },
    onboardingComplete: options.onboardingComplete ?? true,
    session,
    set(method, path, dataOrHandler) {
      overrides.set(`${method} ${path}`, dataOrHandler);
    },
    take(method, path) {
      const index = this.calls.findIndex((call) => call.method === method && call.path === path);
      if (index < 0) return undefined;
      return this.calls.splice(index, 1)[0];
    },
  };
  const overrides = new Map<string, MockHandler | unknown>();

  const fulfill = (route: Route, data: unknown, status = 200) =>
    route.fulfill({
      body: JSON.stringify({ data }),
      contentType: 'application/json',
      status,
    });

  const fulfillError = (route: Route, payload: unknown, status: number) =>
    route.fulfill({
      body: JSON.stringify(payload),
      contentType: 'application/json',
      status,
    });

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173') return route.continue();
    // 整页导航（document 请求）交给 vite preview 的 SPA fallback，不当 API 拦截。
    if (request.isNavigationRequest() && request.resourceType() === 'document') return route.continue();
    const path = url.pathname;
    if (
      request.method() === 'GET' &&
      (path === '/' || path.startsWith('/assets/') || /\.(?:css|ico|js|json|map|png|svg|woff2?)$/.test(path))
    ) {
      return route.continue();
    }

    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    const call: RecordedCall = {
      body,
      method: request.method(),
      path,
      query: Object.fromEntries(url.searchParams.entries()),
    };
    backend.calls.push(call);

    const key = `${request.method()} ${path}`;
    const override = overrides.get(key);
    if (override !== undefined) {
      if (typeof override === 'function') {
        const handled = await (override as MockHandler)({ backend, body, route, url });
        if (handled) return;
      } else {
        return fulfill(route, override);
      }
    }

    // ── 默认路由（按 gain-saas BFF 契约）──
    if (request.method() === 'GET') {
      if (path === '/auth/session') return fulfill(route, session);
      if (path === '/auth/registration-policy') return fulfill(route, { inviteCodeRequired: false });
      if (path === '/onboarding/status') return fulfill(route, { complete: backend.onboardingComplete });
      if (path === '/workspace/context') {
        return fulfill(route, {
          user: session.user,
          workspace: { ...session.workspaces[0], role: session.workspace.role },
          onboarding: { complete: backend.onboardingComplete, companyId: null },
          allowedActions: [],
        });
      }
      if (path === '/notifications') return fulfill(route, { items: [], unreadCount: 0 });
      if (path === '/members') return fulfill(route, { invitations: [], members: [] });
      if (path === '/workspaces') return fulfill(route, session.workspaces);
      if (COLLECTIONS.has(path)) return fulfill(route, []);
      return fulfill(route, null);
    }

    if (path === '/onboarding/company') backend.onboardingComplete = true;
    return fulfill(route, {});
  });

  return backend;
}

/** 走真实登录表单登录（cookie 会话用占位 token；BFF 一律 mock）。 */
export async function loginAs(page: Page, email = 'e2e@gainos.local'): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/auth\/login/);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();
  await page.waitForURL(/\/workspace|\/onboarding/);
}
