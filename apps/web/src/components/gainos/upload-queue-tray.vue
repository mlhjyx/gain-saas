<script lang="ts" setup>
/**
 * 全局右下角「后台传输与识别浮窗」（PR-OB1）。
 *
 * - 挂载于 BasicLayout（脱离 <RouterView>），切换任意页面不中断在途上传与解析轮询；
 * - 固定停靠右下角（right: 20px; bottom: calc(16px + var(--gs-flow-bar-h, 0px)); z-index: 210），
 *   高于正文内容、严格低于 AntDV Drawer/Modal（1000），闲置或关闭完成后 0px 占位；
 * - 支持展开浮卡（380px）与单行最小化胶囊切换；移动端（<768px）默认自动收起为紧凑胶囊；
 * - 全部租户可见文案均为业务白话，绝不暴露内部分片/协议/解析引擎术语，100% 遵循明暗双主题 AA。
 */
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';

import { ChevronDown, CircleCheckBig, RotateCw, X } from '@vben/icons';
import { useMediaQuery } from '@vueuse/core';
import { useUserStore } from '@vben/stores';
import { Button } from 'ant-design-vue';

import type { GainosUserInfo } from '#/api/core/user';

import { AUTH_SESSION_CHANGING_KEY } from '#/api/core/auth';
import { formatBytes, formatSpeed } from '#/api/seller-documents-upload';
import { $t } from '#/locales';
import { useUploadQueueStore, type UploadQueueItem } from '#/stores/upload-queue';

defineOptions({ name: 'UploadQueueTray' });

const router = useRouter();
const queue = useUploadQueueStore();
const userStore = useUserStore();
const isCompactViewport = useMediaQuery('(max-width: 767.98px)');

function onCrossTabAuthChange(event: StorageEvent): void {
  if (event.key === AUTH_SESSION_CHANGING_KEY && event.newValue) queue.invalidateSession();
}
onMounted(() => window.addEventListener('storage', onCrossTabAuthChange));
onUnmounted(() => window.removeEventListener('storage', onCrossTabAuthChange));

watch(
  () => {
    const user = userStore.userInfo as GainosUserInfo | null;
    return user?.workspaceId && user.userId
      ? JSON.stringify([user.workspaceId, user.userId])
      : null;
  },
  (scope) => {
    queue.setSessionScope(scope);
    if (isCompactViewport.value) queue.setTrayCollapsed(true);
  },
  { immediate: true },
);

// 手机宽度默认自动收起为右下角单行胶囊，避免遮挡表单与列表。
watch(
  isCompactViewport,
  (compact) => {
    if (compact) queue.setTrayCollapsed(true);
  },
  { immediate: true },
);

const visibleItems = computed(() => queue.items);
const shouldRender = computed(() => visibleItems.value.length > 0 && !queue.trayDismissed);

const nonCancelledCount = computed(
  () => visibleItems.value.filter((item) => item.status !== 'cancelled').length,
);

const settledCount = computed(
  () =>
    visibleItems.value.filter(
      (item) => item.status === 'ready' || item.status === 'priority_ready',
    ).length,
);

const trayTone = computed<'active' | 'attention' | 'done'>(() => {
  if (queue.hasActiveTasks) return 'active';
  if (queue.attentionCount > 0) return 'attention';
  return 'done';
});

const pillText = computed(() => {
  if (trayTone.value === 'active') {
    return $t('gainosOb.uploadQueue.pillActive', {
      done: settledCount.value,
      total: Math.max(1, nonCancelledCount.value),
    });
  }
  if (trayTone.value === 'attention') {
    return $t('gainosOb.uploadQueue.pillAttention', {
      count: queue.attentionCount,
    });
  }
  return $t('gainosOb.uploadQueue.pillCompleted', {
    total: Math.max(1, queue.completedCount),
  });
});

const canDismiss = computed(() => !queue.hasActiveTasks);

function primaryStatusText(item: UploadQueueItem): string {
  switch (item.status) {
    case 'queued':
      return $t('gainosOb.uploadQueue.statusQueued');
    case 'uploading':
      return $t('gainosOb.uploadQueue.statusUploading', { percent: item.percent });
    case 'paused':
      return $t('gainosOb.uploadQueue.statusPaused');
    case 'interrupted':
      return $t('gainosOb.uploadQueue.statusInterrupted');
    case 'committing':
      return $t('gainosOb.uploadQueue.statusCommitting');
    case 'parsing_priority':
      if (item.parseQueueState === 'retrying') return $t('gainosOb.uploadQueue.statusParseRetryQueued');
      if (item.parseQueueState === 'waiting') return $t('gainosOb.uploadQueue.statusParseQueued');
      return $t('gainosOb.uploadQueue.statusParsingPriority');
    case 'priority_ready': {
      const parsed = item.parsedMeta?.parsedPages ?? 15;
      const total = item.parsedMeta?.totalPages ?? parsed;
      return $t('gainosOb.uploadQueue.statusPriorityReady', { parsed, total });
    }
    case 'ready': {
      const total = item.parsedMeta?.totalPages;
      if (item.parsedMeta?.tailParsePartial) return $t('gainosOb.uploadQueue.statusReadyPartial');
      return typeof total === 'number' && total > 0
        ? $t('gainosOb.uploadQueue.statusReady', { total })
        : $t('gainosOb.uploadQueue.statusReadyNoPages');
    }
    case 'failed':
      return $t('gainosOb.uploadQueue.statusFailed');
    case 'cancelled':
      return $t('gainosOb.uploadQueue.statusCancelled');
  }
}

function secondaryStatusText(item: UploadQueueItem): string {
  switch (item.status) {
    case 'queued':
      return formatBytes(item.sizeBytes);
    case 'uploading': {
      const speed = formatSpeed(item.speedBytesPerSec);
      if (item.uploadMode === 'multipart' && item.totalParts > 1) {
        return $t('gainosOb.uploadQueue.statusUploadingMeta', {
          current: Math.max(1, item.currentPartNumber),
          speed,
          total: item.totalParts,
        });
      }
      return $t('gainosOb.uploadQueue.statusUploadingDirectMeta', { speed });
    }
    case 'paused':
    case 'interrupted': {
      if (item.uploadMode === 'multipart' && item.totalParts > 1) {
        return $t('gainosOb.uploadQueue.statusPausedMeta', {
          done: item.completedParts.length,
          total: item.totalParts,
        });
      }
      return $t('gainosOb.uploadQueue.statusPausedDirectMeta');
    }
    case 'committing':
      return $t('gainosOb.uploadQueue.statusCommittingMeta');
    case 'parsing_priority':
      return $t('gainosOb.uploadQueue.statusParsingPriorityMeta');
    case 'priority_ready': {
      if (item.aiProductsCount > 0 && item.aiClaimsCount > 0) {
        return $t('gainosOb.uploadQueue.statusPriorityReadyProductsClaims', {
          claims: item.aiClaimsCount,
          products: item.aiProductsCount,
        });
      }
      if (item.aiProductsCount > 0) {
        return $t('gainosOb.uploadQueue.statusPriorityReadyProducts', {
          products: item.aiProductsCount,
        });
      }
      return $t('gainosOb.uploadQueue.statusPriorityReadyFallback');
    }
    case 'ready': {
      if (item.aiProductsCount > 0 && item.aiClaimsCount > 0) {
        return $t('gainosOb.uploadQueue.statusReadyStats', {
          claims: item.aiClaimsCount,
          products: item.aiProductsCount,
        });
      }
      if (item.aiProductsCount > 0) {
        return $t('gainosOb.uploadQueue.statusReadyProductsOnly', {
          products: item.aiProductsCount,
        });
      }
      if (item.aiClaimsCount > 0) {
        return $t('gainosOb.uploadQueue.statusReadyClaimsOnly', {
          claims: item.aiClaimsCount,
        });
      }
      return $t('gainosOb.uploadQueue.statusReadyBasic');
    }
    case 'failed':
      return friendlyErrorSummary(item);
    case 'cancelled':
      return formatBytes(item.sizeBytes);
  }
}

function friendlyErrorSummary(item: UploadQueueItem): string {
  if (item.errorTitle) {
    return item.errorNext ? `${item.errorTitle} ${item.errorNext}` : item.errorTitle;
  }
  switch (item.errorKind) {
    case 'NETWORK':
      return `${$t('gainosOb.uploadQueue.errNetworkTitle')}。${$t('gainosOb.uploadQueue.errNetworkNext')}`;
    case 'PARSE_FAILED':
      return `${$t('gainosOb.uploadQueue.errParseFailedTitle')}。${$t('gainosOb.uploadQueue.errParseFailedNext')}`;
    default:
      return `${$t('gainosOb.uploadQueue.errGenericTitle')}。${$t('gainosOb.uploadQueue.errGenericNext')}`;
  }
}

function itemTone(item: UploadQueueItem): 'active' | 'danger' | 'neutral' | 'success' | 'warning' {
  switch (item.status) {
    case 'ready':
      return 'success';
    case 'priority_ready':
    case 'uploading':
    case 'committing':
    case 'parsing_priority':
      return 'active';
    case 'paused':
    case 'interrupted':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

function openCompanyTab(item: UploadQueueItem, tab: 'documents' | 'facts'): void {
  void router.push({ path: '/companies', query: { companyId: item.companyId, tab } });
}
</script>

<template>
  <aside
    v-if="shouldRender"
    :aria-label="$t('gainosOb.uploadQueue.trayAria')"
    class="gs-uq-root"
    data-gs="upload-queue-tray"
    role="region"
  >
    <!-- 最小化单行胶囊 -->
    <button
      v-if="queue.trayCollapsed"
      :aria-label="$t('gainosOb.uploadQueue.expand')"
      :data-tone="trayTone"
      class="gs-uq-pill"
      data-gs="upload-tray-pill"
      type="button"
      @click="queue.setTrayCollapsed(false)"
    >
      <span aria-hidden="true" class="gs-uq-pill__icon">
        <RotateCw v-if="trayTone === 'active'" :size="14" class="gs-uq-spin" />
        <CircleCheckBig v-else-if="trayTone === 'done'" :size="15" />
        <svg
          v-else
          fill="none"
          height="15"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          viewBox="0 0 24 24"
          width="15"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" x2="12" y1="8" y2="12" />
          <line x1="12" x2="12.01" y1="16" y2="16" />
        </svg>
      </span>
      <span class="gs-uq-pill__text">{{ pillText }}</span>
      <ChevronDown :size="14" aria-hidden="true" class="gs-uq-pill__chevron" />
    </button>

    <!-- 展开浮卡（380px，1px 细线表面，明暗双主题 AA） -->
    <section
      v-else
      class="gs-uq-card"
      data-gs="upload-tray-card"
    >
      <header class="gs-uq-head">
        <div class="gs-uq-head__title-wrap">
          <span :data-tone="trayTone" aria-hidden="true" class="gs-uq-dot"></span>
          <strong class="gs-uq-head__title">{{ $t('gainosOb.uploadQueue.trayTitle') }}</strong>
          <span class="gs-uq-head__count">{{ settledCount }}/{{ Math.max(1, nonCancelledCount) }}</span>
        </div>
        <div class="gs-uq-head__actions">
          <button
            v-if="queue.completedCount > 0 && queue.hasActiveTasks"
            class="gs-uq-text-btn"
            type="button"
            @click="queue.clearFinished"
          >
            {{ $t('gainosOb.uploadQueue.clearFinished') }}
          </button>
          <button
            :aria-label="$t('gainosOb.uploadQueue.collapse')"
            :title="$t('gainosOb.uploadQueue.collapse')"
            class="gs-uq-icon-btn"
            data-gs="upload-tray-collapse"
            type="button"
            @click="queue.setTrayCollapsed(true)"
          >
            <ChevronDown :size="15" aria-hidden="true" />
          </button>
          <button
            v-if="canDismiss"
            :aria-label="$t('gainosOb.uploadQueue.closeTray')"
            :title="$t('gainosOb.uploadQueue.closeTray')"
            class="gs-uq-icon-btn"
            data-gs="upload-tray-dismiss"
            type="button"
            @click="queue.dismissTray"
          >
            <X :size="15" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div
        v-if="queue.hasBlockingTransfers || queue.hasServerParsing"
        :data-blocking="queue.hasBlockingTransfers"
        class="gs-uq-banner"
        data-gs="upload-tray-safety"
        role="status"
      >
        {{
          queue.hasBlockingTransfers
            ? $t('gainosOb.uploadQueue.doNotClose')
            : $t('gainosOb.uploadQueue.safeToClose')
        }}
      </div>

      <ul aria-live="polite" class="gs-uq-list">
        <li
          v-for="item in visibleItems"
          :key="item.id"
          :data-status="item.status"
          class="gs-uq-item"
          data-gs="upload-tray-item"
        >
          <div class="gs-uq-item__top">
            <div class="gs-uq-item__name-wrap">
              <span :title="item.filename" class="gs-uq-item__name">{{ item.filename }}</span>
              <span class="gs-uq-item__size">{{ formatBytes(item.sizeBytes) }}</span>
            </div>
            <div class="gs-uq-item__controls">
              <Button
                v-if="item.status === 'uploading'"
                size="small"
                @click="queue.pauseTask(item.id)"
              >
                {{ $t('gainosOb.uploadQueue.actionPause') }}
              </Button>
              <Button
                v-if="item.status === 'uploading' || item.status === 'queued'"
                size="small"
                @click="queue.cancelTask(item.id)"
              >
                {{ $t('gainosOb.uploadQueue.actionCancel') }}
              </Button>
              <Button
                v-if="item.status === 'paused'"
                size="small"
                type="primary"
                @click="queue.resumeTask(item.id)"
              >
                {{ $t('gainosOb.uploadQueue.actionResume') }}
              </Button>
              <Button
                v-if="item.status === 'interrupted'"
                size="small"
                type="primary"
                @click="queue.resumeTask(item.id)"
              >
                {{ $t('gainosOb.uploadQueue.actionResumeInterrupted') }}
              </Button>
              <Button
                v-if="item.status === 'failed' || item.status === 'cancelled'"
                size="small"
                @click="queue.retryTask(item.id)"
              >
                {{ $t('gainosOb.uploadQueue.actionRetry') }}
              </Button>
              <Button
                v-if="item.status === 'priority_ready'"
                size="small"
                type="primary"
                @click="openCompanyTab(item, 'facts')"
              >
                {{ $t('gainosOb.uploadQueue.actionConfirmProducts') }}
              </Button>
              <Button
                v-if="item.status === 'ready'"
                size="small"
                @click="openCompanyTab(item, 'documents')"
              >
                {{ $t('gainosOb.uploadQueue.actionOpenDocs') }}
              </Button>
              <button
                v-if="['paused', 'interrupted', 'failed', 'cancelled', 'ready'].includes(item.status)"
                :aria-label="$t('gainosOb.uploadQueue.actionRemove')"
                class="gs-uq-icon-btn gs-uq-icon-btn--sm"
                type="button"
                @click="queue.removeTask(item.id)"
              >
                <X :size="13" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div
            v-if="
              item.status === 'uploading' ||
              item.status === 'committing' ||
              (item.status === 'parsing_priority' && item.parseQueueState === null)
            "
            class="gs-uq-bar"
          >
            <div
              :class="{
                'is-indeterminate': item.status === 'committing' || item.status === 'parsing_priority',
              }"
              :style="
                item.status === 'uploading'
                  ? { width: `${Math.max(4, item.percent)}%` }
                  : undefined
              "
              class="gs-uq-bar__fill"
            ></div>
          </div>

          <div class="gs-uq-item__status">
            <span :data-tone="itemTone(item)" class="gs-uq-item__primary">
              {{ primaryStatusText(item) }}
            </span>
            <span class="gs-uq-item__secondary">
              {{ secondaryStatusText(item) }}
            </span>
          </div>

          <div
            v-if="
              item.visionUsed ||
              (item.largePdfHint && ['queued', 'uploading', 'paused', 'interrupted'].includes(item.status))
            "
            class="gs-uq-item__badges"
          >
            <span
              v-if="item.visionUsed"
              class="gs-uq-chip gs-uq-chip--info"
              data-gs="upload-vision-badge"
            >
              {{ $t('gainosOb.uploadQueue.visionBadge') }}
            </span>
            <span
              v-if="
                item.largePdfHint &&
                ['queued', 'uploading', 'paused', 'interrupted'].includes(item.status)
              "
              class="gs-uq-chip gs-uq-chip--warn"
            >
              {{ $t('gainosOb.uploadQueue.largePdfBadge') }}
            </span>
          </div>

          <details v-if="item.status === 'failed' && item.errorTech" class="gs-uq-tech">
            <summary>{{ $t('gainosOb.uploadQueue.techDetails') }}</summary>
            <p>{{ item.errorTech }}</p>
          </details>
        </li>
      </ul>
    </section>
  </aside>
</template>

<style scoped>
.gs-uq-root {
  position: fixed;
  right: 20px;
  bottom: calc(16px + var(--gs-flow-bar-h, 0px));
  z-index: 210;
  max-width: calc(100vw - 32px);
}

.gs-uq-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 32px);
  height: 40px;
  padding: 0 12px 0 10px;
  border: 1px solid var(--gs-border-strong);
  border-radius: 10px;
  background: var(--gs-surface);
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  box-shadow: var(--gs-shadow-tooltip);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.gs-uq-pill:hover {
  border-color: var(--gs-accent);
}

.gs-uq-pill:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

.gs-uq-pill__icon {
  display: grid;
  place-items: center;
  flex: none;
  color: var(--gs-accent-fg);
}

.gs-uq-pill[data-tone='done'] .gs-uq-pill__icon {
  color: var(--gs-success-fg);
}

.gs-uq-pill[data-tone='attention'] .gs-uq-pill__icon {
  color: var(--gs-warn-fg);
}

.gs-uq-pill__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-uq-pill__chevron {
  flex: none;
  color: var(--gs-fg-subtle);
  transform: rotate(180deg);
}

.gs-uq-card {
  width: min(380px, calc(100vw - 32px));
  overflow: hidden;
  border: 1px solid var(--gs-border-strong);
  border-radius: 12px;
  background: var(--gs-surface);
  color: var(--gs-fg);
  box-shadow: var(--gs-shadow-tooltip);
}

.gs-uq-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 44px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid var(--gs-border);
  background: var(--gs-surface);
}

.gs-uq-head__title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.gs-uq-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex: none;
  background: var(--gs-accent);
}

.gs-uq-dot[data-tone='done'] {
  background: var(--gs-success-fg);
}

.gs-uq-dot[data-tone='attention'] {
  background: var(--gs-warn-fg);
}

.gs-uq-head__title {
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}

.gs-uq-head__count {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.gs-uq-head__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.gs-uq-text-btn {
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 4px 6px;
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.gs-uq-text-btn:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}

.gs-uq-icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--gs-fg-muted);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.gs-uq-icon-btn--sm {
  width: 24px;
  height: 24px;
}

.gs-uq-icon-btn:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}

.gs-uq-icon-btn:focus-visible,
.gs-uq-text-btn:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

.gs-uq-banner {
  padding: 7px 14px;
  border-bottom: 1px solid var(--gs-divider);
  background: var(--gs-surface-2);
  color: var(--gs-fg-2);
  font-size: 12px;
  line-height: 18px;
}

.gs-uq-banner[data-blocking='true'] {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}

.gs-uq-list {
  display: grid;
  margin: 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
  list-style: none;
}

.gs-uq-item {
  display: grid;
  gap: 6px;
  padding: 11px 14px;
}

.gs-uq-item + .gs-uq-item {
  border-top: 1px solid var(--gs-divider);
}

.gs-uq-item__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.gs-uq-item__name-wrap {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.gs-uq-item__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}

.gs-uq-item__size {
  flex: none;
  color: var(--gs-fg-subtle);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.gs-uq-item__controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.gs-uq-bar {
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--gs-surface-2);
}

.gs-uq-bar__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--gs-accent);
  transition: width 0.2s ease;
}

.gs-uq-bar__fill.is-indeterminate {
  width: 38%;
  animation: gs-uq-indeterminate 1.4s ease-in-out infinite;
}

.gs-uq-item__status {
  display: grid;
  gap: 2px;
  font-variant-numeric: tabular-nums;
}

.gs-uq-item__primary {
  color: var(--gs-fg-2);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 18px;
}

.gs-uq-item__primary[data-tone='active'] {
  color: var(--gs-accent-fg);
}

.gs-uq-item__primary[data-tone='success'] {
  color: var(--gs-success-fg);
}

.gs-uq-item__primary[data-tone='warning'] {
  color: var(--gs-warn-fg);
}

.gs-uq-item__primary[data-tone='danger'] {
  color: var(--gs-danger-fg);
}

.gs-uq-item__secondary {
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 17px;
  overflow-wrap: anywhere;
}

.gs-uq-item__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.gs-uq-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 16px;
}

.gs-uq-chip--info {
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}

.gs-uq-chip--warn {
  background: var(--gs-warn-bg);
  color: var(--gs-warn-fg);
}

.gs-uq-tech {
  font-size: 11.5px;
  color: var(--gs-fg-muted);
}

.gs-uq-tech summary {
  cursor: pointer;
}

.gs-uq-tech p {
  margin: 4px 0 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--gs-surface-2);
  font-family: var(--gs-font-mono);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.gs-uq-spin {
  animation: gs-uq-spin 0.9s linear infinite;
}

@keyframes gs-uq-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes gs-uq-indeterminate {
  0% {
    transform: translateX(-100%);
  }
  50% {
    transform: translateX(120%);
  }
  100% {
    transform: translateX(260%);
  }
}

@media (max-width: 767.98px) {
  .gs-uq-root {
    right: 16px;
  }
}
</style>
