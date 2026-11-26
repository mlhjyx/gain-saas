<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import { formatCredits, formatDateTime, formatMicrosUsd } from '@gain-saas/shared';

defineOptions({ name: 'OpsWalletPanel' });

type Row = Record<string, any>;

const emit = defineEmits<{
  (e: 'notice', message: string): void;
  (e: 'error', message: string): void;
}>();

const loading = ref(false);
const accounts = ref<Row[]>([]);
const selectedWorkspaceId = ref('');
const priceCards = ref<Row[]>([]);
const profitData = ref<Row | null>(null);
const busy = ref(false);

const topUpForm = ref({
  credits: '1000',
  unitPriceMicros: '10000',
  externalOrderId: '',
  note: '',
});

const bonusForm = ref({
  credits: '200',
  sourceType: 'PROMO_BONUS' as 'PLAN_GRANT' | 'PROMO_BONUS' | 'MANUAL_ADJUST',
  expiresAt: '',
  externalOrderId: '',
  note: '',
});

const priceCardForm = ref({
  actionCode: 'DISCOVERY_QUALIFIED_LEAD',
  displayName: '有效买家线索',
  pricingMode: 'PER_UNIT_OUTCOME' as 'PER_UNIT_OUTCOME' | 'FLAT_ACTION',
  creditsPerUnit: '10',
  defaultHoldUnits: 20,
});

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message ?? body?.message ?? `HTTP ${response.status}`);
  }
  return body as T;
}

function fmtTime(value?: string | null): string {
  return formatDateTime(value) || '—';
}

async function loadAll(): Promise<void> {
  loading.value = true;
  try {
    const [accRes, cardRes, profitRes] = await Promise.all([
      api<{ data: Row[] }>('/api/ops/wallet/accounts?limit=200'),
      api<{ data: Row[] }>('/api/ops/wallet/price-cards?includeInactive=true'),
      api<{ data: Row }>('/api/ops/wallet/profit-reconciliation'),
    ]);
    accounts.value = accRes.data ?? [];
    priceCards.value = cardRes.data ?? [];
    profitData.value = profitRes.data ?? null;
    if (!selectedWorkspaceId.value && accounts.value.length > 0) {
      selectedWorkspaceId.value = String(accounts.value[0]!.workspaceId);
    }
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function submitTopUp(): Promise<void> {
  if (!selectedWorkspaceId.value || busy.value) return;
  const orderId = topUpForm.value.externalOrderId.trim();
  if (!orderId) {
    emit('error', '请填写幂等订单号（externalOrderId）');
    return;
  }
  busy.value = true;
  try {
    const res = await api<{ data: Row }>(
      `/api/ops/wallet/workspaces/${encodeURIComponent(selectedWorkspaceId.value)}/top-up`,
      {
        method: 'POST',
        body: JSON.stringify({
          credits: topUpForm.value.credits.trim(),
          unitPriceMicros: topUpForm.value.unitPriceMicros.trim(),
          externalOrderId: orderId,
          ...(topUpForm.value.note.trim() ? { note: topUpForm.value.note.trim() } : {}),
        }),
      },
    );
    emit(
      'notice',
      res.data?.idempotent
        ? `订单 ${orderId} 已幂等入账，未重复加点`
        : `已充值 ${formatCredits(topUpForm.value.credits)} 点（订单 ${orderId}）`,
    );
    topUpForm.value.externalOrderId = '';
    topUpForm.value.note = '';
    await loadAll();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

async function submitGrantBonus(): Promise<void> {
  if (!selectedWorkspaceId.value || busy.value) return;
  const orderId = bonusForm.value.externalOrderId.trim();
  if (!orderId) {
    emit('error', '请填写赠点幂等单号（externalOrderId）');
    return;
  }
  busy.value = true;
  try {
    const expiresIso = bonusForm.value.expiresAt.trim()
      ? new Date(bonusForm.value.expiresAt.trim()).toISOString()
      : null;
    const res = await api<{ data: Row }>(
      `/api/ops/wallet/workspaces/${encodeURIComponent(selectedWorkspaceId.value)}/grant-bonus`,
      {
        method: 'POST',
        body: JSON.stringify({
          credits: bonusForm.value.credits.trim(),
          sourceType: bonusForm.value.sourceType,
          expiresAt: expiresIso,
          externalOrderId: orderId,
          ...(bonusForm.value.note.trim() ? { note: bonusForm.value.note.trim() } : {}),
        }),
      },
    );
    emit(
      'notice',
      res.data?.idempotent
        ? `赠点单 ${orderId} 已幂等入账`
        : `已发放 ${formatCredits(bonusForm.value.credits)} 赠点（优先抵扣）`,
    );
    bonusForm.value.externalOrderId = '';
    bonusForm.value.note = '';
    await loadAll();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

async function toggleWalletStatus(account: Row): Promise<void> {
  if (busy.value) return;
  const nextStatus = account.walletStatus === 'FROZEN' ? 'ACTIVE' : 'FROZEN';
  busy.value = true;
  try {
    await api(`/api/ops/wallet/workspaces/${encodeURIComponent(String(account.workspaceId))}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    emit('notice', `工作空间钱包状态已更新为 ${nextStatus}`);
    await loadAll();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

async function createPriceCard(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await api('/api/ops/wallet/price-cards', {
      method: 'POST',
      body: JSON.stringify({
        actionCode: priceCardForm.value.actionCode.trim(),
        displayName: priceCardForm.value.displayName.trim(),
        pricingMode: priceCardForm.value.pricingMode,
        creditsPerUnit: priceCardForm.value.creditsPerUnit.trim(),
        defaultHoldUnits: Number(priceCardForm.value.defaultHoldUnits),
        active: true,
      }),
    });
    emit('notice', `价目表 ${priceCardForm.value.actionCode} 新版本已生效`);
    await loadAll();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

async function triggerSweep(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const res = await api<{ data: { scanned: number; released: number; failed: number } }>(
      '/api/ops/wallet/sweep-expired-holds',
      { method: 'POST', body: '{}' },
    );
    emit(
      'notice',
      `过期预占巡检完成：扫描 ${res.data?.scanned ?? 0} 条，释放 ${res.data?.released ?? 0} 条`,
    );
    await loadAll();
  } catch (err) {
    emit('error', err instanceof Error ? err.message : String(err));
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void loadAll();
});
</script>

<template>
  <!-- terms-lint-disable-file: 运营台积分钱包与毛利对账面板，供平台运营核对租户余额、手动充值赠点、价目表与底层成本毛利 -->
  <div class="ops__stack" data-gs="ops-wallet-panel">
    <div class="ops__toolbar">
      <strong>租户充值钱包总览</strong>
      <button type="button" class="ops__btn" :disabled="loading" @click="loadAll">
        {{ loading ? '加载中…' : '刷新数据' }}
      </button>
      <button
        type="button"
        class="ops__btn"
        :disabled="busy"
        data-gs="ops-wallet-sweep-btn"
        @click="triggerSweep"
      >
        立即巡检过期预占
      </button>
    </div>

    <div class="ops__table-wrap">
      <table class="ops__table" data-gs="ops-wallet-accounts-table">
        <thead>
          <tr>
            <th>工作空间</th>
            <th>可用积分</th>
            <th>预占中</th>
            <th>累计付费充值</th>
            <th>累计实扣</th>
            <th>状态</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="acc in accounts" :key="acc.workspaceId">
            <td>
              <strong>{{ acc.workspaceName }}</strong>
              <br />
              <small class="ops__muted">{{ acc.workspaceId }}</small>
            </td>
            <td>{{ formatCredits(acc.availableCredits) }}</td>
            <td>{{ formatCredits(acc.heldCredits) }}</td>
            <td>{{ formatCredits(acc.lifetimeToppedUp) }}</td>
            <td>{{ formatCredits(acc.lifetimeSpent) }}</td>
            <td>{{ acc.walletStatus }}</td>
            <td>{{ fmtTime(acc.updatedAt) }}</td>
            <td class="ops__row-actions">
              <button
                type="button"
                class="ops__btn"
                @click="selectedWorkspaceId = String(acc.workspaceId)"
              >
                选中
              </button>
              <button
                type="button"
                class="ops__btn"
                :disabled="busy"
                @click="toggleWalletStatus(acc)"
              >
                {{ acc.walletStatus === 'FROZEN' ? '解冻' : '冻结' }}
              </button>
            </td>
          </tr>
          <tr v-if="accounts.length === 0">
            <td colspan="8" class="ops__muted">暂无工作空间钱包记录</td>
          </tr>
        </tbody>
      </table>
    </div>

    <article class="ops__card ops__card--wide" data-gs="ops-wallet-credit-ops">
      <h3>手动充值与发放赠点</h3>
      <div class="ops__toolbar">
        <label>
          目标工作空间
          <select v-model="selectedWorkspaceId" data-gs="ops-wallet-ws-select">
            <option v-for="acc in accounts" :key="acc.workspaceId" :value="String(acc.workspaceId)">
              {{ acc.workspaceName }} ({{ formatCredits(acc.availableCredits) }} 点)
            </option>
          </select>
        </label>
      </div>

      <div class="ops__toolbar" data-gs="ops-wallet-topup-form">
        <strong>付费充值（永不过期）</strong>
        <label>点数 <input v-model="topUpForm.credits" type="text" data-gs="ops-topup-credits" /></label>
        <label>单价(µUSD) <input v-model="topUpForm.unitPriceMicros" type="text" data-gs="ops-topup-price" /></label>
        <label>幂等订单号 <input v-model="topUpForm.externalOrderId" type="text" data-gs="ops-topup-order" /></label>
        <label>备注 <input v-model="topUpForm.note" type="text" data-gs="ops-topup-note" /></label>
        <button
          type="button"
          class="ops__btn ops__btn--primary"
          :disabled="busy || !selectedWorkspaceId"
          data-gs="ops-topup-submit"
          @click="submitTopUp"
        >
          确认充值
        </button>
      </div>

      <div class="ops__toolbar" data-gs="ops-wallet-bonus-form">
        <strong>赠点发放（优先抵扣）</strong>
        <label>点数 <input v-model="bonusForm.credits" type="text" data-gs="ops-bonus-credits" /></label>
        <label>
          类型
          <select v-model="bonusForm.sourceType" data-gs="ops-bonus-source">
            <option value="PROMO_BONUS">PROMO_BONUS</option>
            <option value="PLAN_GRANT">PLAN_GRANT</option>
            <option value="MANUAL_ADJUST">MANUAL_ADJUST</option>
          </select>
        </label>
        <label>到期时间(可选 ISO) <input v-model="bonusForm.expiresAt" type="text" placeholder="2026-12-31T23:59:59Z" /></label>
        <label>幂等单号 <input v-model="bonusForm.externalOrderId" type="text" data-gs="ops-bonus-order" /></label>
        <label>备注 <input v-model="bonusForm.note" type="text" /></label>
        <button
          type="button"
          class="ops__btn"
          :disabled="busy || !selectedWorkspaceId"
          data-gs="ops-bonus-submit"
          @click="submitGrantBonus"
        >
          发放赠点
        </button>
      </div>
    </article>

    <article class="ops__card ops__card--wide" data-gs="ops-wallet-price-cards">
      <h3>商业价目表（billing_price_card）</h3>
      <div class="ops__toolbar">
        <label>动作码 <input v-model="priceCardForm.actionCode" type="text" data-gs="ops-pc-action" /></label>
        <label>显示名 <input v-model="priceCardForm.displayName" type="text" data-gs="ops-pc-name" /></label>
        <label>
          模式
          <select v-model="priceCardForm.pricingMode" data-gs="ops-pc-mode">
            <option value="PER_UNIT_OUTCOME">PER_UNIT_OUTCOME</option>
            <option value="FLAT_ACTION">FLAT_ACTION</option>
          </select>
        </label>
        <label>每单位点数 <input v-model="priceCardForm.creditsPerUnit" type="text" data-gs="ops-pc-credits" /></label>
        <label>默认预占份数 <input v-model.number="priceCardForm.defaultHoldUnits" type="number" min="1" data-gs="ops-pc-hold" /></label>
        <button
          type="button"
          class="ops__btn ops__btn--primary"
          :disabled="busy"
          data-gs="ops-pc-submit"
          @click="createPriceCard"
        >
          发布新版本价目
        </button>
      </div>

      <div class="ops__table-wrap">
        <table class="ops__table">
          <thead>
            <tr>
              <th>action_code</th>
              <th>名称</th>
              <th>模式</th>
              <th>单价(点)</th>
              <th>默认预占</th>
              <th>生效中</th>
              <th>生效时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="card in priceCards" :key="card.id">
              <td><code>{{ card.actionCode }}</code></td>
              <td>{{ card.displayName }}</td>
              <td>{{ card.pricingMode }}</td>
              <td>{{ formatCredits(card.creditsPerUnit) }}</td>
              <td>{{ card.defaultHoldUnits }}</td>
              <td>{{ card.active ? 'ACTIVE' : 'INACTIVE' }}</td>
              <td>{{ fmtTime(card.effectiveFrom) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>

    <article class="ops__card ops__card--wide" data-gs="ops-wallet-profit-card">
      <h3>毛利对账视图（最近 30 天：wallet_ledger 实收 vs global_dev.usage_ledger 底层成本）</h3>
      <p v-if="profitData?.engineCostStatus !== 'ok'" class="ops__muted">
        底层成本状态：{{ profitData?.engineCostStatus ?? 'unavailable' }}
        <span v-if="profitData?.engineCostReason">（{{ profitData.engineCostReason }}）</span>
      </p>
      <p v-if="profitData?.totals" class="ops__muted" data-gs="ops-profit-totals">
        实扣总点数：{{ formatCredits(profitData.totals.settledCredits) }} · 商业实收：
        <strong>{{ formatMicrosUsd(profitData.totals.paidRevenueMicros) }}</strong> · 引擎底层成本：
        <strong>{{ formatMicrosUsd(profitData.totals.engineCostMicros) }}</strong> · 毛利：
        <strong>{{ formatMicrosUsd(profitData.totals.grossProfitMicros) }}</strong>
        <span v-if="profitData.totals.grossMarginPct !== null">
          （毛利率 {{ profitData.totals.grossMarginPct }}%）
        </span>
      </p>
      <div class="ops__table-wrap">
        <table class="ops__table" data-gs="ops-profit-table">
          <thead>
            <tr>
              <th>工作空间</th>
              <th>实扣点数</th>
              <th>商业实收</th>
              <th>底层成本</th>
              <th>毛利</th>
              <th>毛利率</th>
              <th>充值/赠点</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in profitData?.rows ?? []" :key="row.workspaceId">
              <td>{{ row.workspaceName }}</td>
              <td>{{ formatCredits(row.settledCredits) }}</td>
              <td>{{ formatMicrosUsd(row.paidRevenueMicros) }}</td>
              <td>{{ formatMicrosUsd(row.engineCostMicros) }}</td>
              <td>{{ formatMicrosUsd(row.grossProfitMicros) }}</td>
              <td>{{ row.grossMarginPct === null ? '—' : `${row.grossMarginPct}%` }}</td>
              <td>{{ formatCredits(row.topUpCredits) }} / {{ formatCredits(row.bonusCredits) }}</td>
            </tr>
            <tr v-if="(profitData?.rows ?? []).length === 0">
              <td colspan="7" class="ops__muted">当前窗口尚无账本流水或底层消耗记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </div>
</template>
