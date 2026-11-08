<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { glossaryStatus, statusClass } from '@gain-saas/shared';

import { $t } from '#/locales';

import { failureText, gainosApi, type CampaignSummary } from '#/api/gainos';

defineOptions({ name: 'Campaigns' });

// 在「商机与触达」枢纽内嵌时不渲染自己的页头（父页已有标题与 tab）。
defineProps<{ embedded?: boolean }>();

const router = useRouter();

const campaigns = ref<CampaignSummary[]>([]);
const loading = ref(true);
const error = ref<{ title: string; why?: string; next?: string } | null>(null);

const creating = ref(false);
const showCreate = ref(false);
const name = ref('');
const objective = ref('');
const createError = ref<string | null>(null);

const revisionStateLabel = (state: string | null | undefined): string => {
  switch (state) {
    case 'DRAFT': return $t('gainos.campaigns.statusDRAFT');
    case 'SUBMITTED': return $t('gainos.campaigns.statusSUBMITTED');
    case 'APPROVED': return $t('gainos.campaigns.statusAPPROVED');
    case 'DECLINED': return $t('gainos.campaigns.statusDECLINED');
    case 'EXPIRED': return $t('gainos.campaigns.statusEXPIRED');
    case 'SUPERSEDED': return $t('gainos.campaigns.statusSUPERSEDED');
    default: return $t('gainos.campaigns.noRevision');
  }
};

function campaignBadgeClass(state?: string | null): string {
  const meta = glossaryStatus('campaign', state);
  return statusClass(meta?.tone ?? 'neutral');
}

const campaignStatusLabel = (status: string): string => {
  switch (status) {
    case 'ACTIVE': return $t('gainos.campaigns.campaignACTIVE');
    case 'PAUSED': return $t('gainos.campaigns.campaignPAUSED');
    case 'ARCHIVED': return $t('gainos.campaigns.campaignARCHIVED');
    default: return $t('gainos.campaigns.campaignDRAFT');
  }
};

function budgetOf(c: CampaignSummary): string {
  // 列表不展开 plan，预算上限在详情页展示；这里按有无草稿给出提示。
  return c.latestRevision ? $t('gainos.campaigns.open') : '—';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    campaigns.value = await gainosApi.campaigns();
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

async function create(): Promise<void> {
  createError.value = null;
  if (!name.value.trim()) {
    createError.value = $t('gainos.campaigns.nameLabel');
    return;
  }
  creating.value = true;
  try {
    const created = await gainosApi.createCampaign({
      name: name.value.trim(),
      ...(objective.value.trim() ? { objective: objective.value.trim() } : {}),
    });
    showCreate.value = false;
    name.value = '';
    objective.value = '';
    await router.push({ name: 'CampaignDetail', params: { campaignId: created.id } });
  } catch (err) {
    createError.value = failureText(err).title;
  } finally {
    creating.value = false;
  }
}

function open(campaign: CampaignSummary): void {
  void router.push({ name: 'CampaignDetail', params: { campaignId: campaign.id } });
}

const hasCampaigns = computed(() => campaigns.value.length > 0);

onMounted(load);
</script>

<template>
  <div class="cp" :class="{ 'is-embedded': embedded }">
    <header class="cp__head">
      <div v-if="!embedded">
        <span class="cp__stage">{{ $t('gainos.campaigns.stage') }}</span>
        <h1>{{ $t('gainos.campaigns.title') }}</h1>
        <p>{{ $t('gainos.campaigns.subtitle') }}</p>
      </div>
      <button class="cp__primary" type="button" @click="showCreate = true">
        {{ $t('gainos.campaigns.newCampaign') }}
      </button>
    </header>

    <p class="cp__banner" role="note">{{ $t('gainos.campaigns.shadowBanner') }}</p>

    <p v-if="loading" class="cp__hint">{{ $t('gainos.common.loading') }}</p>
    <div v-else-if="error" class="cp__error" role="alert">
      <strong>{{ error.title }}</strong>
      <p v-if="error.next">{{ error.next }}</p>
      <button type="button" @click="load">{{ $t('gainos.common.retry') }}</button>
    </div>
    <div v-else-if="!hasCampaigns" class="cp__empty">
      <p>{{ $t('gainos.campaigns.empty') }}</p>
      <button class="cp__primary" type="button" @click="showCreate = true">{{ $t('gainos.campaigns.newCampaign') }}</button>
    </div>

    <table v-else class="cp__table">
      <thead>
        <tr>
          <th>{{ $t('gainos.campaigns.colName') }}</th>
          <th>{{ $t('gainos.campaigns.colStatus') }}</th>
          <th>{{ $t('gainos.campaigns.colPlan') }}</th>
          <th>{{ $t('gainos.campaigns.colUpdated') }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="campaign in campaigns" :key="campaign.id">
          <td>
            <strong>{{ campaign.name }}</strong>
            <p class="cp__objective">{{ campaign.objective }}</p>
          </td>
          <td><span class="gs-badge" :class="campaignBadgeClass(campaign.status)">{{ campaignStatusLabel(campaign.status) }}</span></td>
          <td>
            <template v-if="campaign.latestRevision">
              {{ $t('gainos.campaigns.revision', { no: campaign.latestRevision.revisionNo }) }}
              · {{ revisionStateLabel(campaign.latestRevision.state) }}
            </template>
            <template v-else>{{ $t('gainos.campaigns.noRevision') }}</template>
          </td>
          <td>{{ new Date(campaign.updatedAt).toLocaleString() }}</td>
          <td>
            <button class="cp__link" type="button" @click="open(campaign)">
              {{ budgetOf(campaign) }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="showCreate" class="cp__modal" role="dialog" aria-modal="true">
      <div class="cp__card">
        <h2>{{ $t('gainos.campaigns.newCampaign') }}</h2>
        <label>
          {{ $t('gainos.campaigns.nameLabel') }}
          <input v-model="name" type="text" maxlength="200" />
        </label>
        <label>
          {{ $t('gainos.campaigns.objectiveLabel') }}
          <textarea v-model="objective" rows="3" maxlength="500" />
        </label>
        <p v-if="createError" class="cp__error-inline" role="alert">{{ createError }}</p>
        <div class="cp__actions">
          <button type="button" :disabled="creating" @click="create">
            {{ $t('gainos.campaigns.create') }}
          </button>
          <button type="button" class="cp__ghost" @click="showCreate = false">
            {{ $t('gainos.common.cancel') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp { max-width: 1280px; margin: 0 auto; padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px); }
.cp.is-embedded { padding: 0; max-width: none; margin: 0; }
.cp__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.cp__stage { display: inline-block; font-size: 12px; letter-spacing: 0.08em; color: var(--gs-fg-muted); text-transform: uppercase; }
.cp h1 { margin: 6px 0; font-size: 26px; }
.cp__head p { margin: 0; color: var(--gs-fg-muted); max-width: 640px; }
.cp__empty { border: 1px dashed var(--gs-border-dashed); border-radius: 16px; background: var(--gs-surface); padding: 40px 24px; display: grid; place-items: center; gap: 12px; color: var(--gs-fg-muted); font-size: 13.5px; }
.cp__empty p { margin: 0; }
.cp__primary { background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); border: none; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
.cp__banner { margin: 18px 0; padding: 10px 14px; border-radius: 8px; background: var(--gs-warn-bg); color: var(--gs-warn); }
.cp__hint { color: var(--gs-fg-muted); }
.cp__error { background: var(--gs-danger-bg); color: var(--gs-danger); padding: 12px 16px; border-radius: 8px; }
.cp__table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.cp__table th, .cp__table td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--gs-divider); vertical-align: top; }
.cp__objective { margin: 4px 0 0; color: var(--gs-fg-muted); font-size: 13px; }
.cp__link { border: none; background: none; color: var(--gs-accent-strong); cursor: pointer; text-decoration: underline; }
.cp__modal { position: fixed; inset: 0; background: rgba(30, 20, 8, 0.4); display: flex; align-items: center; justify-content: center; }
.cp__card { background: var(--gs-surface); border-radius: 12px; padding: 20px; width: min(480px, 92vw); display: grid; gap: 12px; }
.cp__card label { display: grid; gap: 6px; font-size: 14px; }
.cp__card input, .cp__card textarea { border: 1px solid var(--gs-border-strong); border-radius: 8px; padding: 8px 10px; font: inherit; }
.cp__actions { display: flex; gap: 8px; justify-content: flex-end; }
.cp__actions button { border-radius: 8px; padding: 8px 14px; border: none; background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); cursor: pointer; }
.cp__ghost { background: var(--gs-surface-2) !important; color: var(--gs-fg-muted) !important; }
.cp__error-inline { color: var(--gs-danger); margin: 0; }
</style>
