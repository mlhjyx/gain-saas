<script lang="ts" setup>
import type { SessionInfo } from '#/api/gainos';

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { formatDateTime, glossaryStatus } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';
import { useUserStore } from '@vben/stores';

import { $t } from '#/locales';

import {
  failureText,
  gainosApi,
  type AppNotification,
  type CompanyCompleteness,
  type CompanyProfile,
  type DiscoveryRun,
  type DiscoveryRunLink,
  type Icp,
  type Lead,
  type LeadQueueCounts,
  type MembersResponse,
  type NotificationPage,
  type QueryPlan,
} from '#/api/gainos';

defineOptions({ name: 'WorkspaceHome' });

interface CockpitStage {
  key: string;
  label: string;
  percent: number;
  to: string;
  value: number;
}

interface CockpitAction {
  actionLabel: string;
  detail?: string;
  key: string;
  title: string;
  to: string;
  urgency: number;
}

type CockpitTone = 'danger' | 'processing' | 'success' | 'warning';

interface CockpitAlert {
  category: 'abnormal' | 'opportunity' | 'suggestion';
  detail?: string;
  key: string;
  notification?: AppNotification;
  time?: string;
  title: string;
  to?: string;
  tone: CockpitTone;
}

type ActionView = 'archived' | 'todo';

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();

/** 五步主链路(周报已于 2026-11-11 取消):界面永远回答"我在哪、下一步做什么" */
const STEP_KEYS = [
  'gainos.workspace.stepProfile',
  'gainos.workspace.stepIcp',
  'gainos.workspace.stepPlan',
  'gainos.workspace.stepRun',
  'gainos.workspace.stepJudge',
] as const;
const STEPS = computed(() =>
  STEP_KEYS.map((key) => ({ key, label: $t(key) })),
);

const loading = ref(true);
const loadError = ref<{ title: string; next?: string } | null>(null);
const engineNotice = ref<string | null>(null);
const workspaceName = ref('');
const role = ref<'admin' | 'member' | ''>('');

const companies = ref<CompanyProfile[]>([]);
const icps = ref<Icp[]>([]);
const currentIcpId = ref<string | null>(null);
const plans = ref<QueryPlan[]>([]);
const runLinks = ref<DiscoveryRunLink[]>([]);
const latestRun = ref<DiscoveryRun | null>(null);
const completenessByCompany = ref<Record<string, CompanyCompleteness>>({});
const allLeads = ref<Lead[]>([]);
const queueCounts = ref<LeadQueueCounts | null>(null);

const notifications = ref<AppNotification[]>([]);
const unreadCount = ref(0);
const notificationsLoading = ref(true);
const notificationsError = ref<string | null>(null);
const memberCount = ref(0);

const highlightNotifications = ref(false);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

const ARCHIVED_ACTIONS_KEY = 'gainos.cockpit.archived.v1';
const actionView = ref<ActionView>('todo');
const archivedActionKeys = ref<string[]>(readArchivedActions());
const lastLoadedAt = ref<Date | null>(null);

function readArchivedActions(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const raw = window.localStorage.getItem(ARCHIVED_ACTIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function persistArchivedActions(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      ARCHIVED_ACTIONS_KEY,
      JSON.stringify(archivedActionKeys.value),
    );
  } catch {
    // 本地归档失败不影响页面其他功能。
  }
}

function isActionArchived(key: string): boolean {
  return archivedActionKeys.value.includes(key);
}

function toggleActionArchive(key: string): void {
  archivedActionKeys.value = isActionArchived(key)
    ? archivedActionKeys.value.filter((value) => value !== key)
    : [...archivedActionKeys.value, key];
  persistArchivedActions();
}

const hour = new Date().getHours();
const greeting = computed(() =>
  hour < 6
    ? $t('gainos.workspace.greetingNight')
    : hour < 12
      ? $t('gainos.workspace.greetingMorning')
      : hour < 18
        ? $t('gainos.workspace.greetingAfternoon')
        : $t('gainos.workspace.greetingEvening'),
);

const actNowLabel = computed(() =>
  preferences.app.locale === 'en-US' ? 'Handle now' : '立即处理',
);
const handleLabel = computed(() =>
  preferences.app.locale === 'en-US' ? 'Handle' : '去处理',
);
const readonlyLabel = computed(() =>
  preferences.app.locale === 'en-US' ? 'Complete on target page' : '在目标页完成',
);

const displayName = computed(() => {
  const name = userStore.userInfo?.realName?.trim() ?? '';
  return name && name !== workspaceName.value ? name : '';
});

const isAdmin = computed(() => role.value === 'admin');
const roleLabel = computed(() => {
  if (role.value === 'admin') return $t('gainos.workspace.roleAdmin');
  if (role.value === 'member') return $t('gainos.workspace.roleMember');
  return '';
});

const activeIcp = computed(() => {
  if (currentIcpId.value) {
    const selected = icps.value.find(
      (icp) => icp.id === currentIcpId.value,
    );
    if (selected) return selected;
  }
  return (
    icps.value.find((icp) => icp.status === 'ACTIVE') ??
    icps.value[0] ??
    null
  );
});
const activeIcpIsActive = computed(
  () => activeIcp.value?.status === 'ACTIVE',
);

const latestPlan = computed(() => {
  return [...plans.value].sort(
    (a, b) => timeValue(b.createdAt) - timeValue(a.createdAt),
  )[0] ?? null;
});
const latestRunLink = computed(() => {
  return [...runLinks.value].sort(
    (a, b) => timeValue(b.startedAt) - timeValue(a.startedAt),
  )[0] ?? null;
});

const activeCompanyCompleteness = computed(() => {
  const companyId = activeIcp.value?.companyId;
  return companyId ? (completenessByCompany.value[companyId] ?? null) : null;
});
const factTotals = computed(() => {
  const rows = Object.values(completenessByCompany.value);
  return rows.reduce(
    (total, row) => ({
      approved: total.approved + (row.approvedClaims ?? 0),
      pending: total.pending + (row.pendingClaims ?? 0),
      conflicts: total.conflicts + (row.conflictsOpen ?? 0),
    }),
    { approved: 0, pending: 0, conflicts: 0 },
  );
});

const profileApproved = computed(() => {
  if (activeIcp.value) {
    const current = activeCompanyCompleteness.value;
    return current ? current.approvedClaims > 0 : companies.value.length > 0;
  }
  if (Object.keys(completenessByCompany.value).length > 0) {
    return Object.values(completenessByCompany.value).some(
      (row) => row.approvedClaims > 0,
    );
  }
  return companies.value.length > 0;
});
const pendingFactCount = computed(() =>
  activeCompanyCompleteness.value
    ? activeCompanyCompleteness.value.pendingClaims
    : factTotals.value.pending,
);

const sanctionsHoldCount = computed(() => {
  if (!isAdmin.value) return 0;
  if (queueCounts.value) return queueCounts.value.sanctions_hold ?? 0;
  return allLeads.value.filter((lead) => lead.queue === 'sanctions_hold').length;
});
const pendingLeadCount = computed(() => {
  if (queueCounts.value) {
    return (queueCounts.value.needs_review ?? 0) + sanctionsHoldCount.value;
  }
  return allLeads.value.filter(
    (lead) =>
      lead.queue === 'needs_review' ||
      (isAdmin.value && lead.queue === 'sanctions_hold'),
  ).length;
});
const recommendedLeadCount = computed(() => {
  if (queueCounts.value) return queueCounts.value.recommended ?? 0;
  return allLeads.value.filter((lead) => lead.queue === 'recommended').length;
});
const openRecommendedCount = computed(() => {
  const rows = allLeads.value.filter(
    (lead) => lead.queue === 'recommended' && lead.status !== 'QUALIFIED',
  ).length;
  if (allLeads.value.length === 0 && queueCounts.value) {
    return queueCounts.value.recommended ?? 0;
  }
  return rows;
});
const acceptedLeadCount = computed(
  () => allLeads.value.filter((lead) => lead.status === 'QUALIFIED').length,
);

const currentStep = computed(() => {
  if (loading.value || companies.value.length === 0) return 1;
  if (!profileApproved.value) return 1;
  if (icps.value.length === 0 || !activeIcpIsActive.value) return 2;
  const plan = latestPlan.value;
  if (!plan || plan.status === 'DRAFT') return 3;
  if (!latestRunLink.value) return plan.status === 'READY' ? 4 : 5;
  if (!latestRun.value || latestRun.value.status === 'RUNNING') return 4;
  return 5;
});

const syncState = computed<'error' | 'loading' | 'synced'>(() =>
  loading.value ? 'loading' : loadError.value ? 'error' : 'synced',
);
const syncLabel = computed(() => {
  if (syncState.value === 'loading') return $t('gainos.workspace.cockpitDataSyncing');
  if (syncState.value === 'error') return $t('gainos.workspace.cockpitDataFailed');
  return $t('gainos.workspace.cockpitDataSynced');
});
const syncTone = computed(() => {
  if (syncState.value === 'error') return 'gs-badge--danger';
  if (syncState.value === 'loading') return 'gs-badge--processing';
  return 'gs-badge--success';
});
const syncTime = computed(() =>
  lastLoadedAt.value ? formatTime(lastLoadedAt.value.toISOString()) : '',
);
const currentStepLabel = computed(
  () => STEPS.value[currentStep.value - 1]?.label ?? '',
);

/**
 * 阶段漏斗：只对现有数据做聚合，不新增接口。
 * percent 是“这一步完成到什么程度”，不是转化率承诺。
 */
const stageRows = computed<CockpitStage[]>(() => {
  const plan = latestPlan.value;
  const run = latestRun.value;
  const profilePercent =
    companies.value.length === 0
      ? 0
      : profileApproved.value
        ? 100
        : pendingFactCount.value > 0
          ? 55
          : 70;
  const icpPercent =
    icps.value.length === 0 ? 0 : activeIcpIsActive.value ? 100 : 55;
  const planPercent = !plan ? 0 : plan.status === 'DRAFT' ? 55 : 100;
  const runPercent = !latestRunLink.value
    ? 0
    : !run
      ? 50
      : run.status === 'RUNNING'
        ? 65
        : run.status === 'DONE' || run.status === 'PARTIAL'
          ? 100
          : 35;
  const judgePercent =
    pendingLeadCount.value > 0
      ? 55
      : openRecommendedCount.value > 0
        ? 70
        : acceptedLeadCount.value > 0
          ? 100
          : run && (run.status === 'DONE' || run.status === 'PARTIAL')
            ? 100
            : 0;
  return [
    {
      key: 'profile',
      label: STEPS.value[0]!.label,
      percent: profilePercent,
      to: '/companies',
      value: companies.value.length,
    },
    {
      key: 'icp',
      label: STEPS.value[1]!.label,
      percent: icpPercent,
      to: '/find-buyers',
      value: icps.value.length,
    },
    {
      key: 'plan',
      label: STEPS.value[2]!.label,
      percent: planPercent,
      to: '/find-buyers',
      value: plans.value.length,
    },
    {
      key: 'run',
      label: STEPS.value[3]!.label,
      percent: runPercent,
      to: '/tasks',
      value: runLinks.value.length,
    },
    {
      key: 'judge',
      label: STEPS.value[4]!.label,
      percent: judgePercent,
      to: '/leads?queue=needs_review',
      value: pendingLeadCount.value + recommendedLeadCount.value,
    },
  ];
});

const nextAction = computed(() => {
  const kicker = $t('gainos.workspace.nextKicker');
  if (loading.value) {
    return {
      kicker,
      title: $t('gainos.workspace.nextLoadingTitle'),
      desc: $t('gainos.workspace.nextLoadingDesc'),
      action: $t('gainos.common.loading'),
      to: '/workspace',
    };
  }
  if (engineNotice.value) {
    return {
      kicker,
      title: $t('gainos.workspace.nextEngineTitle'),
      desc: $t('gainos.workspace.nextEngineDesc'),
      action: $t('gainos.workspace.nextEngineAction'),
      to: '/companies',
    };
  }
  if (companies.value.length === 0) {
    return {
      kicker,
      title: $t('gainos.workspace.nextFirstTitle'),
      desc: $t('gainos.workspace.nextFirstDesc'),
      action: $t('gainos.workspace.nextFirstAction'),
      to: '/companies',
    };
  }
  if (!profileApproved.value) {
    if (pendingFactCount.value > 0) {
      return {
        kicker,
        title: $t('gainos.workspace.nextFactsTitle'),
        desc: $t('gainos.workspace.nextFactsDesc', {
          count: pendingFactCount.value,
        }),
        action: $t('gainos.workspace.nextFactsAction'),
        to: '/companies',
      };
    }
    return {
      kicker,
      title: $t('gainos.workspace.nextFactsNoneTitle'),
      desc: $t('gainos.workspace.nextFactsNoneDesc'),
      action: $t('gainos.workspace.nextFactsNoneAction'),
      to: '/companies',
    };
  }
  if (icps.value.length === 0) {
    return {
      kicker,
      title: $t('gainos.workspace.nextIcpTitle'),
      desc: $t('gainos.workspace.nextIcpDesc'),
      action: $t('gainos.workspace.nextIcpAction'),
      to: '/find-buyers',
    };
  }
  if (!activeIcpIsActive.value) {
    return {
      kicker,
      title: $t('gainos.workspace.nextActivateTitle'),
      desc: $t('gainos.workspace.nextActivateDesc'),
      action: $t('gainos.workspace.nextActivateAction'),
      to: '/find-buyers',
    };
  }
  const plan = latestPlan.value;
  if (!plan) {
    return {
      kicker,
      title: $t('gainos.workspace.nextPlanTitle'),
      desc: $t('gainos.workspace.nextPlanDesc'),
      action: $t('gainos.workspace.nextPlanAction'),
      to: '/find-buyers',
    };
  }
  if (plan.status === 'DRAFT') {
    return {
      kicker,
      title: $t('gainos.workspace.nextConfirmTitle'),
      desc: $t('gainos.workspace.nextConfirmDesc'),
      action: $t('gainos.workspace.nextConfirmAction'),
      to: '/find-buyers',
    };
  }
  const runLink = latestRunLink.value;
  if (!runLink) {
    if (plan.status === 'EXECUTED') {
      if (pendingLeadCount.value > 0) {
        return {
          kicker,
          title: $t('gainos.workspace.nextJudgeTitle'),
          desc: $t('gainos.workspace.nextJudgeDesc', {
            count: pendingLeadCount.value,
          }),
          action: $t('gainos.workspace.nextJudgeAction'),
          to: '/leads?queue=needs_review',
        };
      }
      if (openRecommendedCount.value > 0) {
        return {
          kicker,
          title: $t('gainos.workspace.nextLeadTitle'),
          desc: $t('gainos.workspace.nextLeadDesc', {
            count: openRecommendedCount.value,
          }),
          action: $t('gainos.workspace.nextLeadAction'),
          to: '/leads?queue=recommended',
        };
      }
      if (acceptedLeadCount.value > 0) {
        return {
          kicker,
          title: $t('gainos.workspace.nextLeadTitle'),
          desc: $t('gainos.workspace.nextLeadDesc', {
            count: openRecommendedCount.value,
          }),
          action: $t('gainos.workspace.nextLeadAction'),
          to: '/leads?queue=recommended',
        };
      }
      return {
        kicker,
        title: $t('gainos.workspace.nextNoLeadsTitle'),
        desc: $t('gainos.workspace.nextNoLeadsDesc'),
        action: $t('gainos.workspace.nextNoLeadsAction'),
        to: '/find-buyers',
      };
    }
    return {
      kicker,
      title: $t('gainos.workspace.nextRunTitle'),
      desc: $t('gainos.workspace.nextRunDesc'),
      action: $t('gainos.workspace.nextRunAction'),
      to: '/find-buyers',
    };
  }
  const runTo = `/runs/${runLink.runId}`;
  if (!latestRun.value || latestRun.value.status === 'RUNNING') {
    return {
      kicker,
      title: $t('gainos.workspace.nextRunRunningTitle'),
      desc: $t('gainos.workspace.nextRunRunningDesc'),
      action: $t('gainos.workspace.nextRunRunningAction'),
      to: runTo,
    };
  }
  if (pendingLeadCount.value > 0) {
    return {
      kicker,
      title: $t('gainos.workspace.nextJudgeTitle'),
      desc: $t('gainos.workspace.nextJudgeDesc', {
        count: pendingLeadCount.value,
      }),
      action: $t('gainos.workspace.nextJudgeAction'),
      to: '/leads?queue=needs_review',
    };
  }
  if (openRecommendedCount.value > 0) {
    return {
      kicker,
      title: $t('gainos.workspace.nextLeadTitle'),
      desc: $t('gainos.workspace.nextLeadDesc', {
        count: openRecommendedCount.value,
      }),
      action: $t('gainos.workspace.nextLeadAction'),
      to: '/leads?queue=recommended',
    };
  }
  if (latestRun.value.status === 'FAILED') {
    return {
      kicker,
      title: $t('gainos.workspace.nextRunFailedTitle'),
      desc: $t('gainos.workspace.nextRunFailedDesc'),
      action: $t('gainos.workspace.nextRunFailedAction'),
      to: runTo,
    };
  }
  if (latestRun.value.status === 'PARTIAL') {
    return {
      kicker,
      title: $t('gainos.workspace.nextRunPartialTitle'),
      desc: $t('gainos.workspace.nextRunPartialDesc'),
      action: $t('gainos.workspace.nextRunPartialAction'),
      to: runTo,
    };
  }
  if (acceptedLeadCount.value > 0) {
    return {
      kicker,
      title: $t('gainos.workspace.nextLeadTitle'),
      desc: $t('gainos.workspace.nextLeadDesc', {
        count: openRecommendedCount.value,
      }),
      action: $t('gainos.workspace.nextLeadAction'),
      to: '/leads?queue=recommended',
    };
  }
  if (latestRun.value.status === 'DONE') {
    return {
      kicker,
      title: $t('gainos.workspace.nextNoLeadsTitle'),
      desc: $t('gainos.workspace.nextNoLeadsDesc'),
      action: $t('gainos.workspace.nextNoLeadsAction'),
      to: runTo,
    };
  }
  return {
    kicker,
    title: $t('gainos.workspace.nextLeadTitle'),
    desc: $t('gainos.workspace.nextLeadDesc', {
      count: openRecommendedCount.value,
    }),
    action: $t('gainos.workspace.nextLeadAction'),
    to: '/leads?queue=recommended',
  };
});

/**
 * 行动清单：从现有状态派生，按紧迫度排序。
 * 归档只影响本机展示（localStorage），不改任何业务状态或接口。
 */
const actionItems = computed<CockpitAction[]>(() => {
  if (loading.value) return [];
  const items: CockpitAction[] = [];
  const add = (item: CockpitAction) => items.push(item);

  if (engineNotice.value) {
    add({
      actionLabel: $t('gainos.workspace.nextEngineAction'),
      detail: $t('gainos.workspace.nextEngineDesc'),
      key: 'engine',
      title: $t('gainos.workspace.nextEngineTitle'),
      to: '/companies',
      urgency: 0,
    });
    return items;
  }

  if (companies.value.length === 0) {
    add({
      actionLabel: $t('gainos.workspace.nextFirstAction'),
      detail: $t('gainos.workspace.nextFirstDesc'),
      key: 'company',
      title: $t('gainos.workspace.nextFirstTitle'),
      to: '/companies',
      urgency: 0,
    });
    return items;
  }

  if (!profileApproved.value) {
    if (pendingFactCount.value > 0) {
      add({
        actionLabel: $t('gainos.workspace.nextFactsAction'),
        detail: $t('gainos.workspace.nextFactsDesc', {
          count: pendingFactCount.value,
        }),
        key: 'facts',
        title: $t('gainos.workspace.nextFactsTitle'),
        to: '/companies',
        urgency: 0,
      });
    } else {
      add({
        actionLabel: $t('gainos.workspace.nextFactsNoneAction'),
        detail: $t('gainos.workspace.nextFactsNoneDesc'),
        key: 'facts-none',
        title: $t('gainos.workspace.nextFactsNoneTitle'),
        to: '/companies',
        urgency: 1,
      });
    }
    return items;
  }

  if (icps.value.length === 0) {
    add({
      actionLabel: $t('gainos.workspace.nextIcpAction'),
      detail: $t('gainos.workspace.nextIcpDesc'),
      key: 'icp',
      title: $t('gainos.workspace.nextIcpTitle'),
      to: '/find-buyers',
      urgency: 1,
    });
    return items;
  }

  if (!activeIcpIsActive.value) {
    add({
      actionLabel: $t('gainos.workspace.nextActivateAction'),
      detail: $t('gainos.workspace.nextActivateDesc'),
      key: 'activate',
      title: $t('gainos.workspace.nextActivateTitle'),
      to: '/find-buyers',
      urgency: 1,
    });
    return items;
  }

  const plan = latestPlan.value;
  const runLink = latestRunLink.value;
  const run = latestRun.value;

  if (!plan) {
    add({
      actionLabel: $t('gainos.workspace.nextPlanAction'),
      detail: $t('gainos.workspace.nextPlanDesc'),
      key: 'plan',
      title: $t('gainos.workspace.nextPlanTitle'),
      to: '/find-buyers',
      urgency: 1,
    });
  } else if (plan.status === 'DRAFT') {
    add({
      actionLabel: $t('gainos.workspace.nextConfirmAction'),
      detail: $t('gainos.workspace.nextConfirmDesc'),
      key: 'confirm',
      title: $t('gainos.workspace.nextConfirmTitle'),
      to: '/find-buyers',
      urgency: 1,
    });
  } else if (plan.status === 'READY' && !runLink) {
    add({
      actionLabel: $t('gainos.workspace.nextRunAction'),
      detail: $t('gainos.workspace.nextRunDesc'),
      key: 'run',
      title: $t('gainos.workspace.nextRunTitle'),
      to: '/find-buyers',
      urgency: 1,
    });
  }

  if (runLink) {
    const runTo = `/runs/${runLink.runId}`;
    if (!run || run.status === 'RUNNING') {
      add({
        actionLabel: $t('gainos.workspace.nextRunRunningAction'),
        detail: $t('gainos.workspace.nextRunRunningDesc'),
        key: 'run-running',
        title: $t('gainos.workspace.nextRunRunningTitle'),
        to: runTo,
        urgency: 2,
      });
    } else if (run.status === 'FAILED') {
      add({
        actionLabel: $t('gainos.workspace.nextRunFailedAction'),
        detail: $t('gainos.workspace.nextRunFailedDesc'),
        key: 'run-failed',
        title: $t('gainos.workspace.nextRunFailedTitle'),
        to: runTo,
        urgency: 0,
      });
    } else if (run.status === 'PARTIAL') {
      add({
        actionLabel: $t('gainos.workspace.nextRunPartialAction'),
        detail: $t('gainos.workspace.nextRunPartialDesc'),
        key: 'run-partial',
        title: $t('gainos.workspace.nextRunPartialTitle'),
        to: runTo,
        urgency: 0,
      });
    }
  }

  if (pendingLeadCount.value > 0) {
    add({
      actionLabel: $t('gainos.workspace.nextJudgeAction'),
      detail: $t('gainos.workspace.nextJudgeDesc', {
        count: pendingLeadCount.value,
      }),
      key: 'judge',
      title: $t('gainos.workspace.nextJudgeTitle'),
      to: '/leads?queue=needs_review',
      urgency: pendingLeadCount.value > 10 ? 0 : 1,
    });
  }

  if (openRecommendedCount.value > 0) {
    add({
      actionLabel: $t('gainos.workspace.nextLeadAction'),
      detail: $t('gainos.workspace.nextLeadDesc', {
        count: openRecommendedCount.value,
      }),
      key: 'follow',
      title: $t('gainos.workspace.nextLeadTitle'),
      to: '/leads?queue=recommended',
      urgency: 1,
    });
  }

  if (sanctionsHoldCount.value > 0) {
    add({
      actionLabel: $t('gainos.workspace.nextJudgeAction'),
      detail: $t('gainos.workspace.kpiPendingSanctions', {
        count: sanctionsHoldCount.value,
      }),
      key: 'sanctions',
      title: $t('gainos.leads.sanctionsHoldCount', {
        count: sanctionsHoldCount.value,
      }),
      to: '/leads?queue=sanctions_hold',
      urgency: 0,
    });
  }

  if (items.length === 0) {
    add({
      actionLabel: nextAction.value.action,
      detail: nextAction.value.desc,
      key: 'fallback',
      title: nextAction.value.title,
      to: nextAction.value.to,
      urgency: 2,
    });
  }

  return items.sort((a, b) => a.urgency - b.urgency);
});

const visibleActions = computed(() =>
  actionItems.value.filter((item) =>
    actionView.value === 'todo'
      ? !isActionArchived(item.key)
      : isActionArchived(item.key),
  ),
);

const kpis = computed(() => {
  const loaded = !loading.value;
  const buyer = activeIcp.value;
  const run = latestRun.value;
  const plan = latestPlan.value;
  const runValue = run
    ? runStatusLabel(run.status)
    : plan
      ? planStatusLabel(plan.status)
      : $t('gainos.workspace.kpiNoRun');
  const runHint = run
    ? formatTime(run.createdAt) || $t('gainos.workspace.kpiRunHint')
    : plan
      ? plan.status === 'DRAFT'
        ? $t('gainos.workspace.kpiRunDraftHint')
        : plan.status === 'EXECUTED'
          ? $t('gainos.workspace.kpiRunExecutedHint')
          : $t('gainos.workspace.kpiRunReadyHint')
      : $t('gainos.workspace.kpiRunEmptyHint');
  const runTone =
    run?.status === 'FAILED'
      ? 'is-bad'
      : run?.status === 'PARTIAL'
        ? 'is-warn'
        : run?.status === 'RUNNING'
          ? 'is-info'
          : run?.status === 'DONE'
            ? 'is-ok'
            : '';
  const factsHint =
    factTotals.value.pending > 0
      ? $t('gainos.workspace.kpiFactsWithPending', {
          approved: factTotals.value.approved,
          pending: factTotals.value.pending,
        })
      : factTotals.value.approved > 0
        ? $t('gainos.workspace.kpiFacts', {
            count: factTotals.value.approved,
          })
        : Object.keys(completenessByCompany.value).length > 0
          ? $t('gainos.workspace.kpiNoFacts')
          : $t('gainos.workspace.kpiCompaniesHint');
  return [
    {
      key: 'companies',
      icon: '🏢',
      label: $t('gainos.workspace.kpiCompanies'),
      value: loaded ? companies.value.length : '—',
      hint: factsHint,
      to: '/companies',
      valueClass: '',
      text: false,
    },
    {
      key: 'buyers',
      icon: '🎯',
      label: $t('gainos.workspace.kpiBuyers'),
      value: loaded ? (buyer ? icpStatusLabel(buyer.status) : $t('gainos.workspace.kpiNoBuyer')) : '—',
      hint: buyer?.name ?? $t('gainos.workspace.kpiBuyerHint'),
      to: '/find-buyers',
      valueClass: buyer ? 'is-ok' : '',
      text: true,
    },
    {
      key: 'run',
      icon: '🚀',
      label: $t('gainos.workspace.kpiRun'),
      value: loaded ? runValue : '—',
      hint: runHint,
      to: '/tasks',
      valueClass: runTone,
      text: true,
    },
    {
      key: 'pending',
      icon: '⏳',
      label: $t('gainos.workspace.kpiPending'),
      value: loaded ? pendingLeadCount.value : '—',
      hint:
        sanctionsHoldCount.value > 0
          ? $t('gainos.workspace.kpiPendingSanctions', {
              count: sanctionsHoldCount.value,
            })
          : $t('gainos.workspace.kpiPendingHint'),
      to: '/leads?queue=needs_review',
      valueClass: pendingLeadCount.value > 0 ? 'is-warn' : 'is-ok',
      text: false,
    },
    {
      key: 'following',
      icon: '⭐',
      label: $t('gainos.workspace.kpiFollowing'),
      value: loaded ? recommendedLeadCount.value : '—',
      hint:
        acceptedLeadCount.value > 0
          ? $t('gainos.workspace.kpiFollowingAccepted', {
              count: acceptedLeadCount.value,
            })
          : $t('gainos.workspace.kpiFollowingHint'),
      to: '/leads?queue=recommended',
      valueClass: recommendedLeadCount.value > 0 ? 'is-ok' : '',
      text: false,
    },
    {
      key: 'team',
      icon: '👥',
      label: $t('gainos.workspace.kpiTeam'),
      value: loaded ? memberCount.value : '—',
      hint: $t('gainos.workspace.kpiTeamHint'),
      to: '/settings/members',
      valueClass: '',
      text: false,
    },
  ];
});

const recentLeadRows = computed(() => {
  const rows = allLeads.value.filter((lead) => {
    if (lead.queue === 'recommended' || lead.queue === 'needs_review') {
      return true;
    }
    return isAdmin.value && lead.queue === 'sanctions_hold';
  });
  return [...rows]
    .sort(
      (a, b) =>
        timeValue(b.updatedAt ?? b.createdAt) -
        timeValue(a.updatedAt ?? a.createdAt),
    )
    .slice(0, 4);
});

function timeValue(value?: string | null): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatTime(value?: string | null): string {
  return formatDateTime(value);
}

function icpStatusLabel(status?: string): string {
  return glossaryStatus('icp', status, preferences.app.locale)?.label ?? '—';
}
function planStatusLabel(status?: string): string {
  const key = `gainos.findBuyers.planStatus.${status ?? 'DRAFT'}`;
  const translated = $t(key);
  return translated === key ? '—' : translated;
}
// 状态/队列文案取自 @gain-saas/shared 的 glossary（P6 §4），未登记值不裸奔。
function runStatusLabel(status?: string): string {
  return glossaryStatus('run', status, preferences.app.locale)?.label ?? '—';
}
function queueLabel(queue?: string): string {
  return glossaryStatus('leadQueue', queue, preferences.app.locale)?.label ?? '—';
}
function leadCompanyName(lead: Lead): string {
  return (
    lead.company?.name ||
    lead.company?.domain ||
    $t('gainos.leads.unknownCompany')
  );
}
function leadInitial(lead: Lead): string {
  return leadCompanyName(lead).slice(0, 1).toUpperCase();
}
function leadScoreText(lead: Lead): string {
  if (typeof lead.totalScore !== 'number') return '';
  const score = Math.round(lead.totalScore);
  if (!Number.isFinite(score) || score <= 0) return '';
  return $t('gainos.leads.score', { score });
}
function openLead(lead: Lead): void {
  const queues = ['needs_review', 'recommended', 'rejected', 'suppressed', 'sanctions_hold'];
  const queue =
    lead.queue && queues.includes(lead.queue) ? lead.queue : 'needs_review';
  void router.push({ path: '/leads', query: { queue } });
}

function notificationTitle(item: AppNotification): string {
  switch (item.type) {
    case 'DiscoveryRunCompleted': return $t('gainos.notifications.runCompleted');
    case 'DiscoveryRunPartial': return $t('gainos.notifications.runPartial');
    case 'DiscoveryRunFailed': return $t('gainos.notifications.runFailed');
    case 'LeadQualified': return $t('gainos.notifications.leadQualified');
    case 'ClaimApproved': return $t('gainos.notifications.claimApproved');
    case 'ClaimRejected': return $t('gainos.notifications.claimRejected');
    default: return item.title ?? $t('gainos.notifications.default');
  }
}
function notificationMessage(item: AppNotification): string {
  switch (item.type) {
    case 'DiscoveryRunCompleted': return $t('gainos.notifications.runCompletedMessage');
    case 'DiscoveryRunPartial': return $t('gainos.notifications.runPartialMessage');
    case 'DiscoveryRunFailed': return $t('gainos.notifications.runFailedMessage');
    case 'LeadQualified': return $t('gainos.notifications.leadQualifiedMessage');
    case 'ClaimApproved': return $t('gainos.notifications.claimApprovedMessage');
    case 'ClaimRejected': return $t('gainos.notifications.claimRejectedMessage');
    default: return '';
  }
}

function alertCategoryForType(type: string): CockpitAlert['category'] {
  if (
    type === 'DiscoveryRunFailed' ||
    type === 'DiscoveryRunPartial' ||
    type === 'DiscoveryRunCancelled' ||
    type === 'SanctionsHoldDetected' ||
    type === 'WorkspaceQuotaExceeded' ||
    type === 'WorkspaceQuotaWarning'
  ) {
    return 'abnormal';
  }
  if (type === 'LeadQualified') return 'opportunity';
  return 'suggestion';
}

function alertToneForType(type: string): CockpitTone {
  if (
    type === 'DiscoveryRunFailed' ||
    type === 'SanctionsHoldDetected' ||
    type === 'WorkspaceQuotaExceeded'
  ) {
    return 'danger';
  }
  if (
    type === 'DiscoveryRunPartial' ||
    type === 'DiscoveryRunCancelled' ||
    type === 'WorkspaceQuotaWarning'
  ) {
    return 'warning';
  }
  if (type === 'LeadQualified') return 'success';
  return 'processing';
}

function alertCategoryLabel(alert: CockpitAlert): string {
  if (alert.category === 'abnormal') return $t('gainos.workspace.cockpitAlertAbnormal');
  if (alert.category === 'opportunity') return $t('gainos.workspace.cockpitAlertOpportunity');
  return $t('gainos.workspace.cockpitAlertSuggestion');
}

function alertBadgeClass(alert: CockpitAlert): string {
  return `gs-badge--${alert.tone}`;
}

/**
 * 提醒：异常/机会/建议 + 现有通知。
 * 通知点击仍走 openNotification（先标已读，再按 link 跳转）。
 */
const alertRows = computed<CockpitAlert[]>(() => {
  const rows: CockpitAlert[] = [];
  if (engineNotice.value) {
    rows.push({
      category: 'abnormal',
      key: 'engine',
      title: $t('gainos.workspace.nextEngineTitle'),
      to: '/companies',
      tone: 'danger',
    });
  }
  if (sanctionsHoldCount.value > 0) {
    rows.push({
      category: 'abnormal',
      key: 'sanctions',
      title: $t('gainos.leads.sanctionsHoldCount', {
        count: sanctionsHoldCount.value,
      }),
      to: '/leads?queue=sanctions_hold',
      tone: 'danger',
    });
  }
  const runLink = latestRunLink.value;
  if (runLink && latestRun.value?.status === 'FAILED') {
    rows.push({
      category: 'abnormal',
      key: 'run-failed',
      title: $t('gainos.workspace.nextRunFailedTitle'),
      to: `/runs/${runLink.runId}`,
      tone: 'danger',
    });
  }
  if (runLink && latestRun.value?.status === 'PARTIAL') {
    rows.push({
      category: 'abnormal',
      key: 'run-partial',
      title: $t('gainos.workspace.nextRunPartialTitle'),
      to: `/runs/${runLink.runId}`,
      tone: 'warning',
    });
  }
  if (openRecommendedCount.value > 0) {
    rows.push({
      category: 'opportunity',
      detail: $t('gainos.workspace.nextLeadDesc', {
        count: openRecommendedCount.value,
      }),
      key: 'recommended',
      title: $t('gainos.workspace.nextLeadTitle'),
      to: '/leads?queue=recommended',
      tone: 'success',
    });
  }
  for (const item of notifications.value.slice(0, 4)) {
    rows.push({
      category: alertCategoryForType(item.type),
      detail: notificationMessage(item) || undefined,
      key: `notification-${item.id}`,
      notification: item,
      time: formatTime(item.createdAt),
      title: notificationTitle(item),
      tone: alertToneForType(item.type),
    });
  }
  return rows.slice(0, 6);
});

function handleAlert(alert: CockpitAlert): void {
  if (alert.notification) {
    void openNotification(alert.notification);
    return;
  }
  if (alert.to) void router.push(alert.to);
}

function unwrap<T>(value: unknown): T | null {
  if (value && typeof value === 'object' && 'data' in value) {
    return ((value as { data?: T }).data ?? null);
  }
  return (value as T) ?? null;
}
function asArray<T>(value: T[] | { data?: T[] } | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  const inner = (value as { data?: T[] } | undefined)?.data;
  return Array.isArray(inner) ? inner : [];
}

function applyNotifications(value: unknown): void {
  const payload = unwrap<NotificationPage>(value);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  notifications.value = [...items].sort(
    (a, b) => timeValue(b.createdAt) - timeValue(a.createdAt),
  );
  unreadCount.value = Number(
    payload?.unreadCount ??
      notifications.value.filter((item) => !item.readAt).length,
  );
}

async function load(): Promise<void> {
  loading.value = true;
  notificationsLoading.value = true;
  engineNotice.value = null;
  notificationsError.value = null;
  loadError.value = null;

  try {
    const [sessionRes, companyRes, icpRes, notificationsRes, membersRes] =
      await Promise.allSettled([
        gainosApi.session(),
        gainosApi.companies(),
        gainosApi.icps(),
        gainosApi.notifications(),
        gainosApi.members(),
      ]);

    if (sessionRes.status === 'fulfilled') {
      const session = unwrap<SessionInfo>(sessionRes.value);
      if (session) {
        workspaceName.value =
          session.workspaces.find(
            (workspace) => workspace.id === session.workspace?.id,
          )?.name ?? '';
        role.value = session.workspace?.role ?? '';
      }
    }

    if (companyRes.status === 'fulfilled') {
      companies.value = asArray(companyRes.value);
    } else {
      companies.value = [];
      engineNotice.value = failureText(companyRes.reason).title;
    }

    if (icpRes.status === 'fulfilled') {
      icps.value = asArray(icpRes.value);
    } else {
      icps.value = [];
    }

    if (notificationsRes.status === 'fulfilled') {
      applyNotifications(notificationsRes.value);
    } else {
      notificationsError.value = failureText(notificationsRes.reason).title;
    }
    notificationsLoading.value = false;

    if (membersRes.status === 'fulfilled') {
      const payload = unwrap<MembersResponse>(membersRes.value);
      memberCount.value = Array.isArray(payload?.members)
        ? payload.members.length
        : 0;
    }

    // 同一工作空间可能有多份生效中的目标客户画像；优先展示最近真实发起过寻源的那份，
    // 其次才是最近创建的，避免看板停留在尚未使用的示例档案上。
    const activeCandidates = icps.value.filter(
      (icp) => icp.status === 'ACTIVE',
    );
    const linksByIcp = new Map<string, DiscoveryRunLink[]>();
    let chosen: Icp | null = null;
    if (activeCandidates.length > 0) {
      const linkResults = await Promise.allSettled(
        activeCandidates.map((icp) => gainosApi.discoveryRunLinks(icp.id)),
      );
      let newestRun = -1;
      linkResults.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const candidate = activeCandidates[index]!;
        const links = asArray(result.value);
        linksByIcp.set(candidate.id, links);
        const latestRunAt = links.reduce(
          (latest, link) => Math.max(latest, timeValue(link.startedAt)),
          -1,
        );
        if (links.length > 0 && latestRunAt > newestRun) {
          newestRun = latestRunAt;
          chosen = candidate;
        }
      });
      if (!chosen) {
        chosen = [...activeCandidates].sort(
          (a, b) => timeValue(b.createdAt) - timeValue(a.createdAt),
        )[0]!;
      }
    }
    currentIcpId.value = chosen?.id ?? null;
    const active = chosen?.status === 'ACTIVE' ? chosen : null;
    if (active) {
      plans.value = [];
      queueCounts.value = null;
      allLeads.value = [];
      latestRun.value = null;
      runLinks.value = linksByIcp.get(active.id) ?? [];
      const detailResults = await Promise.allSettled([
        gainosApi.queryPlans(active.id),
        gainosApi.leadQueues(active.id),
        gainosApi.leads({ icpId: active.id, limit: 200 }),
      ]);
      const [plansRes, queuesRes, leadsRes] = detailResults;
      if (plansRes.status === 'fulfilled') plans.value = asArray(plansRes.value);
      if (queuesRes.status === 'fulfilled') {
        queueCounts.value = unwrap<LeadQueueCounts>(queuesRes.value);
      }
      if (leadsRes.status === 'fulfilled') {
        allLeads.value = asArray(leadsRes.value);
      }
      const link = latestRunLink.value;
      if (link?.runId) {
        try {
          latestRun.value = await gainosApi.discoveryRun(link.runId);
        } catch {
          latestRun.value = null;
        }
      }
    } else {
      plans.value = [];
      runLinks.value = [];
      latestRun.value = null;
      queueCounts.value = null;
      allLeads.value = [];
    }

    const companyIds = companies.value
      .map((company) => company.id)
      .filter((id): id is string => Boolean(id));
    if (companyIds.length > 0) {
      const results = await Promise.allSettled(
        companyIds.map((companyId) =>
          gainosApi.companyCompleteness(companyId),
        ),
      );
      const next: Record<string, CompanyCompleteness> = {};
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const payload = unwrap<CompanyCompleteness>(result.value);
          if (payload) next[companyIds[index]!] = payload;
        }
      });
      completenessByCompany.value = next;
    } else {
      completenessByCompany.value = {};
    }

    // 关键接口失败时给出可见错误与重试（审计 二-03：此前失败被静默显示成「未授权/全 0」）。
    const critical = [sessionRes, companyRes, icpRes].filter((r) => r.status === 'rejected');
    if (critical.length > 0) {
      loadError.value = failureText((critical[0] as PromiseRejectedResult).reason);
    }
  } finally {
    loading.value = false;
    notificationsLoading.value = false;
    if (!loadError.value) lastLoadedAt.value = new Date();
  }
}

async function markRead(item: AppNotification): Promise<void> {
  if (item.readAt) return;
  try {
    await gainosApi.readNotification(item.id);
    const row = notifications.value.find((entry) => entry.id === item.id);
    if (row) row.readAt = new Date().toISOString();
    unreadCount.value = Math.max(0, unreadCount.value - 1);
    window.dispatchEvent(new Event('gainos:notifications-changed'));
  } catch {
    // 读取失败不阻断跳转,下一次刷新会重新同步。
  }
}

async function openNotification(item: AppNotification): Promise<void> {
  await markRead(item);
  if (!item.link) return;
  if (/^https?:\/\//.test(item.link)) {
    window.open(item.link, '_blank');
    return;
  }
  await router.push(item.link);
}

async function markAllRead(): Promise<void> {
  if (unreadCount.value === 0) return;
  try {
    await gainosApi.readAllNotifications();
    const now = new Date().toISOString();
    notifications.value = notifications.value.map((item) => ({
      ...item,
      readAt: item.readAt ?? now,
    }));
    unreadCount.value = 0;
    window.dispatchEvent(new Event('gainos:notifications-changed'));
  } catch {
    // 失败时保留列表与未读状态，下一次刷新继续同步。
  }
}

async function focusNotifications(): Promise<void> {
  if (route.query.panel !== 'notifications') return;
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const element = document.getElementById('workspace-notifications');
  if (!element) return;
  element.scrollIntoView({ behavior: 'auto', block: 'start' });
  highlightNotifications.value = true;
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    highlightNotifications.value = false;
  }, 2600);
}

onMounted(async () => {
  await load();
  await focusNotifications();
});
watch(
  () => route.fullPath,
  () => {
    void focusNotifications();
  },
);
onUnmounted(() => {
  if (highlightTimer) clearTimeout(highlightTimer);
});
</script>

<template>
  <div class="wk">
    <div v-if="loadError" class="wk__error" role="alert">
      <div>
        <strong>{{ loadError.title }}</strong>
        <p v-if="loadError.next">{{ loadError.next }}</p>
      </div>
      <button type="button" class="wk__text-btn" @click="load">
        {{ $t('gainos.common.retry') }}
      </button>
    </div>

    <header class="wk__head">
      <div class="wk__identity">
        <h1 class="wk__title">
          {{ workspaceName || $t('gainos.workspace.title', { greeting }) }}
        </h1>
        <div class="wk__meta">
          <span v-if="roleLabel" class="gs-badge gs-badge--neutral">{{ roleLabel }}</span>
          <span v-if="displayName" class="wk__person">{{ displayName }}</span>
          <span class="gs-badge" :class="syncTone" :title="syncTime || undefined">
            {{ syncLabel }}<template v-if="syncTime"> · {{ syncTime }}</template>
          </span>
        </div>
      </div>
      <button
        class="wk__refresh"
        type="button"
        :class="{ 'is-loading': loading }"
        @click="load"
      >
        {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
      </button>
    </header>

    <div class="wk__grid">
      <div class="wk__main">
        <!-- 今日摘要：脉搏 + KPI。说明性文案放进 title，不占版面。 -->
        <section class="gs-card wk__summary" :aria-label="$t('gainos.workspace.cockpitToday')">
          <header class="wk__section-head">
            <div>
              <h2>{{ $t('gainos.workspace.cockpitToday') }}</h2>
              <p class="wk__section-sub">
                {{ $t('gainos.workspace.stepProgress', { current: currentStep, total: STEPS.length }) }}
                · {{ currentStepLabel }} · {{ $t('gainos.workspace.cockpitTodo') }} {{ visibleActions.length }}
              </p>
            </div>
          </header>
          <div class="wk__kpi-grid">
            <button
              v-for="kpi in kpis"
              :key="kpi.key"
              type="button"
              class="wk__kpi"
              :class="`wk__kpi--${kpi.key}`"
              :title="kpi.hint"
              @click="router.push(kpi.to)"
            >
              <span class="wk__kpi-label">
                {{ kpi.label }}
                <span class="wk__kpi-info" aria-hidden="true">i</span>
              </span>
              <strong
                class="wk__kpi-value"
                :class="[kpi.text ? 'is-text' : '', kpi.valueClass]"
              >
                {{ kpi.value }}
              </strong>
            </button>
          </div>
        </section>

        <!-- 阶段漏斗：五步主链路 + 进度条，数据只来自现有接口。 -->
        <section class="gs-card wk__stages" :aria-label="$t('gainos.workspace.cockpitStages')">
          <header class="wk__section-head">
            <h2>{{ $t('gainos.workspace.cockpitStages') }}</h2>
          </header>
          <div class="wk__stage-grid">
            <button
              v-for="(stage, index) in stageRows"
              :key="stage.key"
              type="button"
              class="wk__stage"
              :class="{
                'is-current': currentStep === index + 1,
                'is-done': stage.percent >= 100,
              }"
              :aria-label="`${stage.label}：${stage.value}，${stage.percent}%`"
              @click="router.push(stage.to)"
            >
              <span class="wk__stage-top">
                <span class="wk__stage-index">{{ index + 1 }}</span>
                <strong>{{ stage.label }}</strong>
              </span>
              <span class="wk__stage-value">{{ stage.value }}</span>
              <span class="wk__stage-bar" aria-hidden="true">
                <i :style="{ width: `${stage.percent}%` }"></i>
              </span>
              <span class="wk__stage-pct">{{ stage.percent }}%</span>
            </button>
          </div>
        </section>

        <!-- 行动清单：按紧迫度排序；归档只影响本机展示。 -->
        <section class="gs-card wk__actions" :aria-label="$t('gainos.workspace.cockpitActions')">
          <header class="wk__section-head">
            <h2>{{ $t('gainos.workspace.cockpitActions') }}</h2>
            <div class="wk__seg" role="group" :aria-label="$t('gainos.workspace.cockpitActions')">
              <button
                type="button"
                :aria-pressed="actionView === 'todo'"
                :class="{ 'is-active': actionView === 'todo' }"
                @click="actionView = 'todo'"
              >
                {{ $t('gainos.workspace.cockpitTodo') }}
              </button>
              <button
                type="button"
                :aria-pressed="actionView === 'archived'"
                :class="{ 'is-active': actionView === 'archived' }"
                @click="actionView = 'archived'"
              >
                {{ $t('gainos.workspace.cockpitArchived') }}
              </button>
            </div>
          </header>

          <ol v-if="visibleActions.length" class="wk__action-list">
            <li v-for="(item, index) in visibleActions" :key="item.key" class="wk__action">
              <span class="wk__action-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <div class="wk__action-body">
                <div class="wk__action-head">
                  <strong>{{ item.title }}</strong>
                  <span class="wk__action-dot" :class="`is-${item.urgency}`" aria-hidden="true"></span>
                </div>
                <div class="wk__action-foot">
                  <button type="button" class="wk__action-go" @click="router.push(item.to)">
                    {{ item.actionLabel }} <span aria-hidden="true">→</span>
                  </button>
                  <button
                    type="button"
                    class="wk__text-btn"
                    :aria-label="`${actionView === 'todo' ? $t('gainos.workspace.cockpitArchive') : $t('gainos.workspace.cockpitRestore')}：${item.title}`"
                    @click="toggleActionArchive(item.key)"
                  >
                    {{ actionView === 'todo' ? $t('gainos.workspace.cockpitArchive') : $t('gainos.workspace.cockpitRestore') }}
                  </button>
                  <span class="wk__action-readonly" :title="readonlyLabel">{{ readonlyLabel }}</span>
                </div>
              </div>
            </li>
          </ol>
          <p v-else class="wk__empty">
            {{ actionView === 'todo' ? $t('gainos.workspace.cockpitActionsEmpty') : $t('gainos.workspace.cockpitActionsArchivedEmpty') }}
          </p>
        </section>
      </div>

      <aside class="wk__side">
        <!-- 提醒：异常/机会/建议 + 现有通知；通知点击仍会标已读并跳转。 -->
        <section
          id="workspace-notifications"
          class="gs-card wk__alerts"
          :class="{ 'is-highlight': highlightNotifications }"
          :aria-label="$t('gainos.workspace.cockpitAlerts')"
        >
          <header class="wk__section-head">
            <h2>{{ $t('gainos.workspace.cockpitAlerts') }}</h2>
            <div class="wk__section-actions">
              <span v-if="unreadCount > 0" class="wk__unread">
                {{ $t('gainos.workspace.notificationsUnread', { count: unreadCount }) }}
              </span>
              <button
                v-if="unreadCount > 0"
                type="button"
                class="wk__text-btn"
                :disabled="notificationsLoading"
                @click="markAllRead"
              >
                {{ $t('gainos.workspace.markAllRead') }}
              </button>
            </div>
          </header>

          <p v-if="notificationsLoading" class="wk__empty">{{ $t('gainos.common.loading') }}</p>
          <div v-else-if="notificationsError" class="wk__empty">
            <p>{{ notificationsError }}</p>
            <button type="button" class="wk__text-btn" @click="load">
              {{ $t('gainos.common.retry') }}
            </button>
          </div>
          <ul v-else-if="alertRows.length" class="wk__alert-list">
            <li v-for="alert in alertRows" :key="alert.key" class="wk__alert">
              <button type="button" class="wk__alert-main" @click="handleAlert(alert)">
                <span class="gs-badge" :class="alertBadgeClass(alert)">
                  {{ alertCategoryLabel(alert) }}
                </span>
                <span class="wk__alert-body">
                  <strong>{{ alert.title }}</strong>
                  <small v-if="alert.detail">{{ alert.detail }}</small>
                </span>
              </button>
              <span class="wk__alert-side">
                <time v-if="alert.time">{{ alert.time }}</time>
                <span
                  v-if="alert.notification && !alert.notification.readAt"
                  class="wk__dot"
                  aria-hidden="true"
                ></span>
              </span>
              <button
                type="button"
                class="wk__alert-go"
                :aria-label="`${handleLabel}：${alert.title}`"
                @click="handleAlert(alert)"
              >
                {{ handleLabel }} <span aria-hidden="true">→</span>
              </button>
            </li>
          </ul>
          <p v-else class="wk__empty">{{ $t('gainos.workspace.notificationsEmpty') }}</p>
        </section>

        <!-- 今日建议：一句话 + 唯一主按钮。 -->
        <section class="gs-card wk__suggestion" :aria-label="$t('gainos.workspace.cockpitSuggestion')">
          <h2>{{ $t('gainos.workspace.cockpitSuggestion') }}</h2>
          <p class="wk__suggestion-title" :title="nextAction.desc">
            {{ nextAction.title }}
          </p>
          <button
            type="button"
            class="wk__cta"
            :disabled="loading"
            @click="router.push(nextAction.to)"
          >
            {{ actNowLabel }} <span aria-hidden="true">→</span>
          </button>
        </section>

        <!-- 最近线索：保留原有入口与行点击行为。 -->
        <section class="gs-card wk__recent" :aria-label="$t('gainos.workspace.recentLeads')">
          <header class="wk__section-head">
            <h2>{{ $t('gainos.workspace.recentLeads') }}</h2>
            <button type="button" class="wk__text-btn" @click="router.push('/leads')">
              {{ $t('gainos.workspace.viewAllLeads') }}
            </button>
          </header>
          <p v-if="!loading && recentLeadRows.length === 0" class="wk__empty">
            {{ $t('gainos.workspace.recentLeadsEmpty') }}
          </p>
          <ul v-else class="wk__lead-list">
            <li v-for="lead in recentLeadRows" :key="lead.id">
              <button type="button" class="wk__lead" @click="openLead(lead)">
                <span class="wk__lead-avatar" aria-hidden="true">{{ leadInitial(lead) }}</span>
                <span class="wk__lead-body">
                  <strong>{{ leadCompanyName(lead) }}</strong>
                  <small v-if="lead.company?.domain">{{ lead.company.domain }}</small>
                </span>
                <span class="wk__lead-side">
                  <span class="wk__lead-badge">{{ queueLabel(lead.queue) }}</span>
                  <span v-if="leadScoreText(lead)" class="wk__lead-score">{{ leadScoreText(lead) }}</span>
                </span>
              </button>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>

.wk {
  display: grid;
  gap: var(--gs-space-6);
  max-width: var(--gs-page-max);
  margin: 0 auto;
  padding: var(--gs-page-pad);
}

.wk__error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--gs-danger-border);
  border-radius: var(--gs-radius-10);
  background: var(--gs-danger-bg);
  color: var(--gs-danger);
  font-size: 13px;
}
.wk__error p { margin: 4px 0 0; }
.wk__error button { flex: none; }

.wk__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.wk__identity { display: grid; gap: 6px; min-width: 0; }
.wk__title {
  margin: 0;
  font-size: 24px;
  line-height: 32px;
  font-weight: 500;
  letter-spacing: -0.011em;
  color: var(--gs-fg);
  overflow-wrap: anywhere;
}
.wk__meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wk__person { font-size: 13px; color: var(--gs-fg-muted); }
.wk__refresh {
  min-height: 40px;
  padding: 8px 16px;
  border: 1px solid var(--gs-border);
  border-radius: var(--gs-radius-10);
  background: var(--gs-surface);
  color: var(--gs-fg-2);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.wk__refresh:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.wk__refresh:disabled { cursor: default; opacity: 0.7; }

.wk__grid {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(300px, 1fr);
  gap: 20px;
  align-items: start;
}
.wk__main,
.wk__side { display: grid; gap: 20px; min-width: 0; }

.wk__summary,
.wk__stages,
.wk__actions,
.wk__alerts,
.wk__suggestion,
.wk__recent {
  min-width: 0;
  padding: 20px;
}

.wk__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.wk__section-head h2 {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--gs-fg);
}
.wk__section-sub {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--gs-fg-muted);
}
.wk__section-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.wk__kpi-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.wk__kpi {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--gs-border);
  border-radius: var(--gs-radius-10);
  background: var(--gs-surface-3);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.wk__kpi:hover {
  border-color: var(--gs-accent-soft-border);
  background: var(--gs-surface);
}
.wk__kpi-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 16px;
  color: var(--gs-fg-muted);
}
.wk__kpi-info {
  display: inline-grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: 1px solid var(--gs-border-strong);
  border-radius: 50%;
  color: var(--gs-fg-subtle);
  font-size: 9px;
  font-style: normal;
  line-height: 1;
}
.wk__kpi-value {
  font-size: 22px;
  line-height: 28px;
  font-weight: 500;
  color: var(--gs-fg);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.wk__kpi-value.is-text { font-size: 15px; line-height: 22px; }
.wk__kpi-value.is-ok { color: var(--gs-success); }
.wk__kpi-value.is-warn { color: var(--gs-warn); }
.wk__kpi-value.is-bad { color: var(--gs-danger); }
.wk__kpi-value.is-info { color: var(--gs-accent-strong); }

.wk__stage-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}
.wk__stage {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--gs-border);
  border-radius: var(--gs-radius-10);
  background: var(--gs-surface-3);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.wk__stage:hover {
  border-color: var(--gs-accent-soft-border);
  background: var(--gs-surface);
}
.wk__stage.is-current {
  border-color: var(--gs-accent);
  box-shadow: 0 0 0 3px var(--gs-accent-soft);
}
.wk__stage-top { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.wk__stage-index {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 50%;
  background: var(--gs-surface-2);
  color: var(--gs-fg-2);
  font-size: 11px;
  font-weight: 500;
}
.wk__stage.is-current .wk__stage-index {
  background: var(--gs-accent);
  color: var(--gs-accent-cta-fg);
}
.wk__stage.is-done .wk__stage-index {
  background: var(--gs-success-bg);
  color: var(--gs-success);
}
.wk__stage-top strong {
  display: -webkit-box;
  overflow: hidden;
  min-height: 32px;
  color: var(--gs-fg-2);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.wk__stage-value {
  color: var(--gs-fg);
  font-size: 22px;
  line-height: 28px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.wk__stage-bar {
  display: block;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--gs-surface-2);
}
.wk__stage-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--gs-accent);
  transition: width 0.35s ease;
}
.wk__stage.is-done .wk__stage-bar i { background: var(--gs-success); }
.wk__stage-pct {
  color: var(--gs-fg-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.wk__seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: var(--gs-surface-2);
}
.wk__seg button {
  padding: 5px 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.wk__seg button.is-active {
  background: var(--gs-surface);
  color: var(--gs-fg);
  box-shadow: var(--gs-shadow-xs);
}

.wk__action-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.wk__action {
  display: flex;
  gap: 12px;
  padding: 14px 0;
  border-top: 1px solid var(--gs-divider);
}
.wk__action:first-child { padding-top: 0; border-top: 0; }
.wk__action-index {
  width: 20px;
  flex: none;
  padding-top: 1px;
  color: var(--gs-fg-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.wk__action-body { display: grid; gap: 8px; min-width: 0; flex: 1; }
.wk__action-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.wk__action-head strong {
  color: var(--gs-fg);
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.wk__action-dot {
  width: 7px;
  height: 7px;
  flex: none;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--gs-fg-subtle);
}
.wk__action-dot.is-0 { background: var(--gs-danger); }
.wk__action-dot.is-1 { background: var(--gs-warn); }
.wk__action-dot.is-2 { background: var(--gs-accent); }
.wk__action-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.wk__action-go {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--gs-accent-strong);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.wk__action-go:hover { color: var(--gs-accent); }
.wk__action-readonly { color: var(--gs-fg-subtle); font-size: 11px; line-height: 16px; }

.wk__text-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--gs-fg-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.wk__text-btn:hover { color: var(--gs-accent-strong); }
.wk__text-btn:disabled { opacity: 0.5; cursor: default; }
.wk__unread {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-strong);
  font-size: 11px;
  font-weight: 500;
}

.wk__alert-list {
  display: grid;
  gap: 2px;
  max-height: 420px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
}
.wk__alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border-radius: var(--gs-radius-10);
  background: transparent;
}
.wk__alert:hover { background: var(--gs-surface-2); }
.wk__alert-main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  flex: 1;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wk__alert-main .gs-badge { flex: none; margin-top: 1px; }
.wk__alert-go {
  flex: none;
  align-self: center;
  padding: 4px 10px;
  border: 1px solid var(--gs-border);
  border-radius: 999px;
  background: var(--gs-surface);
  color: var(--gs-accent-strong);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}
.wk__alert-go:hover { border-color: var(--gs-accent); background: var(--gs-accent-soft); }
.wk__alert-body { display: grid; gap: 2px; min-width: 0; flex: 1; }
.wk__alert-body strong {
  color: var(--gs-fg);
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.wk__alert-body small {
  display: -webkit-box;
  overflow: hidden;
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  line-height: 16px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.wk__alert-side { display: grid; gap: 4px; flex: none; justify-items: end; }
.wk__alert-side time { color: var(--gs-fg-subtle); font-size: 10.5px; white-space: nowrap; }
.wk__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gs-accent); }
.wk__alerts { scroll-margin-top: 72px; transition: border-color 0.3s ease, box-shadow 0.3s ease; }
.wk__alerts.is-highlight {
  border-color: var(--gs-accent-soft-border);
  box-shadow: 0 0 0 4px var(--gs-accent-soft);
}

.wk__suggestion {
  border-color: var(--gs-accent-soft-border);
  background: var(--gs-accent-soft);
}
.wk__suggestion h2 {
  margin: 0 0 10px;
  color: var(--gs-accent-strong);
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
}
.wk__suggestion-title {
  margin: 0 0 16px;
  color: var(--gs-fg);
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.wk__cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 40px;
  border: 0;
  border-radius: var(--gs-radius-pill);
  background: var(--gs-accent-cta);
  color: var(--gs-accent-cta-fg);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--gs-shadow-xs);
}
.wk__cta:hover { background: var(--gs-accent-cta-hover); }
.wk__cta:disabled { cursor: default; opacity: 0.6; }

.wk__lead-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.wk__lead {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: var(--gs-radius-10);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wk__lead:hover { background: var(--gs-surface-2); }
.wk__lead-avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-strong);
  font-size: 12px;
  font-weight: 500;
}
.wk__lead-body { display: grid; gap: 2px; min-width: 0; flex: 1; }
.wk__lead-body strong {
  overflow: hidden;
  color: var(--gs-fg);
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wk__lead-body small {
  overflow: hidden;
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wk__lead-side { display: grid; gap: 3px; flex: none; justify-items: end; }
.wk__lead-badge {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--gs-surface-2);
  color: var(--gs-fg-2);
  font-size: 10.5px;
  font-weight: 500;
}
.wk__lead-score { color: var(--gs-fg-muted); font-size: 11px; font-variant-numeric: tabular-nums; }

.wk__empty {
  margin: 0;
  padding: 24px 8px;
  color: var(--gs-fg-muted);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}
.wk__empty p { margin: 0 0 8px; }

@media (max-width: 1100px) {
  .wk__grid { grid-template-columns: minmax(0, 1fr); }
  .wk__kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wk__stage-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 640px) {
  .wk__head { flex-direction: column; align-items: stretch; }
  .wk__refresh { align-self: flex-start; }
  .wk__kpi-grid { grid-template-columns: minmax(0, 1fr); }
  .wk__stage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wk__summary,
  .wk__stages,
  .wk__actions,
  .wk__alerts,
  .wk__suggestion,
  .wk__recent { padding: 16px; }
  .wk__alerts { scroll-margin-top: 16px; }
}
</style>
