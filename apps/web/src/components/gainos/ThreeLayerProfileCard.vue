<script lang="ts" setup>
/**
 * 三层解耦画像审阅卡片（Phase 2 Track 2C）：
 * - 栏 1：我是谁（卖方档案，不混入买方检索与硬排除）
 * - 栏 2：我找谁（买方目标市场、采购角色与采购场景）
 * - 栏 3：排除谁（系统自动派生的同行排除 + 自定义排除）
 *
 * 用于注册极速引导第 3 步与找买家画像详情/创建预览；支持只读与可编辑两种模式。
 */
import type { ThreeLayerProfileView } from '@gain-saas/shared';

import { ref } from 'vue';

import { BUYER_ROLE_CODES } from '@gain-saas/shared';
import { Button, Input, Tag } from 'ant-design-vue';

import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { $t } from '#/locales';

defineOptions({ name: 'ThreeLayerProfileCard' });

const props = withDefaults(
  defineProps<{
    profile: ThreeLayerProfileView;
    editable?: boolean;
    selectedRoles?: string[];
    customExclusions?: string[];
  }>(),
  {
    editable: false,
    selectedRoles: () => [],
    customExclusions: () => [],
  },
);

const emit = defineEmits<{
  'update:selectedRoles': [roles: string[]];
  'update:customExclusions': [exclusions: string[]];
}>();

const exclusionDraft = ref('');

function roleLabel(role: string): string {
  const key = `gainos.threeLayer.role.${role}` as Parameters<typeof $t>[0];
  const translated = $t(key);
  return translated === key ? role : translated;
}

function toggleRole(role: string): void {
  if (!props.editable) return;
  const set = new Set(props.selectedRoles);
  if (set.has(role)) set.delete(role);
  else set.add(role);
  emit('update:selectedRoles', [...set]);
}

function addExclusion(): void {
  const clean = exclusionDraft.value.trim().slice(0, 80);
  if (!clean) return;
  if (!props.customExclusions.includes(clean)) {
    emit('update:customExclusions', [...props.customExclusions, clean]);
  }
  exclusionDraft.value = '';
}

function removeCustomExclusion(item: string): void {
  emit(
    'update:customExclusions',
    props.customExclusions.filter((entry) => entry !== item),
  );
}
</script>

<template>
  <div class="tlp-grid" data-gs="three-layer-review">
    <!-- 栏 1：我是谁（卖方档案） -->
    <section class="tlp-col tlp-col--seller" data-gs="three-layer-seller">
      <div class="tlp-col__head">
        <GsTag tone="info">{{ $t('gainos.threeLayer.sellerBadge') }}</GsTag>
        <h3 class="tlp-col__title">{{ $t('gainos.threeLayer.sellerTitle') }}</h3>
      </div>
      <p class="tlp-col__desc">{{ $t('gainos.threeLayer.sellerDesc') }}</p>

      <div class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.companyAndIndustry') }}</span>
        <p class="tlp-value">
          <strong>{{ profile.sellerProfile.companyName || '—' }}</strong>
          <span v-if="profile.sellerProfile.industry" class="tlp-muted">
            · {{ profile.sellerProfile.industry }}
          </span>
        </p>
      </div>

      <div class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.products') }}</span>
        <div v-if="profile.sellerProfile.products.length > 0" class="tlp-chips">
          <Tag
            v-for="item in profile.sellerProfile.products"
            :key="item"
            :bordered="false"
            class="tlp-chip"
          >
            {{ item }}
          </Tag>
        </div>
        <p v-else class="tlp-muted">—</p>
      </div>

      <div v-if="profile.sellerProfile.technicalSpecs.length > 0" class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.technicalSpecs') }}</span>
        <div class="tlp-chips">
          <Tag
            v-for="spec in profile.sellerProfile.technicalSpecs.slice(0, 6)"
            :key="spec"
            :bordered="false"
            class="tlp-chip"
          >
            {{ spec }}
          </Tag>
        </div>
      </div>

      <div v-if="profile.sellerProfile.sellingPoints.length > 0" class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.sellingPoints') }}</span>
        <ul class="tlp-list">
          <li v-for="point in profile.sellerProfile.sellingPoints.slice(0, 4)" :key="point">
            {{ point }}
          </li>
        </ul>
      </div>

      <p v-if="profile.sellerProfile.sourceSummary" class="tlp-source">
        {{ $t('gainos.threeLayer.sourcePrefix') }}{{ profile.sellerProfile.sourceSummary }}
      </p>
    </section>

    <!-- 栏 2：我找谁（买方画像） -->
    <section class="tlp-col tlp-col--buyer" data-gs="three-layer-buyer">
      <div class="tlp-col__head">
        <GsTag tone="success">{{ $t('gainos.threeLayer.buyerBadge') }}</GsTag>
        <h3 class="tlp-col__title">{{ $t('gainos.threeLayer.buyerTitle') }}</h3>
      </div>
      <p class="tlp-col__desc">{{ $t('gainos.threeLayer.buyerDesc') }}</p>

      <div class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.targetMarkets') }}</span>
        <div v-if="profile.buyerSpec.targetMarkets.length > 0" class="tlp-chips">
          <Tag
            v-for="market in profile.buyerSpec.targetMarkets"
            :key="market"
            :bordered="false"
            class="tlp-chip tlp-chip--accent"
          >
            {{ market }}
          </Tag>
        </div>
        <p v-else class="tlp-muted">{{ $t('gainos.threeLayer.marketsAny') }}</p>
      </div>

      <div class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.buyerRoles') }}</span>
        <div v-if="editable" class="tlp-role-picks" data-gs="three-layer-role-picker">
          <button
            v-for="role in BUYER_ROLE_CODES"
            :key="role"
            :aria-pressed="selectedRoles.includes(role)"
            :data-gs="`buyer-role-${role}`"
            class="tlp-role-btn"
            :class="{ 'is-selected': selectedRoles.includes(role) }"
            type="button"
            @click="toggleRole(role)"
          >
            <span>{{ selectedRoles.includes(role) ? '✓' : '+' }}</span>
            <span>{{ roleLabel(role) }}</span>
          </button>
        </div>
        <div v-else-if="profile.buyerSpec.buyerRoles.length > 0" class="tlp-chips">
          <Tag
            v-for="role in profile.buyerSpec.buyerRoles"
            :key="role"
            :bordered="false"
            class="tlp-chip"
          >
            {{ roleLabel(role) }}
          </Tag>
        </div>
        <p v-else class="tlp-muted">{{ $t('gainos.threeLayer.rolesDefault') }}</p>
      </div>

      <div v-if="profile.buyerSpec.categoryBroad" class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.categoryBroad') }}</span>
        <p class="tlp-value">{{ profile.buyerSpec.categoryBroad }}</p>
      </div>

      <div v-if="profile.buyerSpec.procurementScenarios.length > 0" class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.scenarios') }}</span>
        <ul class="tlp-list">
          <li v-for="sc in profile.buyerSpec.procurementScenarios.slice(0, 4)" :key="sc">
            {{ sc }}
          </li>
        </ul>
      </div>
    </section>

    <!-- 栏 3：排除谁（同行与竞品） -->
    <section class="tlp-col tlp-col--exclude" data-gs="three-layer-exclusions">
      <div class="tlp-col__head">
        <GsTag tone="warning">{{ $t('gainos.threeLayer.excludeBadge') }}</GsTag>
        <h3 class="tlp-col__title">{{ $t('gainos.threeLayer.excludeTitle') }}</h3>
      </div>
      <p class="tlp-col__desc">{{ $t('gainos.threeLayer.excludeDesc') }}</p>

      <div class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.autoExcluded') }}</span>
        <div v-if="profile.peerExclusions.autoDerived.length > 0" class="tlp-chips">
          <Tag
            v-for="item in profile.peerExclusions.autoDerived"
            :key="item"
            :bordered="false"
            class="tlp-chip tlp-chip--warn"
          >
            {{ item }}
          </Tag>
        </div>
        <p v-else class="tlp-muted">{{ $t('gainos.threeLayer.noAutoExcluded') }}</p>
      </div>

      <div v-if="profile.peerExclusions.rationale" class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.exclusionRationale') }}</span>
        <p class="tlp-muted">{{ profile.peerExclusions.rationale }}</p>
      </div>

      <div v-if="editable || profile.peerExclusions.custom.length > 0" class="tlp-block">
        <span class="tlp-label">{{ $t('gainos.threeLayer.customExcluded') }}</span>
        <div v-if="(editable ? customExclusions : profile.peerExclusions.custom).length > 0" class="tlp-chips">
          <Tag
            v-for="item in editable ? customExclusions : profile.peerExclusions.custom"
            :key="item"
            :bordered="false"
            :closable="editable"
            class="tlp-chip"
            @close="removeCustomExclusion(item)"
          >
            {{ item }}
          </Tag>
        </div>
        <div v-if="editable" class="tlp-input-row">
          <Input
            v-model:value="exclusionDraft"
            :maxlength="80"
            :placeholder="$t('gainos.threeLayer.customExclusionPlaceholder')"
            data-gs="three-layer-exclusion-input"
            size="small"
            @press-enter="addExclusion"
          />
          <Button size="small" data-gs="three-layer-add-exclusion" @click="addExclusion">
            {{ $t('gainos.threeLayer.addExclusion') }}
          </Button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tlp-grid {
  display: grid;
  grid-template-columns: repeat(1, minmax(0, 1fr));
  gap: 12px;
}
@media (min-width: 760px) {
  .tlp-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.tlp-col {
  display: grid;
  gap: 10px;
  align-content: start;
  padding: 14px;
  border: 1px solid var(--gs-divider, #e5e7eb);
  border-radius: 10px;
  background: var(--gs-surface, #fff);
}
.tlp-col__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tlp-col__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--gs-fg, #111827);
}
.tlp-col__desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--gs-fg-muted, #6b7280);
}
.tlp-block {
  display: grid;
  gap: 4px;
}
.tlp-label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--gs-fg-subtle, #6b7280);
}
.tlp-value {
  margin: 0;
  font-size: 13px;
  color: var(--gs-fg, #111827);
  overflow-wrap: anywhere;
}
.tlp-muted {
  margin: 0;
  font-size: 12px;
  color: var(--gs-fg-muted, #6b7280);
}
.tlp-source {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--gs-fg-subtle, #6b7280);
}
.tlp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tlp-chip {
  margin: 0;
  font-size: 12px;
  border-radius: 6px;
  background: var(--gs-surface-2, #f3f4f6);
  color: var(--gs-fg-2, #374151);
}
.tlp-chip--accent {
  background: var(--gs-accent-soft, #eef2ff);
  color: var(--gs-accent-fg, #3730a3);
}
.tlp-chip--warn {
  background: var(--gs-warn-bg, #fef3c7);
  color: var(--gs-warn-fg, #92400e);
}
.tlp-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--gs-fg-2, #374151);
}
.tlp-role-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tlp-role-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--gs-divider, #d1d5db);
  border-radius: 999px;
  background: var(--gs-surface, #fff);
  color: var(--gs-fg-2, #374151);
  font-size: 12px;
  cursor: pointer;
}
.tlp-role-btn.is-selected {
  border-color: var(--gs-accent, #2563eb);
  background: var(--gs-accent-soft, #eff6ff);
  color: var(--gs-accent-fg, #1d4ed8);
  font-weight: 500;
}
.tlp-input-row {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
</style>
