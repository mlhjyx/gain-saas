/**
 * e2e 预览服务的来源。与 playwright.config.ts 的 baseURL 同源：本机 4173 被别的 worktree 占着时，
 * 用 GAINOS_E2E_PORT（兼容 PLAYWRIGHT_PORT）换端口，配置、mock 层和各 spec 里的来源判断都读这一个值。
 */
export const TEST_ORIGIN = `http://127.0.0.1:${process.env.GAINOS_E2E_PORT || process.env.PLAYWRIGHT_PORT || '4173'}`;
