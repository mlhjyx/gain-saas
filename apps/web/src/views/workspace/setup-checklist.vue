<script setup lang="ts">
import type {
  CompanyCompleteness,
  CompanyProfile,
  DiscoveryRun,
  DiscoveryRunLink,
  Icp,
  WorkspaceContextView,
} from '#/api/gainos';

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Alert, Button, Spin } from 'ant-design-vue';

import { failureText, gainosApi } from '#/api/gainos';
import { $t } from '#/locales';

import CompanySetupForm from './company-setup-form.vue';

const props = defineProps<{
  companies: CompanyProfile[];
  companiesStatus: 'error' | 'loading' | 'ready';
  completeness: Record<string, CompanyCompleteness>;
  dashboardReady: boolean;
  latestRun: DiscoveryRun | null;
  profiles: Icp[];
  runLinks: DiscoveryRunLink[];
}>();
const emit = defineEmits<{
  companySaved: [];
  modeChange: [mode: 'dashboard' | 'setup'];
}>();

const route = useRoute();
const router = useRouter();
const title = ref<HTMLElement | null>(null);
const context = ref<WorkspaceContextView | null>(null);
const contextLoading = ref(true);
const contextError = ref('');
const selectedMarketsAfterSave = ref<string[] | null>(null);
const dismissed = ref(false);

let contextRequest = 0;

async function loadContext(): Promise<void> {
  const request = ++contextRequest;
  contextLoading.value = true;
  contextError.value = '';
  try {
    const response = await gainosApi.workspaceContext();
    if (!response?.workspace?.id || typeof response.onboarding?.complete !== 'boolean') {
      throw new Error('Incomplete workspace context');
    }
    if (request !== contextRequest) return;
    if (context.value?.workspace.id !== response.workspace.id) {
      dismissed.value = false;
      selectedMarketsAfterSave.value = null;
    }
    context.value = response;
  } catch (error) {
    if (request === contextRequest) contextError.value = failureText(error).title;
  } finally {
    if (request === contextRequest) contextLoading.value = false;
  }
}

onMounted(loadContext);
watch(() => route.path, (path, prior) => {
  if (path === '/workspace' && prior !== '/workspace') {
    selectedMarketsAfterSave.value = null;
    void loadContext();
  }
});
onBeforeUnmount(() => { contextRequest += 1; });

const primaryCompany = computed(() => {
  const id = context.value?.onboarding.companyId;
  if (id) return props.companies.find((company) => company.id === id);
  // 企业档案已有以最早创建的公司为默认主档案的规则。
  return props.companies
    .filter((company) => company.id)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))[0];
});
const companyId = computed(() => context.value?.onboarding.companyId ?? primaryCompany.value?.id);
const markets = computed(() => selectedMarketsAfterSave.value ?? primaryCompany.value?.targetMarkets ?? []);
const member = computed(() => context.value?.workspace.role === 'member');
const explicit = computed(() => route.path === '/workspace' && route.query.setup === '1');
const notificationsLink = computed(() => route.path === '/workspace' && route.query.panel === 'notifications');
const activeProfile = computed(() => props.profiles.find((profile) => profile.status === 'ACTIVE'));
const relevantProfile = computed(() =>
  props.profiles.find((profile) => profile.companyId === companyId.value),
);
const factsReady = computed(() => {
  if (selectedMarketsAfterSave.value !== null) return true;
  const summary = companyId.value ? props.completeness[companyId.value] : null;
  return (summary?.offerings ?? 0) > 0 && (
    primaryCompany.value?.status === 'ACTIVE' ||
    context.value?.onboarding.complete === true ||
    (summary?.approvedClaims ?? 0) > 0
  );
});
const historyPending = ref(false);
const completedInHistory = ref(false);

function completed(status?: string): boolean {
  return status === 'DONE' || status === 'COMPLETED';
}

async function hasUsableResults(id: string): Promise<boolean> {
  const result = await gainosApi.discoveryRunResultView(id).catch(() => null);
  return (result?.candidates?.total ?? 0) > 0;
}

// 先读工作区的任务结果，已替换画像的旧结果也会入账。旧版任务只有寻源引用时补查状态。
watch(
  [() => props.dashboardReady, () => props.latestRun, () => props.runLinks, () => props.profiles],
  async ([ready, latest, links, profiles], _, onCleanup) => {
    let stale = false;
    onCleanup(() => { stale = true; });
    completedInHistory.value = false;
    historyPending.value = false;
    if (!ready || !activeProfile.value || completed(latest?.status)) return;
    historyPending.value = true;
    try {
      const tasks = await gainosApi.acquisitionTasks().catch(() => []);
      if (stale) return;
      const taskRuns = (Array.isArray(tasks) ? tasks : []).flatMap((task) => task.runs ?? []);
      if (taskRuns.some((run) => run.runId && completed(run.status))) {
        completedInHistory.value = true;
        return;
      }

      const candidates = new Map<string, string | undefined>();
      for (const run of taskRuns) {
        if (run.runId && run.status === 'PARTIAL') candidates.set(run.runId, run.status);
      }
      if (latest?.status === 'PARTIAL') candidates.set(latest.id, latest.status);
      for (const link of links) {
        if (link.runId !== latest?.id && !candidates.has(link.runId)) candidates.set(link.runId, undefined);
      }

      async function checkCandidates(): Promise<boolean> {
        const rows = [...candidates];
        candidates.clear();
        for (let offset = 0; offset < rows.length && !stale; offset += 4) {
          const results = await Promise.all(rows.slice(offset, offset + 4).map(async ([id, known]) => {
            const status = known ?? (await gainosApi.discoveryRun(id).catch(() => null))?.status;
            return completed(status) || (status === 'PARTIAL' && await hasUsableResults(id));
          }));
          if (results.some(Boolean)) return true;
        }
        return false;
      }

      let confirmed = await checkCandidates();
      const retired = profiles.filter((profile) => profile.status === 'SUPERSEDED' || profile.status === 'ARCHIVED');
      for (let offset = 0; !confirmed && !stale && offset < retired.length; offset += 4) {
        const historical = await Promise.all(
          retired.slice(offset, offset + 4).map((profile) => gainosApi.discoveryRunLinks(profile.id).catch(() => [])),
        );
        if (stale) return;
        for (const link of historical.flatMap((result) => Array.isArray(result) ? result : [])) {
          candidates.set(link.runId, undefined);
        }
        confirmed = await checkCandidates();
      }
      if (!stale) completedInHistory.value = confirmed;
    } finally {
      if (!stale) historyPending.value = false;
    }
  },
  { immediate: true },
);

const mature = computed(() =>
  Boolean(activeProfile.value && (completed(props.latestRun?.status) || completedInHistory.value)),
);
const needsSetup = computed(() => context.value?.onboarding.complete === false);
const activeStep = computed(() => {
  if (!companyId.value && !activeProfile.value) return 'source';
  if (!factsReady.value && !activeProfile.value) return 'facts';
  return 'profile';
});
const lightDashboard = computed(() =>
  needsSetup.value && !factsReady.value && !activeProfile.value && !dismissed.value,
);
const formVisible = computed(() =>
  needsSetup.value && !member.value && !factsReady.value && !activeProfile.value && (
    Boolean(context.value?.onboarding.companyId) ||
    (!companyId.value && props.companiesStatus === 'ready')
  ),
);
const visible = computed(() => Boolean(context.value) && (
  explicit.value || (!dismissed.value && !mature.value && (
    needsSetup.value || (props.dashboardReady && !historyPending.value && Boolean(companyId.value || activeProfile.value))
  ))
));
const focusReady = computed(() =>
  explicit.value && visible.value && Boolean(title.value),
);

watch(
  () => !notificationsLink.value && (contextLoading.value && !context.value || lightDashboard.value),
  (hide) => emit('modeChange', hide ? 'setup' : 'dashboard'),
  { immediate: true },
);
watch(focusReady, async (ready) => {
  if (!ready) return;
  await nextTick();
  title.value?.focus({ preventScroll: true });
  title.value?.scrollIntoView({ block: 'start' });
}, { flush: 'post' });

const steps = computed(() => [
  { key: 'source', done: Boolean(companyId.value || activeProfile.value) },
  { key: 'facts', done: factsReady.value || Boolean(activeProfile.value) },
  { key: 'markets', done: markets.value.length > 0 },
  { key: 'profile', done: Boolean(activeProfile.value) },
]);

function updateDraft(id: string | null): void {
  if (context.value) context.value.onboarding.companyId = id;
}

function onSaved(payload: { companyId: string; targetMarkets: string[] }): void {
  if (!context.value) return;
  context.value.onboarding = { companyId: payload.companyId, complete: true };
  selectedMarketsAfterSave.value = payload.targetMarkets;
  emit('companySaved');
}

function collapse(): void {
  dismissed.value = true;
  if (explicit.value) void router.replace({ query: { ...route.query, setup: undefined } });
}

const companyFacts = computed(() => ({
  path: '/companies',
  query: { companyId: companyId.value, tab: 'facts' },
}));
const companyMarkets = computed(() => ({
  path: '/companies',
  query: { companyId: companyId.value, tab: 'markets' },
}));
const buyerProfiles = computed(() => ({
  path: '/find-buyers',
  query: !member.value && companyId.value && !relevantProfile.value && !activeProfile.value
    ? { action: 'create', companyId: companyId.value }
    : undefined,
}));
</script>

<template>
  <div v-if="contextLoading && !context" class="setup-card setup-card--loading" role="status">
    <Spin size="small" /> {{ $t('gainos.onboarding.loading') }}
  </div>
  <Alert v-if="contextError" type="warning" show-icon :message="$t('gainosOb.setup.loadFailed')">
    <template #action>
      <Button size="small" @click="loadContext">{{ $t('gainos.common.retry') }}</Button>
    </template>
  </Alert>
  <section v-if="visible" class="setup-card" data-gs="workspace-setup" aria-labelledby="workspace-setup-title">
    <header class="setup-card__head">
      <div>
        <h2 id="workspace-setup-title" ref="title" tabindex="-1">{{ $t('gainosOb.setup.title') }}</h2>
        <p v-if="mature">{{ $t('gainosOb.setup.mature') }}</p>
        <p v-else-if="member && needsSetup">{{ $t('gainosOb.setup.member') }}</p>
        <p v-else-if="needsSetup">{{ $t('gainosOb.setup.startHint') }}</p>
      </div>
      <Button v-if="!lightDashboard || explicit" type="text" @click="collapse">
        {{ $t('gainosOb.setup.collapse') }}
      </Button>
    </header>

    <ol class="setup-card__steps">
      <li v-for="(step, index) in steps" :key="step.key"
        :class="{ 'is-done': step.done, 'is-current': !mature && !step.done && activeStep === step.key }"
        :aria-current="!mature && !step.done && activeStep === step.key ? 'step' : undefined">
        <span class="setup-card__number" aria-hidden="true">{{ step.done ? '✓' : index + 1 }}</span>
        <span>{{ $t('gainosOb.setup.steps.' + step.key) }}</span>
        <span v-if="step.done" class="sr-only">{{ $t('gainosOb.setup.done') }}</span>
      </li>
    </ol>

    <CompanySetupForm v-if="formVisible && context"
      :key="context.workspace.id"
      :company-id="companyId"
      :target-markets="markets"
      :workspace-name="context.workspace.name"
      @draft="updateDraft"
      @saved="onSaved"
    />
    <div v-else-if="!mature && companyId && !member" class="setup-card__actions">
      <RouterLink :to="companyFacts" class="setup-card__link">{{ $t('gainosOb.setup.companyFacts') }}</RouterLink>
      <RouterLink :to="companyMarkets" class="setup-card__link">{{ $t('gainosOb.setup.companyMarkets') }}</RouterLink>
      <RouterLink v-if="factsReady || activeProfile" :to="buyerProfiles" class="setup-card__primary">
        {{ $t(relevantProfile || activeProfile ? 'gainosOb.setup.viewProfile' : 'gainosOb.setup.createProfile') }}
      </RouterLink>
    </div>
    <div v-else-if="!mature && activeProfile" class="setup-card__actions">
      <RouterLink :to="buyerProfiles" class="setup-card__primary">{{ $t('gainosOb.setup.viewProfile') }}</RouterLink>
    </div>
    <p v-else-if="lightDashboard && !member && companiesStatus === 'loading'" class="setup-card__status" role="status">
      {{ $t('gainosOb.setup.loadingSources') }}
    </p>
  </section>
  <section v-if="lightDashboard" class="setup-card setup-card--quick" aria-labelledby="workspace-setup-quick-title" data-gs="workspace-setup-quick">
    <h2 id="workspace-setup-quick-title">{{ $t('gainosOb.setup.quickLinks') }}</h2>
    <div class="setup-card__actions">
      <RouterLink :to="companyFacts" class="setup-card__link">{{ $t('gainosOb.setup.companyFacts') }}</RouterLink>
      <RouterLink to="/leads" class="setup-card__link">{{ $t('gainosNav.leads') }}</RouterLink>
      <RouterLink to="/settings/members" class="setup-card__link">{{ $t('gainosOb.setup.team') }}</RouterLink>
    </div>
  </section>
  <div v-if="dismissed && !mature" class="setup-card__reopen">
    <Button type="text" @click="dismissed = false">{{ $t('gainosOb.setup.reopen') }}</Button>
  </div>
</template>

<style scoped>
.setup-card {
  container-type: inline-size;
  min-width: 0;
  padding: var(--gs-space-6);
  border: 1px solid var(--gs-border);
  border-radius: var(--gs-radius-10);
  background: var(--gs-surface);
  color: var(--gs-fg);
}
.setup-card--loading { display: flex; align-items: center; gap: 8px; }
.setup-card--quick { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 24px; }
.setup-card--quick h2 { margin: 0; font-size: 15px; font-weight: 600; }
.setup-card--quick .setup-card__actions { margin: 0; }
.setup-card__head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 8px; }
.setup-card__head h2 { margin: 0; font-size: 20px; font-weight: 650; line-height: 1.4; scroll-margin-block-start: 16px; }
.setup-card__head p { margin: 4px 0 0; color: var(--gs-fg-muted); font-size: 14px; }
.setup-card__status { margin: 12px 0 0; color: var(--gs-fg-muted); }
.setup-card__steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 16px 0 0; padding: 0; list-style: none; }
.setup-card__steps li { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 6px 10px; border: 1px solid var(--gs-border); border-radius: 8px; font-size: 13px; line-height: 1.35; }
.setup-card__number { display: grid; flex: 0 0 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--gs-surface-2); color: var(--gs-fg-muted); font-size: 12px; font-weight: 650; }
.is-done .setup-card__number { background: var(--gs-success-bg); color: var(--gs-success-fg); }
.setup-card__steps .is-current { border-color: var(--gs-accent-soft-border); background: var(--gs-accent-soft); color: var(--gs-accent-fg); }
.is-current .setup-card__number { background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); }
.setup-card__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 16px; }
.setup-card__link, .setup-card__primary { display: inline-flex; align-items: center; min-height: 36px; border-radius: 8px; }
.setup-card__link { color: var(--gs-accent-fg); }
.setup-card__primary { padding: 6px 14px; background: var(--gs-accent-cta); color: var(--gs-accent-cta-fg); }
.setup-card__primary:hover { background: var(--gs-accent-cta-hover); color: var(--gs-accent-cta-fg); }
.setup-card__reopen { justify-self: end; }
.setup-card :is(a, h2):focus-visible { outline: 2px solid var(--gs-accent-fg); outline-offset: 2px; }
@container (max-width: 620px) {
  .setup-card__steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
