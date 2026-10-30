<script lang="ts" setup>
/**
 * 认证页的右上角工具条:语言与主题切换(登录/注册页共用)。
 *
 * 语言:复用 vben 的偏好与文案加载链路(updatePreferences + loadLocaleMessages),
 * 与登录后的顶栏切换完全一致,切换立即生效并持久化。
 * 主题:切换 html.dark(与顶栏主题按钮同一机制)。
 */
import { computed } from 'vue';

import { loadLocaleMessages, type SupportedLanguagesType } from '@vben/locales';
import { preferences, updatePreferences, usePreferences } from '@vben/preferences';

const { isDark } = usePreferences();

const isZh = computed(() => preferences.app.locale === 'zh-CN');

async function toggleLocale(): Promise<void> {
  const next: SupportedLanguagesType = isZh.value ? 'en-US' : 'zh-CN';
  updatePreferences({ app: { locale: next } });
  await loadLocaleMessages(next);
}

function toggleTheme(): void {
  updatePreferences({ theme: { mode: isDark.value ? 'light' : 'dark' } });
}
</script>

<template>
  <div class="auth-tools">
    <button
      type="button"
      class="auth-tools__btn auth-tools__lang"
      :aria-label="isZh ? 'Switch to English' : '切换到中文'"
      @click="toggleLocale"
    >
      {{ isZh ? 'EN' : '中' }}
    </button>
    <button
      type="button"
      class="auth-tools__btn"
      :aria-label="isDark ? '切换到浅色' : 'Switch to dark'"
      @click="toggleTheme"
    >
      <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.6v2.2M12 19.2v2.2M4.4 12H2.2M21.8 12h-2.2M6.3 6.3 4.8 4.8M19.2 19.2l-1.5-1.5M17.7 6.3l1.5-1.5M4.8 19.2l1.5-1.5" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
        <path d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7Z" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.auth-tools {
  position: fixed;
  top: clamp(14px, 2.2vw, 24px);
  right: clamp(14px, 2.2vw, 26px);
  z-index: 30;
  display: flex;
  gap: 8px;
}

.auth-tools__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  cursor: pointer;
  color: var(--gs-fg-2);
  background: color-mix(in srgb, var(--gs-surface) 78%, transparent);
  border: 1px solid var(--gs-border-strong);
  border-radius: 10px;
  backdrop-filter: blur(8px);
  transition:
    color 0.16s ease,
    border-color 0.16s ease,
    transform 0.16s ease;
}

.auth-tools__btn:hover {
  color: var(--gs-accent-strong);
  border-color: var(--gs-accent-soft-border);
  transform: translateY(-1px);
}

.auth-tools__btn:active {
  transform: scale(0.96);
}

.auth-tools__btn:focus-visible {
  outline: 2px solid var(--gs-accent);
  outline-offset: 2px;
}

.auth-tools__btn svg {
  width: 17px;
  height: 17px;
}

.auth-tools__lang {
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
</style>
