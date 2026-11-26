<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue';

import { Alert, Button } from 'ant-design-vue';
import { preferences } from '@vben/preferences';

import {
  creditsToUsd,
  formatCredits,
  formatDateTime,
  walletActionLabel,
  walletEntryTypeLabel,
  walletLotSourceLabel,
} from '@gain-saas/shared';

import { failureText } from '#/api/gainos';
import {
  walletApi,
  type BillingPriceCardView,
  type WalletCreditLotView,
  type WalletLedgerItemView,
  type WalletSummaryView,
} from '#/api/wallet';
import GsCard from '#/components/gainos/ui/gs-card.vue';
import GsEmpty from '#/components/gainos/ui/gs-empty.vue';
import GsSelect from '#/components/gainos/ui/gs-select.vue';
import GsStat from '#/components/gainos/ui/gs-stat.vue';
import GsTable from '#/components/gainos/ui/gs-table.vue';
import GsTag from '#/components/gainos/ui/gs-tag.vue';
import { $t } from '#/locales';

defineOptions({ name: 'WalletBillingCard' });

const props = withDefaults(
  defineProps<{
    isAdmin?: boolean;
  }>(),
  { isAdmin: true },
);

const loading = ref(false);
const loadingLedger = ref(false);
const loadingMore = ref(false);
const errorBox = ref<{ next?: string; title: string } | null>(null);

const summary = ref<WalletSummaryView | null>(null);
const lots = ref<WalletCreditLotView[]>([]);
const ledger = ref<WalletLedgerItemView[]>([]);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);
const entryTypeFilter = ref<string>('ALL');

const locale = computed(() => preferences.app.locale || 'zh-CN');

const accountStatusTone = computed<'danger' | 'success'>(() =>
  summary.value?.account.status === 'FROZEN' ? 'danger' : 'success',
);

const accountStatusLabel = computed(() =>
  summary.value?.account.status === 'FROZEN'
    ? $t('wallet.statusFrozen')
    : $t('wallet.statusActive'),
);

const entryTypeOptions = computed(() => [
  { value: 'ALL', label: $t('wallet.filterAll') },
  { value: 'TOPUP', label: $t('wallet.filterTopup') },
  { value: 'PLAN_GRANT', label: $t('wallet.filterBonus') },
  { value: 'HOLD', label: $t('wallet.filterHold') },
  { value: 'SETTLE', label: $t('wallet.filterSettle') },
  { value: 'RELEASE', label: $t('wallet.filterRelease') },
  { value: 'EXPIRE', label: $t('wallet.filterExpire') },
]);

const priceColumns = computed(() => [
  { key: 'action', dataIndex: 'displayName', title: $t('wallet.colAction'), width: 220 },
  { key: 'mode', dataIndex: 'pricingMode', title: $t('wallet.colMode'), width: 170 },
  { key: 'credits', dataIndex: 'creditsPerUnit', title: $t('wallet.colPrice'), width: 160 },
  { key: 'hold', dataIndex: 'defaultHoldUnits', title: $t('wallet.colDefaultHold'), width: 160 },
]);

const lotColumns = computed(() => [
  { key: 'source', dataIndex: 'sourceType', title: $t('wallet.colSource'), width: 150 },
  { key: 'remaining', dataIndex: 'remainingCredits', title: $t('wallet.colRemaining'), width: 180 },
  { key: 'priority', dataIndex: 'priority', title: $t('wallet.colPriority'), width: 140 },
  { key: 'expiresAt', dataIndex: 'expiresAt', title: $t('wallet.colExpiresAt'), width: 180 },
  { key: 'createdAt', dataIndex: 'createdAt', title: $t('wallet.colCreatedAt'), width: 180 },
]);

const ledgerColumns = computed(() => [
  { key: 'createdAt', dataIndex: 'createdAt', title: $t('wallet.colTime'), width: 170 },
  { key: 'entryType', dataIndex: 'entryType', title: $t('wallet.colType'), width: 140 },
  { key: 'action', dataIndex: 'actionCode', title: $t('wallet.colAction'), width: 170 },
  { key: 'delta', dataIndex: 'deltaAvailable', title: $t('wallet.colDelta'), width: 140 },
  { key: 'balance', dataIndex: 'balanceAvailable', title: $t('wallet.colBalanceAfter'), width: 140 },
  { key: 'units', dataIndex: 'billableUnits', title: $t('wallet.colUnits'), width: 110 },
]);

function fmtTime(value?: string | null): string {
  return formatDateTime(value) || '—';
}

function fmtPriceMode(mode: string): string {
  return mode === 'FLAT_ACTION'
    ? $t('wallet.modeFlat')
    : $t('wallet.modeOutcome');
}

function fmtAction(card: BillingPriceCardView): string {
  return walletActionLabel(card.actionCode, locale.value) || card.displayName;
}

function fmtEntryTone(entryType: string): 'danger' | 'info' | 'neutral' | 'success' | 'warning' {
  if (entryType === 'TOPUP' || entryType === 'PLAN_GRANT' || entryType === 'REFUND') return 'success';
  if (entryType === 'SETTLE') return 'info';
  if (entryType === 'HOLD') return 'warning';
  if (entryType === 'RELEASE' || entryType === 'EXPIRE') return 'neutral';
  return 'neutral';
}

function fmtDelta(row: WalletLedgerItemView): string {
  const avail = BigInt(row.deltaAvailable || '0');
  if (avail !== 0n) {
    return `${avail > 0n ? '+' : ''}${formatCredits(avail)}`;
  }
  const held = BigInt(row.deltaHeld || '0');
  if (held !== 0n) {
    return `${held > 0n ? '+' : ''}${formatCredits(held)}`;
  }
  return '0';
}

async function loadOverview(): Promise<void> {
  loading.value = true;
  errorBox.value = null;
  try {
    const sumRes = await walletApi.summary();
    summary.value = sumRes;
    if (props.isAdmin) {
      const lotsRes = await walletApi.lots(50);
      lots.value = Array.isArray(lotsRes) ? lotsRes : [];
    } else {
      lots.value = [];
    }
  } catch (err) {
    errorBox.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

async function loadLedger(reset = true): Promise<void> {
  if (!props.isAdmin) {
    ledger.value = [];
    nextCursor.value = null;
    hasMore.value = false;
    return;
  }
  if (reset) {
    loadingLedger.value = true;
  } else {
    loadingMore.value = true;
  }
  try {
    const res = await walletApi.ledger({
      limit: 20,
      ...(entryTypeFilter.value !== 'ALL' ? { entryType: entryTypeFilter.value } : {}),
      ...(!reset && nextCursor.value ? { cursor: nextCursor.value } : {}),
    });
    const items = res.data ?? [];
    if (reset) {
      ledger.value = items;
    } else {
      const seen = new Set(ledger.value.map((r) => r.id));
      ledger.value = [...ledger.value, ...items.filter((r) => !seen.has(r.id))];
    }
    nextCursor.value = res.page?.next_cursor ?? null;
    hasMore.value = Boolean(res.page?.has_more && res.page?.next_cursor);
  } catch (err) {
    errorBox.value = failureText(err);
  } finally {
    loadingLedger.value = false;
    loadingMore.value = false;
  }
}

async function refreshAll(): Promise<void> {
  nextCursor.value = null;
  hasMore.value = false;
  await Promise.all([loadOverview(), loadLedger(true)]);
}

watch(
  () => props.isAdmin,
  (isAdmin, prev) => {
    if (isAdmin && !prev) {
      void Promise.all([
        walletApi
          .lots(50)
          .then((res) => {
            lots.value = Array.isArray(res) ? res : [];
          })
          .catch((err) => {
            errorBox.value = failureText(err);
          }),
        loadLedger(true),
      ]);
    } else if (!isAdmin && prev) {
      lots.value = [];
      ledger.value = [];
      nextCursor.value = null;
      hasMore.value = false;
    }
  },
);

function onEntryTypeChange(): void {
  nextCursor.value = null;
  hasMore.value = false;
  void loadLedger(true);
}

defineExpose({ refreshAll, loading });

onMounted(() => {
  void refreshAll();
});
</script>

<template>
  <div class="grid grid-cols-1 gap-4 @container" data-gs="wallet-billing-card">
    <Alert v-if="errorBox" role="alert" show-icon type="warning">
      <template #message>{{ errorBox.title }}</template>
      <template v-if="errorBox.next" #description>{{ errorBox.next }}</template>
    </Alert>

    <GsCard :title="$t('wallet.overviewTitle')" data-gs="wallet-overview-card">
      <template #extra>
        <div class="flex flex-wrap items-center gap-2">
          <GsTag :tone="accountStatusTone" data-gs="wallet-status-tag">{{ accountStatusLabel }}</GsTag>
          <GsTag
            :tone="summary?.billingEnabled ? 'info' : 'neutral'"
            data-gs="wallet-mode-tag"
          >
            {{
              summary?.billingEnabled
                ? $t('wallet.modeEnabled')
                : $t('wallet.modePreview')
            }}
          </GsTag>
          <Button
            :disabled="loading"
            :loading="loading"
            data-gs="wallet-refresh-btn"
            size="small"
            @click="refreshAll"
          >
            {{ $t('wallet.refresh') }}
          </Button>
        </div>
      </template>

      <div class="grid gap-4">
        <div class="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2 @min-[1020px]:grid-cols-4">
          <div data-gs="wallet-stat-available">
            <GsStat
              :label="$t('wallet.statAvailable')"
              :loading="loading"
              :suffix="$t('wallet.unitCredits')"
              :value="formatCredits(summary?.account.availableCredits ?? '0')"
            />
          </div>
          <div data-gs="wallet-stat-held">
            <GsStat
              :label="$t('wallet.statHeld')"
              :loading="loading"
              :suffix="$t('wallet.unitCredits')"
              :value="formatCredits(summary?.account.heldCredits ?? '0')"
            />
          </div>
          <div data-gs="wallet-stat-bonus">
            <GsStat
              :label="$t('wallet.statBonus')"
              :loading="loading"
              :suffix="$t('wallet.unitCredits')"
              :value="formatCredits(summary?.lotsSummary.bonusCredits ?? '0')"
            />
          </div>
          <div data-gs="wallet-stat-spent">
            <GsStat
              :label="$t('wallet.statSpent')"
              :loading="loading"
              :suffix="$t('wallet.unitCredits')"
              :value="formatCredits(summary?.account.lifetimeSpent ?? '0')"
            />
          </div>
        </div>

        <p class="m-0 text-xs leading-relaxed text-[var(--gs-fg-subtle)]">
          {{
            $t('wallet.balanceNote', {
              paid: formatCredits(summary?.lotsSummary.paidCredits ?? '0'),
              usd: creditsToUsd(summary?.account.availableCredits ?? '0'),
              holds: summary?.activeHoldsCount ?? 0,
            })
          }}
        </p>
      </div>
    </GsCard>

    <GsCard :title="$t('wallet.priceListTitle')" data-gs="wallet-price-card">
      <div class="grid gap-3">
        <p class="m-0 text-sm text-[var(--gs-fg-muted)]">{{ $t('wallet.priceListDesc') }}</p>
        <GsEmpty v-if="!loading && (summary?.priceCards.length ?? 0) === 0" simple :title="$t('wallet.noPrices')" />
        <GsTable
          v-else
          :columns="priceColumns"
          :data-source="summary?.priceCards ?? []"
          :loading="loading"
          :scroll="{ x: 640 }"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'action'">
              <span class="text-xs font-medium text-[var(--gs-fg)]">{{ fmtAction(record) }}</span>
            </template>
            <template v-else-if="column.key === 'mode'">
              <GsTag tone="neutral">{{ fmtPriceMode(record.pricingMode) }}</GsTag>
            </template>
            <template v-else-if="column.key === 'credits'">
              <span class="text-xs font-medium text-[var(--gs-fg)]">
                {{ formatCredits(record.creditsPerUnit) }} {{ $t('wallet.unitCredits') }}
              </span>
            </template>
            <template v-else-if="column.key === 'hold'">
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{
                  $t('wallet.holdUnitsValue', {
                    units: record.defaultHoldUnits,
                    credits: formatCredits(BigInt(record.creditsPerUnit || '0') * BigInt(record.defaultHoldUnits || 1)),
                  })
                }}
              </span>
            </template>
          </template>
        </GsTable>
      </div>
    </GsCard>

    <GsCard v-if="props.isAdmin" :title="$t('wallet.lotsTitle')" data-gs="wallet-lots-card">
      <div class="grid gap-3">
        <GsEmpty v-if="!loading && lots.length === 0" simple :title="$t('wallet.noLots')" />
        <GsTable
          v-else
          :columns="lotColumns"
          :data-source="lots"
          :loading="loading"
          :scroll="{ x: 720 }"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'source'">
              <GsTag :tone="record.sourceType === 'TOPUP_PAID' ? 'info' : 'success'">
                {{ walletLotSourceLabel(record.sourceType, locale) }}
              </GsTag>
            </template>
            <template v-else-if="column.key === 'remaining'">
              <span class="text-xs font-medium text-[var(--gs-fg)]">
                {{ formatCredits(record.remainingCredits) }} / {{ formatCredits(record.initialCredits) }}
              </span>
            </template>
            <template v-else-if="column.key === 'priority'">
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ record.priority <= 5 ? $t('wallet.priorityBonus') : $t('wallet.priorityPaid') }}
              </span>
            </template>
            <template v-else-if="column.key === 'expiresAt'">
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ record.expiresAt ? fmtTime(record.expiresAt) : $t('wallet.neverExpires') }}
              </span>
            </template>
            <template v-else-if="column.key === 'createdAt'">
              <span class="text-xs text-[var(--gs-fg-muted)]">{{ fmtTime(record.createdAt) }}</span>
            </template>
          </template>
        </GsTable>
      </div>
    </GsCard>

    <GsCard v-if="props.isAdmin" :title="$t('wallet.ledgerTitle')" data-gs="wallet-ledger-card">
      <template #extra>
        <div class="w-[170px]" data-gs="wallet-ledger-filter">
          <GsSelect
            v-model="entryTypeFilter"
            :ariaLabel="$t('wallet.filterLabel')"
            :options="entryTypeOptions"
            @change="onEntryTypeChange"
          />
        </div>
      </template>

      <div class="grid gap-3">
        <GsEmpty v-if="!loadingLedger && ledger.length === 0" simple :title="$t('wallet.noLedger')" />
        <GsTable
          v-else
          :columns="ledgerColumns"
          :data-source="ledger"
          :loading="loadingLedger"
          :scroll="{ x: 760 }"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'createdAt'">
              <span class="text-xs text-[var(--gs-fg-muted)]">{{ fmtTime(record.createdAt) }}</span>
            </template>
            <template v-else-if="column.key === 'entryType'">
              <GsTag :tone="fmtEntryTone(record.entryType)">
                {{ walletEntryTypeLabel(record.entryType, locale) }}
              </GsTag>
            </template>
            <template v-else-if="column.key === 'action'">
              <span class="text-xs text-[var(--gs-fg)]">
                {{ record.actionCode ? walletActionLabel(record.actionCode, locale) : '—' }}
              </span>
            </template>
            <template v-else-if="column.key === 'delta'">
              <span class="font-mono text-xs font-medium text-[var(--gs-fg)]">{{ fmtDelta(record) }}</span>
            </template>
            <template v-else-if="column.key === 'balance'">
              <span class="font-mono text-xs text-[var(--gs-fg-muted)]">
                {{ formatCredits(record.balanceAvailable) }}
              </span>
            </template>
            <template v-else-if="column.key === 'units'">
              <span class="text-xs text-[var(--gs-fg-muted)]">
                {{ record.billableUnits !== null && record.billableUnits !== undefined ? record.billableUnits : '—' }}
              </span>
            </template>
          </template>
        </GsTable>

        <Button
          v-if="hasMore"
          :loading="loadingMore"
          block
          data-gs="wallet-ledger-load-more"
          @click="loadLedger(false)"
        >
          {{ $t('wallet.loadMore') }}
        </Button>
      </div>
    </GsCard>
  </div>
</template>
