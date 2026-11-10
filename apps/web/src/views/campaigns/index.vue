<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Alert, Button, Form, Input, Modal, Table } from 'ant-design-vue';

import { formatDateTime, glossaryStatus, statusClass } from '@gain-saas/shared';

import { $t } from '#/locales';

import AsyncSection from '#/components/gainos/async-section.vue';
import PageContainer from '#/components/gainos/page-container.vue';
import PageHeader from '#/components/gainos/page-header.vue';

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

function ctaOf(status: string): string {
  // QW17：末列按状态给出明确动作，不再只显示「查看/—」。
  if (status === 'DRAFT') return $t('gainos.campaigns.ctaDraft');
  if (status === 'ACTIVE') return $t('gainos.campaigns.ctaActive');
  return $t('gainos.campaigns.ctaView');
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

const columns = [
  { key: 'name', dataIndex: 'name', title: $t('gainos.campaigns.colName') },
  { key: 'status', dataIndex: 'status', title: $t('gainos.campaigns.colStatus'), width: 130 },
  { key: 'plan', dataIndex: 'plan', title: $t('gainos.campaigns.colPlan'), width: 220 },
  { key: 'updatedAt', dataIndex: 'updatedAt', title: $t('gainos.campaigns.colUpdated'), width: 170 },
  { key: 'actions', dataIndex: 'actions', title: '', width: 120 },
];

onMounted(load);
</script>

<template>
  <PageContainer :compact="embedded" :class="{ 'cm--embedded': embedded }">
    <PageHeader
      v-if="!embedded"
      :subtitle="$t('gainos.campaigns.subtitle')"
      :title="$t('gainos.campaigns.title')"
    >
      <template #actions>
        <Button type="primary" @click="showCreate = true">
          {{ $t('gainos.campaigns.newCampaign') }}
        </Button>
      </template>
    </PageHeader>
    <div v-else class="cm__embedded-head">
      <Button type="primary" @click="showCreate = true">
        {{ $t('gainos.campaigns.newCampaign') }}
      </Button>
    </div>

    <Alert
      :message="$t('gainos.campaigns.shadowBanner')"
      banner
      role="note"
      type="warning"
    />

    <AsyncSection
      :error="error"
      :empty="!loading && !error && !hasCampaigns"
      :loading="loading"
      :loading-text="$t('gainos.common.loading')"
      :retry-text="$t('gainos.common.retry')"
      @retry="load"
    >
      <template #empty>
        <div class="cm__empty-body">
          <p>{{ $t('gainos.campaigns.empty') }}</p>
          <Button type="primary" @click="showCreate = true">{{ $t('gainos.campaigns.newCampaign') }}</Button>
        </div>
      </template>
      <Table
        :columns="columns"
        :data-source="campaigns"
        :pagination="false"
        :scroll="{ x: 760 }"
        :custom-row="(record: unknown) => ({ style: { cursor: 'pointer' }, onClick: () => open(record as CampaignSummary) })"
        row-key="id"
        size="middle"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">
            <strong>{{ record.name }}</strong>
            <p v-if="record.objective" class="cm__objective">{{ record.objective }}</p>
          </template>
          <template v-else-if="column.key === 'status'">
            <span class="gs-badge" :class="campaignBadgeClass(record.status)">{{ campaignStatusLabel(record.status) }}</span>
          </template>
          <template v-else-if="column.key === 'plan'">
            <template v-if="record.latestRevision">
              {{ $t('gainos.campaigns.revision', { no: record.latestRevision.revisionNo }) }}
              · {{ revisionStateLabel(record.latestRevision.state) }}
            </template>
            <template v-else>{{ $t('gainos.campaigns.noRevision') }}</template>
          </template>
          <template v-else-if="column.key === 'updatedAt'">
            {{ formatDateTime(record.updatedAt) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button type="link" size="small" @click.stop="open(record as CampaignSummary)">
              {{ ctaOf(record.status) }}
            </Button>
          </template>
        </template>
      </Table>
    </AsyncSection>

    <Modal
      v-model:open="showCreate"
      :confirm-loading="creating"
      :ok-text="$t('gainos.campaigns.create')"
      :title="$t('gainos.campaigns.newCampaign')"
      :width="480"
      @ok="create"
    >
      <Form layout="vertical">
        <Form.Item :label="$t('gainos.campaigns.nameLabel')">
          <Input v-model:value="name" :maxlength="200" />
        </Form.Item>
        <Form.Item :label="$t('gainos.campaigns.objectiveLabel')">
          <Input.TextArea v-model:value="objective" :maxlength="500" :rows="3" />
        </Form.Item>
      </Form>
      <Alert
        v-if="createError"
        :message="createError"
        role="alert"
        show-icon
        type="error"
      />
    </Modal>
  </PageContainer>
</template>

<style scoped>
.cm--embedded { padding: 0; max-width: none; margin: 0; gap: 12px; }
.cm__embedded-head { display: flex; justify-content: flex-end; }
.cm__objective { margin: 4px 0 0; color: var(--gs-fg-muted); font-size: 13px; }
.cm__empty-body { display: grid; place-items: center; gap: 12px; color: var(--gs-fg-muted); font-size: 13.5px; padding: 24px 0; }
.cm__empty-body p { margin: 0; }
</style>
