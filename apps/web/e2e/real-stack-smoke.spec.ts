/**
 * P5b-19：真栈冒烟（登录 → 关键 GET 的契约形状校验）。
 *
 * 默认跳过：只有设置 GAINOS_SMOKE_BASE_URL / GAINOS_SMOKE_EMAIL / GAINOS_SMOKE_PASSWORD
 * 时才对真实环境运行（发车后或本机 deploy 验证时手动触发）：
 *   GAINOS_SMOKE_BASE_URL=https://127.0.0.1:4020 \
 *   GAINOS_SMOKE_EMAIL=admin@example.com GAINOS_SMOKE_PASSWORD=... \
 *   pnpm exec playwright test real-stack-smoke
 * 不写死凭据、不在 CI 里跑。
 */
import { expect, test } from '@playwright/test';

const BASE_URL = process.env.GAINOS_SMOKE_BASE_URL;
const EMAIL = process.env.GAINOS_SMOKE_EMAIL;
const PASSWORD = process.env.GAINOS_SMOKE_PASSWORD;
const enabled = Boolean(BASE_URL && EMAIL && PASSWORD);

interface Shape {
  [key: string]: 'array' | 'number' | 'string' | Shape | 'string|null';
}

function expectShape(value: unknown, shape: Shape, path = '$'): void {
  expect(value, `${path} 应为对象`).toBeTypeOf('object');
  const record = value as Record<string, unknown>;
  for (const [key, rule] of Object.entries(shape)) {
    const current = record[key];
    const at = `${path}.${key}`;
    if (rule === 'array') {
      expect(Array.isArray(current), `${at} 应为数组`).toBe(true);
    } else if (rule === 'number') {
      expect(typeof current, `${at} 应为数字`).toBe('number');
    } else if (rule === 'string') {
      expect(typeof current, `${at} 应为字符串`).toBe('string');
    } else if (rule === 'string|null') {
      expect(current === null || typeof current === 'string', `${at} 应为字符串或 null`).toBe(true);
    } else {
      expectShape(current, rule, at);
    }
  }
}

test.describe('真栈冒烟', () => {
  test.skip(!enabled, '未配置 GAINOS_SMOKE_*，跳过真栈冒烟');

  test('登录后关键 GET 的响应形状符合契约', async ({ page }) => {
    await page.goto(`${BASE_URL}/auth/login`);
    await page.locator('input[type="email"]').fill(EMAIL!);
    await page.locator('input[type="password"]').fill(PASSWORD!);
    await page.locator('button.g-submit').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 30_000 });

    const session = await page.evaluate(async () => (await fetch('/api/auth/session')).json());
    expectShape(session, {
      data: { user: { email: 'string', id: 'string' }, workspace: { id: 'string', role: 'string' } },
    });

    const icps = await page.evaluate(async () => (await fetch('/api/icps')).json());
    const icpRows = icps?.data?.data ?? icps?.data ?? icps;
    expect(Array.isArray(icpRows), '/api/icps 应为数组').toBe(true);
    for (const row of icpRows) {
      expectShape(row, { id: 'string', name: 'string', status: 'string' });
    }

    const notifications = await page.evaluate(async () => (await fetch('/api/notifications')).json());
    const pageData = notifications?.data ?? notifications;
    expectShape(pageData, { items: 'array', unreadCount: 'number' });
  });
});
