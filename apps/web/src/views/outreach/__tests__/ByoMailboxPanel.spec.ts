import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const PANEL_PATH = resolve(import.meta.dirname, '../ByoMailboxPanel.vue');
const PAGE_PATH = resolve(import.meta.dirname, '../../settings/outreach-mailboxes.vue');
const ZH_PATH = resolve(import.meta.dirname, '../../../locales/langs/zh-CN/outreach-byo.json');
const EN_PATH = resolve(import.meta.dirname, '../../../locales/langs/en-US/outreach-byo.json');

describe('ByoMailboxPanel & SettingsOutreachMailboxes 静态规范与对称性护栏', () => {
  const panelSrc = readFileSync(PANEL_PATH, 'utf8');
  const pageSrc = readFileSync(PAGE_PATH, 'utf8');
  const zh = JSON.parse(readFileSync(ZH_PATH, 'utf8')) as Record<string, string>;
  const en = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, string>;

  it('严禁 <style scoped>、kebab-case <a-*> 与原生浏览器日期方法', () => {
    const forbiddenDateCall = new RegExp(`\\.to${'Locale'}(?:Date|Time)?String\\s*\\(`);
    for (const src of [panelSrc, pageSrc]) {
      expect(src).not.toContain('<style');
      expect(src).not.toMatch(/<a-[a-z-]+/);
      expect(src).not.toMatch(forbiddenDateCall);
    }
  });

  it('使用统一 feedback、formatDateTime、@container 栅格且不渲染裸 UUID', () => {
    expect(panelSrc).toContain("from '#/feedback'");
    expect(panelSrc).toContain("from '@gain-saas/shared'");
    expect(panelSrc).toContain('formatDateTime');
    expect(panelSrc).toContain('@container');
    expect(panelSrc).not.toContain('credentialsCiphertext');
  });

  it('中英文 outreach-byo.json 键集完全对称且不含裸 @ 占位符', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(v.trim().length, `empty locale key ${k}`).toBeGreaterThan(0);
      // vue-i18n v9 禁止未转义裸 @（允许 {'@'}）
      const stripped = v.replace(/\{'@'\}/g, '');
      expect(stripped, `unescaped @ in ${k}`).not.toContain('@');
    }
  });
});
