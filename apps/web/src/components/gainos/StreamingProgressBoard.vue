<script lang="ts" setup>
/**
 * 方案 B 流式三段进度看板（Phase 2 Track 2C）：
 * 直观展示 L0 召回入池 → L1 极速提取与匹配判分 → L2 Top-K 联系人与邮箱验真，
 * 支持寻源运行中直接查看已筛出的候选买家线索，打破长时间黑盒等待。
 */
import type { FunnelStageStatus, StreamingFunnelProgress } from '@gain-saas/shared';

import { computed } from 'vue';

import { Button, Progress, Space, Tag } from 'ant-design-vue';

import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { $t } from '#/locales';

defineOptions({ name: 'StreamingProgressBoard' });

const props = withDefaults(
  defineProps<{
    progress: StreamingFunnelProgress;
    compact?: boolean;
    cancelling?: boolean;
    showLeadsAction?: boolean;
    showCancelAction?: boolean;
    title?: string;
  }>(),
  {
    compact: false,
    cancelling: false,
    showLeadsAction: true,
    showCancelAction: false,
    title: '',
  },
);

const emit = defineEmits<{
  cancel: [];
  refresh: [];
  'view-leads': [];
}>();

function stageTone(status: FunnelStageStatus): 'danger' | 'info' | 'neutral' | 'success' {
  if (status === 'done') return 'success';
  if (status === 'running') return 'info';
  if (status === 'stopped') return 'danger';
  return 'neutral';
}

function stageStatusText(status: FunnelStageStatus): string {
  const key = `gainos.streaming.stageStatus.${status}` as Parameters<typeof $t>[0];
  return $t(key);
}

const elapsedLabel = computed(() => {
  const sec = props.progress.elapsedSec;
  if (sec === null || sec < 0) return '';
  if (sec < 60) return $t('gainos.streaming.seconds', { count: sec });
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return $t('gainos.streaming.minutesSeconds', { mins, secs: rem });
});

const headerTone = computed<'danger' | 'info' | 'neutral' | 'success'>(() => {
  if (props.progress.activeStage === 'STOPPED') return 'danger';
  if (props.progress.activeStage === 'DONE') return 'success';
  if (props.progress.isRunning) return 'info';
  return 'neutral';
});

const headerStatusLabel = computed(() => {
  if (props.progress.activeStage === 'STOPPED') return $t('gainos.streaming.statusStopped');
  if (props.progress.activeStage === 'DONE') return $t('gainos.streaming.statusDone');
  return $t('gainos.streaming.statusRunning');
});
</script>

<template>
  <GsCard
    class="spb-card"
    :class="{ 'spb-card--compact': compact }"
    data-gs="streaming-progress-board"
    :padding="compact ? '14px 18px' : '18px 20px'"
  >
    <div class="spb-head">
      <div class="spb-head__title-wrap">
        <span v-if="progress.isRunning" class="spb-pulse" aria-hidden="true"></span>
        <h3 class="spb-title">
          {{ title || $t('gainos.streaming.title') }}
        </h3>
        <GsTag :tone="headerTone" data-gs="streaming-status-tag">
          {{ headerStatusLabel }}
        </GsTag>
        <Tag v-if="progress.isStreamingMode" :bordered="false" class="spb-badge">
          {{ $t('gainos.streaming.modeStreaming') }}
        </Tag>
        <span v-if="elapsedLabel" class="spb-meta">
          {{ $t('gainos.streaming.elapsed', { time: elapsedLabel }) }}
        </span>
        <span v-if="progress.firstBuyerSeconds !== null" class="spb-meta">
          {{ $t('gainos.streaming.firstBuyerIn', { secs: progress.firstBuyerSeconds }) }}
        </span>
      </div>

      <Space :size="8" wrap>
        <Button
          v-if="showLeadsAction && progress.readyCandidates > 0"
          data-gs="streaming-view-leads"
          size="small"
          type="primary"
          @click="emit('view-leads')"
        >
          {{ $t('gainos.streaming.viewReadyBuyers', { count: progress.readyCandidates }) }}
        </Button>
        <Button size="small" data-gs="streaming-refresh" @click="emit('refresh')">
          {{ $t('gainos.common.refresh') }}
        </Button>
        <Button
          v-if="showCancelAction && progress.isRunning"
          :loading="cancelling"
          danger
          data-gs="streaming-cancel"
          size="small"
          @click="emit('cancel')"
        >
          {{ $t('gainos.streaming.stopDiscovery') }}
        </Button>
      </Space>
    </div>

    <!-- 三段流式漏斗进度条 -->
    <div class="spb-stages">
      <!-- L0 召回入池 -->
      <div class="spb-stage" data-gs="streaming-stage-l0">
        <div class="spb-stage__head">
          <span class="spb-stage__name">{{ $t('gainos.streaming.l0Title') }}</span>
          <GsTag :tone="stageTone(progress.l0.status)">
            {{ stageStatusText(progress.l0.status) }}
          </GsTag>
        </div>
        <Progress
          :percent="progress.l0.percent"
          :show-info="false"
          :status="progress.l0.status === 'running' ? 'active' : progress.l0.status === 'stopped' ? 'exception' : 'normal'"
          size="small"
        />
        <div class="spb-stage__metrics">
          <span>
            {{ $t('gainos.streaming.l0Recalled', { count: progress.l0.recalled }) }}
          </span>
          <span>
            {{ $t('gainos.streaming.l0Persisted', { count: progress.l0.persisted }) }}
          </span>
          <span v-if="progress.l0.sourcesTotal > 0">
            {{
              $t('gainos.streaming.l0Sources', {
                done: progress.l0.sourcesDone,
                total: progress.l0.sourcesTotal,
              })
            }}
          </span>
        </div>
      </div>

      <!-- L1 极速提取与匹配判分 -->
      <div class="spb-stage" data-gs="streaming-stage-l1">
        <div class="spb-stage__head">
          <span class="spb-stage__name">{{ $t('gainos.streaming.l1Title') }}</span>
          <GsTag :tone="stageTone(progress.l1.status)">
            {{ stageStatusText(progress.l1.status) }}
          </GsTag>
        </div>
        <Progress
          :percent="progress.l1.percent"
          :show-info="false"
          :status="progress.l1.status === 'running' ? 'active' : progress.l1.status === 'stopped' ? 'exception' : 'normal'"
          size="small"
        />
        <div class="spb-stage__metrics">
          <span>
            {{ $t('gainos.streaming.l1Judged', { count: progress.l1.judged }) }}
          </span>
          <span class="spb-metric--strong">
            {{ $t('gainos.streaming.l1Matched', { count: progress.l1.matched }) }}
          </span>
          <span>
            {{ $t('gainos.streaming.l1Excluded', { count: progress.l1.excluded }) }}
          </span>
          <span v-if="progress.httpFirstRatioPct !== null" class="spb-metric--accent">
            {{ $t('gainos.streaming.httpFirstRatio', { pct: progress.httpFirstRatioPct }) }}
          </span>
        </div>
      </div>

      <!-- L2 Top-K 联系人与邮箱验真 -->
      <div class="spb-stage" data-gs="streaming-stage-l2">
        <div class="spb-stage__head">
          <span class="spb-stage__name">{{ $t('gainos.streaming.l2Title') }}</span>
          <GsTag :tone="stageTone(progress.l2.status)">
            {{ stageStatusText(progress.l2.status) }}
          </GsTag>
        </div>
        <Progress
          :percent="progress.l2.percent"
          :show-info="false"
          :status="progress.l2.status === 'running' ? 'active' : progress.l2.status === 'stopped' ? 'exception' : 'normal'"
          size="small"
        />
        <div class="spb-stage__metrics">
          <span>
            {{
              $t('gainos.streaming.l2Enriched', {
                done: progress.l2.enriched,
                total: progress.l2.queued,
              })
            }}
          </span>
          <span>
            {{ $t('gainos.streaming.l2Contacts', { count: progress.l2.contactsFound }) }}
          </span>
          <span class="spb-metric--strong">
            {{ $t('gainos.streaming.l2VerifiedEmails', { count: progress.l2.verifiedEmails }) }}
          </span>
        </div>
      </div>
    </div>

    <!-- 方案 B 实时候选买家流式卡片（运行中即可渐进查看，不必干等整轮结束） -->
    <div
      v-if="!compact && progress.recentCandidates.length > 0"
      class="spb-recent"
      data-gs="streaming-recent-candidates"
    >
      <div class="spb-recent__head">
        <span class="spb-recent__title">{{ $t('gainos.streaming.recentCandidatesTitle') }}</span>
        <span class="spb-meta">
          {{ $t('gainos.streaming.recentCandidatesCount', { count: progress.recentCandidates.length }) }}
        </span>
      </div>
      <div class="spb-recent__grid">
        <div
          v-for="cand in progress.recentCandidates.slice(0, 6)"
          :key="cand.companyId"
          class="spb-cand"
          data-gs="streaming-candidate-card"
        >
          <div class="spb-cand__top">
            <strong class="spb-cand__name">{{ cand.name }}</strong>
            <Space :size="4">
              <Tag v-if="cand.country" :bordered="false" class="m-0 text-xs">{{ cand.country }}</Tag>
              <GsTag
                v-if="cand.fitVerdict"
                :tone="cand.fitVerdict === 'match' ? 'success' : cand.fitVerdict === 'weak' ? 'warning' : 'neutral'"
              >
                {{ $t(`gainos.streaming.verdict.${cand.fitVerdict}`) }}
              </GsTag>
            </Space>
          </div>
          <p v-if="cand.reasonSummary" class="spb-cand__reason">{{ cand.reasonSummary }}</p>
          <div class="spb-cand__meta">
            <span v-if="cand.domain">{{ cand.domain }}</span>
            <span v-if="cand.fetchMethod">
              {{ $t(`gainos.streaming.fetchMethod.${cand.fetchMethod}`) }}
            </span>
            <span v-if="cand.channelsFound.emails > 0">
              {{ $t('gainos.streaming.channelEmails', { count: cand.channelsFound.emails }) }}
            </span>
            <span v-if="cand.channelsFound.phones > 0">
              {{ $t('gainos.streaming.channelPhones', { count: cand.channelsFound.phones }) }}
            </span>
            <span v-if="cand.channelsFound.forms > 0">
              {{ $t('gainos.streaming.channelForms', { count: cand.channelsFound.forms }) }}
            </span>
            <span v-if="cand.channelsFound.socials > 0">
              {{ $t('gainos.streaming.channelSocials', { count: cand.channelsFound.socials }) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <p v-if="!compact && progress.isRunning" class="spb-footnote">
      {{ $t('gainos.streaming.progressiveHint') }}
    </p>
  </GsCard>
</template>

<style scoped>
.spb-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.spb-head__title-wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.spb-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--gs-fg, #111827);
}
.spb-pulse {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--gs-accent, #2563eb);
  box-shadow: 0 0 0 4px var(--gs-accent-soft, rgba(37, 99, 235, 0.18));
}
.spb-badge {
  margin: 0;
  font-size: 11.5px;
  background: var(--gs-accent-soft, #eff6ff);
  color: var(--gs-accent-fg, #1d4ed8);
}
.spb-meta {
  font-size: 12px;
  color: var(--gs-fg-muted, #6b7280);
}
.spb-stages {
  display: grid;
  grid-template-columns: repeat(1, minmax(0, 1fr));
  gap: 10px;
}
@media (min-width: 720px) {
  .spb-stages {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.spb-stage {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--gs-divider, #e5e7eb);
  border-radius: 10px;
  background: var(--gs-surface-2, #f9fafb);
}
.spb-stage__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.spb-stage__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--gs-fg, #111827);
}
.spb-stage__metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  font-size: 12px;
  color: var(--gs-fg-muted, #6b7280);
}
.spb-metric--strong {
  font-weight: 600;
  color: var(--gs-fg, #111827);
}
.spb-metric--accent {
  color: var(--gs-accent-fg, #1d4ed8);
}
.spb-footnote {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--gs-fg-muted, #6b7280);
}
.spb-recent {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--gs-divider, #e5e7eb);
}
.spb-recent__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.spb-recent__title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--gs-fg, #111827);
}
.spb-recent__grid {
  display: grid;
  grid-template-columns: repeat(1, minmax(0, 1fr));
  gap: 8px;
}
@media (min-width: 720px) {
  .spb-recent__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
.spb-cand {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--gs-divider, #e5e7eb);
  border-radius: 8px;
  background: var(--gs-surface, #fff);
}
.spb-cand__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.spb-cand__name {
  font-size: 13px;
  color: var(--gs-fg, #111827);
  overflow-wrap: anywhere;
}
.spb-cand__reason {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--gs-fg-muted, #6b7280);
}
.spb-cand__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 11.5px;
  color: var(--gs-fg-subtle, #6b7280);
}
</style>
