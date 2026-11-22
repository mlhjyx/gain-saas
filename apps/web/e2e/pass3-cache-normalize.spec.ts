/**
 * pass3 A4：偏好缓存归一回归测试（本轮最关键的用例）。
 *
 * 场景 = 用户本人：浏览器里留着 PR#183 之前的旧版偏好缓存
 * （绿色 colorPrimary + header-nav 顶栏布局 + 旧 logo URL）。
 * 预置 localStorage 后加载应用，断言 main.ts 的品牌字段强制归一生效：
 *  - 品牌蓝（内联 --primary / nprogress 进度条底色同源）；
 *  - 垂直侧边栏渲染、顶栏（banner）无任何菜单项；
 *  - logo URL 已带版本号（击穿浏览器图片缓存）；
 *  - 明暗模式等用户偏好不被破坏。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

/** Vben 偏好缓存 key：`${namespace}-${version}-${env}-preferences`（prod 构建）。 */
const PREFS_KEY = 'vben-web-antd-5.8.0-prod-preferences';

/**
 * PR#183 之前的旧版偏好：绿色主题 + 顶栏布局 + 旧 logo。
 * StorageManager 以 { value: … } 信封存储（storage-manager.ts setItem），注入必须带信封。
 */
const STALE_PREFS = JSON.stringify({
  value: {
    app: { layout: 'header-nav', locale: 'zh-CN' },
    logo: { source: '/logo-gainos.svg', sourceDark: '/logo-gainos.svg' },
    theme: {
      builtinType: 'default',
      colorPrimary: 'hsl(155 100% 24%)',
      mode: 'light',
    },
  },
});

test('旧版绿色 + 顶栏缓存被强制归一为蓝主题纯侧边栏', async ({ page }) => {
  // 只在首个文档注入一次：addInitScript 会在每次导航重放，若不设标记，
  // 旧偏好会在应用把归一结果写回缓存之后再次覆盖 localStorage。
  await page.addInitScript(
    ([key, value]) => {
      const marker = 'pass3-stale-prefs-injected';
      if (!window.localStorage.getItem(marker)) {
        window.localStorage.setItem(key!, value!);
        window.localStorage.setItem(marker, '1');
      }
    },
    [PREFS_KEY, STALE_PREFS],
  );

  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/workspace');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);

  // 1) 品牌蓝归一：内联 --primary（nprogress bar 的 bg-primary 同源）。
  const primary = await page.evaluate(() => {
    const root = document.documentElement;
    const inline = root.style.getPropertyValue('--primary');
    const probe = document.createElement('div');
    probe.style.background = 'hsl(var(--primary))';
    probe.style.display = 'none';
    root.append(probe);
    const rgb = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { inline, rgb };
  });
  // #335CFF = rgb(51, 92, 255)，色相 228；旧绿为 hsl(155 …)。
  expect(primary.rgb, `--primary 应解析为品牌蓝，实际 inline=${primary.inline} rgb=${primary.rgb}`).toBe(
    'rgb(51, 92, 255)',
  );

  // 2) 垂直侧边栏渲染，且顶栏（banner）没有任何菜单项。
  await expect(page.locator('[data-sdr-nav]')).toBeVisible();
  await expect(page.getByRole('banner').getByRole('menuitem')).toHaveCount(0);
  await expect(page.locator('[data-sdr-nav]').getByRole('menuitem').first()).toBeVisible();

  // 3) logo URL 已带版本号（击穿图片缓存）。banner 里第一张 img 是用户头像
  //    （mock 数据 URI），品牌 logo 按 src 选择器定位。
  await expect(page.locator('img[src*="logo-gainos.svg?v=pass3"]').first()).toBeVisible();

  // 4) 用户偏好不被破坏：明暗模式仍可切换（缓存归一只动品牌字段）。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'dark' }).click();
  await page.waitForTimeout(400);
  await expect(page.locator('html')).toHaveClass(/dark/);

  // 5) 归一结果已回写缓存：下次访问不再依赖强制归一。
  const persisted = await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    try {
      const envelope = JSON.parse(raw) as {
        value?: {
          app?: { layout?: string };
          header?: { height?: number; hidden?: boolean };
          logo?: { source?: string };
          tabbar?: { enable?: boolean; height?: number };
          theme?: { colorPrimary?: string };
        };
      };
      return envelope.value ?? null;
    } catch {
      return null;
    }
  }, PREFS_KEY);
  expect(persisted?.app?.layout).toBe('sidebar-nav');
  expect(persisted?.theme?.colorPrimary?.toLowerCase()).toContain('335cff');
  expect(persisted?.logo?.source).toContain('v=pass3');
  // pass5：顶部横带高度归一（老缓存 50 会让侧栏品牌行与标签栏错位）。
  expect(persisted?.header?.height).toBe(40);
  expect(persisted?.header?.hidden).toBe(true);
  expect(persisted?.tabbar?.enable).toBe(true);
  expect(persisted?.tabbar?.height).toBe(40);
});
