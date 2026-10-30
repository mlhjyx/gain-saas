<script lang="ts" setup>
import type { SessionInfo } from '#/api/gainos';

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

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

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();

/** 六步主链路(PRD §14.1/§14.3):界面永远回答"我在哪、下一步做什么" */
const STEP_KEYS = [
  'gainos.workspace.stepProfile',
  'gainos.workspace.stepIcp',
  'gainos.workspace.stepPlan',
  'gainos.workspace.stepRun',
  'gainos.workspace.stepJudge',
  'gainos.workspace.stepReport',
] as const;
const STEPS = computed(() =>
  STEP_KEYS.map((key) => ({ key, label: $t(key) })),
);

const loading = ref(true);
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
  if (pendingLeadCount.value > 0 || openRecommendedCount.value > 0) return 5;
  if (acceptedLeadCount.value > 0) return 6;
  return 5;
});

const pipelineSummary = computed(() => {
  if (loading.value) return $t('gainos.workspace.summaryLoading');
  const icp = activeIcp.value;
  if (icp) {
    if (pendingLeadCount.value > 0) {
      return $t('gainos.workspace.summaryIcpPending', {
        name: icp.name,
        count: pendingLeadCount.value,
      });
    }
    if (recommendedLeadCount.value > 0) {
      return $t('gainos.workspace.summaryIcpFollowing', {
        name: icp.name,
        count: recommendedLeadCount.value,
      });
    }
    return $t('gainos.workspace.summaryIcp', { name: icp.name });
  }
  if (companies.value.length > 0) return $t('gainos.workspace.summaryNoIcp');
  return $t('gainos.workspace.summaryEmpty');
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
          title: $t('gainos.workspace.nextReportTitle'),
          desc: $t('gainos.workspace.nextReportDesc'),
          action: $t('gainos.workspace.nextReportAction'),
          to: '/reports',
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
      title: $t('gainos.workspace.nextReportTitle'),
      desc: $t('gainos.workspace.nextReportDesc'),
      action: $t('gainos.workspace.nextReportAction'),
      to: '/reports',
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
    title: $t('gainos.workspace.nextDoneTitle'),
    desc: $t('gainos.workspace.nextDoneDesc'),
    action: $t('gainos.workspace.nextDoneAction'),
    to: '/reports',
  };
});

const kpis = computed(() => {
  const loaded = !loading.value;
  const buyer = activeIcp.value;
  const run = latestRun.value;
  const link = latestRunLink.value;
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
      to: link ? `/runs/${link.runId}` : '/find-buyers',
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
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function icpStatusLabel(status?: string): string {
  const key = `gainos.findBuyers.icpStatus.${status ?? 'DRAFT'}`;
  const translated = $t(key);
  return translated === key ? (status ?? '') : translated;
}
function planStatusLabel(status?: string): string {
  const key = `gainos.findBuyers.planStatus.${status ?? 'DRAFT'}`;
  const translated = $t(key);
  return translated === key ? (status ?? '') : translated;
}
function runStatusLabel(status?: string): string {
  const key = `gainos.runs.status.${status ?? 'RUNNING'}`;
  const translated = $t(key);
  return translated === key ? (status ?? '') : translated;
}
function queueLabel(queue?: string): string {
  const map: Record<string, string> = {
    recommended: $t('gainos.leads.queueQualified'),
    needs_review: $t('gainos.leads.queueReview'),
    rejected: $t('gainos.leads.queueRejected'),
    suppressed: $t('gainos.leads.queueSuppressed'),
    sanctions_hold: $t('gainos.leads.queueSanctions'),
  };
  return (queue && map[queue]) || $t('gainos.leads.queueReview');
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

function notificationIcon(type: string): string {
  switch (type) {
    case 'DiscoveryRunCompleted': return '✅';
    case 'DiscoveryRunPartial': return '⚠️';
    case 'DiscoveryRunFailed': return '⛔';
    case 'LeadQualified': return '🎯';
    case 'ClaimApproved': return '👍';
    case 'ClaimRejected': return '👎';
    default: return '🔔';
  }
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

    // 同一工作空间可能有多份生效中的目标买家；优先展示最近真实发起过寻源的那份，
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
  } finally {
    loading.value = false;
    notificationsLoading.value = false;
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
    <header class="wk__hero">
      <div class="wk__hero-main">
        <div class="wk__eyebrow">
          <span v-if="workspaceName" class="wk__workspace">{{ workspaceName }}</span>
          <span v-if="roleLabel" class="wk__role">{{ roleLabel }}</span>
        </div>
        <p v-if="displayName" class="wk__hi">{{ displayName }}</p>
        <h1 class="wk__title">{{ $t('gainos.workspace.title', { greeting }) }}</h1>
        <p class="wk__summary">{{ pipelineSummary }}</p>
      </div>
      <button class="wk__refresh" type="button" :class="{ 'is-loading': loading }" @click="load">
        {{ loading ? $t('gainos.common.refreshing') : $t('gainos.common.refresh') }}
      </button>
    </header>

    <!-- 六步主链路 -->
    <section class="wk__steps" :aria-label="$t('gainos.workspace.stepProgress', { current: currentStep, total: STEPS.length })">
      <div class="wk__steps-mobile">
        <span class="wk__steps-count">{{ $t('gainos.workspace.stepProgress', { current: currentStep, total: STEPS.length }) }}</span>
        <strong>{{ STEPS[currentStep - 1]?.label }}</strong>
        <span class="wk__steps-bar">
          <i :style="{ width: `${(currentStep / STEPS.length) * 100}%` }"></i>
        </span>
      </div>
      <template v-for="(step, i) in STEPS" :key="step.key">
        <div class="wk__step" :class="{ 'is-done': i + 1 < currentStep, 'is-current': i + 1 === currentStep }">
          <span class="wk__step-dot">
            <svg v-if="i + 1 < currentStep" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m3 8.5 3.2 3L13 5"/></svg>
            <template v-else>{{ i + 1 }}</template>
          </span>
          <span class="wk__step-label">{{ step.label }}</span>
        </div>
        <span v-if="i < STEPS.length - 1" class="wk__step-bar" :class="{ 'is-done': i + 1 < currentStep }"></span>
      </template>
    </section>

    <!-- 下一步 -->
    <section class="wk__next">
      <div class="wk__next-body">
        <span class="wk__next-kicker">{{ nextAction.kicker }}</span>
        <h2>{{ nextAction.title }}</h2>
        <p>{{ nextAction.desc }}</p>
      </div>
      <button class="wk__next-cta" type="button" :disabled="loading" @click="router.push(nextAction.to)">
        {{ nextAction.action }}
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10h11M11 5.5 15.5 10 11 14.5"/></svg>
      </button>
    </section>

    <!-- 业务概览 -->
    <section class="wk__overview">
      <div class="wk__section-head">
        <h2>{{ $t('gainos.workspace.overviewTitle') }}</h2>
      </div>
      <div class="wk__kpi-grid">
        <button
          v-for="kpi in kpis"
          :key="kpi.key"
          type="button"
          class="wk__kpi"
          :class="`wk__kpi--${kpi.key}`"
          @click="router.push(kpi.to)"
        >
          <span class="wk__kpi-icon" aria-hidden="true">{{ kpi.icon }}</span>
          <span class="wk__kpi-body">
            <span class="wk__kpi-label">{{ kpi.label }}</span>
            <strong class="wk__kpi-value" :class="[kpi.text ? 'is-text' : '', kpi.valueClass]">{{ kpi.value }}</strong>
            <span class="wk__kpi-hint">{{ kpi.hint }}</span>
          </span>
          <span class="wk__kpi-arrow" aria-hidden="true">→</span>
        </button>
      </div>
    </section>

    <!-- 通知与最近线索 -->
    <div class="wk__panels">
      <section
        id="workspace-notifications"
        class="wk__panel wk__notifications"
        :class="{ 'is-highlight': highlightNotifications }"
        :aria-label="$t('gainos.notifications.default')"
      >
        <header class="wk__panel-head">
          <h2>{{ $t('gainos.notifications.default') }}</h2>
          <div class="wk__panel-head-actions">
            <span v-if="unreadCount > 0" class="wk__unread">{{ $t('gainos.workspace.notificationsUnread', { count: unreadCount }) }}</span>
            <button v-if="unreadCount > 0" type="button" class="wk__text-btn" :disabled="notificationsLoading" @click="markAllRead">
              {{ $t('gainos.workspace.markAllRead') }}
            </button>
          </div>
        </header>

        <p v-if="notificationsLoading" class="wk__empty">{{ $t('gainos.common.loading') }}</p>
        <div v-else-if="notificationsError" class="wk__empty">
          <p>{{ notificationsError }}</p>
          <button type="button" class="wk__text-btn" @click="load">{{ $t('gainos.common.retry') }}</button>
        </div>
        <p v-else-if="notifications.length === 0" class="wk__empty">{{ $t('gainos.workspace.notificationsEmpty') }}</p>
        <ul v-else class="wk__notif-list">
          <li v-for="item in notifications" :key="item.id">
            <button type="button" class="wk__notif" :class="{ 'is-unread': !item.readAt }" @click="openNotification(item)">
              <span class="wk__notif-icon" aria-hidden="true">{{ notificationIcon(item.type) }}</span>
              <span class="wk__notif-body">
                <strong>{{ notificationTitle(item) }}</strong>
                <small v-if="notificationMessage(item)">{{ notificationMessage(item) }}</small>
                <time>{{ formatTime(item.createdAt) }}</time>
              </span>
              <span v-if="!item.readAt" class="wk__notif-dot" aria-hidden="true"></span>
            </button>
          </li>
        </ul>
      </section>

      <section class="wk__panel">
        <header class="wk__panel-head">
          <h2>{{ $t('gainos.workspace.recentLeads') }}</h2>
          <button type="button" class="wk__text-btn" @click="router.push('/leads')">{{ $t('gainos.workspace.viewAllLeads') }}</button>
        </header>
        <p v-if="recentLeadRows.length === 0" class="wk__empty">{{ $t('gainos.workspace.recentLeadsEmpty') }}</p>
        <ul v-else class="wk__lead-list">
          <li v-for="lead in recentLeadRows" :key="lead.id">
            <button type="button" class="wk__lead" @click="openLead(lead)">
              <span class="wk__lead-avatar" aria-hidden="true">{{ leadInitial(lead) }}</span>
              <span class="wk__lead-body">
                <strong>{{ leadCompanyName(lead) }}</strong>
                <small v-if="lead.company?.domain">{{ lead.company.domain }}</small>
              </span>
              <span class="wk__lead-side">
                <span class="wk__lead-badge" :class="`wk__lead-badge--${lead.queue ?? 'needs_review'}`">{{ queueLabel(lead.queue) }}</span>
                <span v-if="leadScoreText(lead)" class="wk__lead-score">{{ leadScoreText(lead) }}</span>
              </span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wk {
  /* 页面容器：统一外边距与可读宽度上限(vben 内容区默认 0 内边距) */
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px;
  margin: 0 auto;
  display: grid; gap: 20px;
}
.wk__hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
.wk__hero-main { min-width: 0; }
.wk__eyebrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.wk__workspace {
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; font-weight: 600; color: var(--gs-accent-strong);
  background: var(--gs-accent-soft); border-radius: 999px; padding: 4px 10px;
}
.wk__role {
  font-size: 11.5px; color: var(--gs-fg-subtle); border: 1px solid var(--gs-border);
  border-radius: 999px; padding: 3px 8px;
}
.wk__hi { margin: 0 0 6px; font-size: 13.5px; color: var(--gs-fg-muted); }
.wk__title { margin: 0; font-size: clamp(21px, 2.2vw, 26px); font-weight: 700; color: var(--gs-fg); letter-spacing: .01em; text-wrap: pretty; }
.wk__summary { margin: 8px 0 0; max-width: 680px; font-size: 13px; line-height: 1.7; color: var(--gs-fg-muted); }
.wk__refresh {
  border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 10px; padding: 8px 16px;
  font-size: 13px; color: var(--gs-fg-2); cursor: pointer; white-space: nowrap; transition: border-color .15s ease, color .15s ease;
}
.wk__refresh:hover { border-color: var(--gs-accent); color: var(--gs-accent-strong); }
.wk__refresh:disabled { cursor: default; opacity: .7; }

.wk__steps {
  display: flex; align-items: center; gap: 8px; padding: 20px 22px;
  background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 16px;
  overflow-x: auto; scrollbar-width: none;
}
.wk__step { display: flex; align-items: center; gap: 8px; flex: none; }
.wk__step-dot {
  width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 12.5px; font-weight: 600; color: var(--gs-fg-subtle); background: var(--gs-divider); border: 1.5px solid transparent;
  transition: all .2s ease;
}
.wk__step-dot svg { width: 13px; height: 13px; }
.wk__step.is-done .wk__step-dot { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.wk__step.is-current .wk__step-dot { background: var(--gs-accent); color: #fff; box-shadow: 0 0 0 4px color-mix(in srgb, var(--gs-accent) 18%, transparent); }
.wk__step-label { font-size: 13.5px; color: var(--gs-fg-muted); white-space: nowrap; }
.wk__step.is-current .wk__step-label { color: var(--gs-fg); font-weight: 600; }
.wk__step.is-done .wk__step-label { color: var(--gs-fg-2); }
.wk__step-bar { flex: 1; min-width: 18px; height: 2px; background: var(--gs-border); border-radius: 1px; }
.wk__step-bar.is-done { background: var(--gs-accent-soft-border); }

.wk__steps-mobile { display: none; }
@media (max-width: 720px) {
  .wk__steps { padding: 16px 18px; }
  .wk__step, .wk__step-bar { display: none; }
  .wk__steps-mobile { display: flex; flex-direction: column; gap: 8px; width: 100%; }
  .wk__steps-count { font-size: 12px; color: var(--gs-fg-muted); letter-spacing: .04em; }
  .wk__steps-mobile strong { font-size: 15px; color: var(--gs-fg); }
  .wk__steps-bar { height: 4px; border-radius: 2px; background: var(--gs-surface-2); overflow: hidden; }
  .wk__steps-bar i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--gs-accent), var(--gs-accent-strong)); transition: width .4s ease; }
}

.wk__next {
  display: flex; align-items: center; justify-content: space-between; gap: 24px;
  padding: 24px 26px; border-radius: 16px;
  background: linear-gradient(120deg, var(--gs-hero-from) 0%, var(--gs-hero-via) 70%, var(--gs-hero-to) 100%);
  color: var(--gs-hero-fg);
}
.wk__next-kicker {
  display: inline-block; font-size: 11.5px; letter-spacing: .28em; color: var(--gs-hero-accent);
  font-weight: 700; margin-bottom: 8px;
}
.wk__next-body { min-width: 0; }
.wk__next-body h2 { margin: 0 0 8px; font-size: 20px; font-weight: 700; }
.wk__next-body p { margin: 0; max-width: 620px; font-size: 13.5px; line-height: 1.8; color: var(--gs-hero-fg-soft); }
.wk__next-cta {
  flex: none; display: inline-flex; align-items: center; gap: 8px;
  border: 0; border-radius: 12px; padding: 12px 22px; cursor: pointer;
  background: var(--gs-accent); color: #fff; font-size: 14.5px; font-weight: 600;
  box-shadow: 0 8px 20px -6px var(--gs-accent-glow);
  transition: transform .16s ease, box-shadow .16s ease;
}
.wk__next-cta:hover { transform: translateY(-1px); box-shadow: 0 12px 26px -6px rgba(0,185,107,.6); }
.wk__next-cta:active { transform: scale(.97); }
.wk__next-cta:disabled { opacity: .65; cursor: default; transform: none; }
.wk__next-cta svg { width: 17px; height: 17px; }

.wk__section-head h2 { margin: 0 0 10px; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.wk__kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.wk__kpi {
  display: flex; align-items: flex-start; gap: 12px; text-align: left; font: inherit;
  background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px;
  padding: 15px 16px; cursor: pointer; min-width: 0;
  transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
}
.wk__kpi:hover { border-color: var(--gs-accent-soft-border); transform: translateY(-1px); box-shadow: 0 12px 26px -22px var(--gs-accent-glow); }
.wk__kpi-icon {
  width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center;
  font-size: 16px; background: var(--gs-divider); flex: none;
}
.wk__kpi--companies .wk__kpi-icon { background: var(--gs-indigo-soft); }
.wk__kpi--buyers .wk__kpi-icon { background: var(--gs-accent-soft); }
.wk__kpi--run .wk__kpi-icon { background: var(--gs-warn-bg); }
.wk__kpi--pending .wk__kpi-icon { background: var(--gs-warn-bg); }
.wk__kpi--following .wk__kpi-icon { background: var(--gs-accent-soft); }
.wk__kpi-body { display: grid; gap: 3px; min-width: 0; flex: 1; }
.wk__kpi-label { font-size: 12px; color: var(--gs-fg-subtle); }
.wk__kpi-value { font-size: 24px; line-height: 1.15; font-weight: 700; color: var(--gs-fg); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.wk__kpi-value.is-text { font-size: 16px; font-weight: 650; line-height: 1.4; }
.wk__kpi-value.is-ok { color: var(--gs-accent-strong); }
.wk__kpi-value.is-warn { color: var(--gs-warn); }
.wk__kpi-value.is-bad { color: var(--gs-danger); }
.wk__kpi-value.is-info { color: var(--gs-indigo); }
.wk__kpi-hint {
  font-size: 11.5px; color: var(--gs-fg-muted); line-height: 1.5;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.wk__kpi-arrow { color: var(--gs-fg-subtle); font-size: 15px; flex: none; margin-top: 2px; }

.wk__panels { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.wk__panel {
  background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 16px;
  padding: 18px 20px; scroll-margin-top: 72px; min-width: 0;
  transition: border-color .3s ease, box-shadow .3s ease;
}
.wk__panel.is-highlight { border-color: var(--gs-accent-soft-border); box-shadow: 0 0 0 4px var(--gs-accent-soft); }
.wk__panel-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.wk__panel-head h2 { margin: 0; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.wk__panel-head-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wk__unread {
  font-size: 11px; font-weight: 600; color: var(--gs-accent-strong);
  background: var(--gs-accent-soft); border-radius: 999px; padding: 2px 8px;
}
.wk__text-btn {
  border: 0; background: transparent; padding: 2px 0; cursor: pointer;
  font-size: 12.5px; font-weight: 600; color: var(--gs-accent-strong);
}
.wk__text-btn:hover { color: var(--gs-accent); }
.wk__text-btn:disabled { opacity: .5; cursor: default; }

.wk__notif-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 440px; overflow-y: auto; overscroll-behavior: contain; }
.wk__notif { width: 100%; display: flex; align-items: flex-start; gap: 10px; text-align: left; font: inherit; border: 0; background: transparent; border-radius: 10px; padding: 10px 8px; cursor: pointer; }
.wk__notif:hover { background: var(--gs-divider); }
.wk__notif.is-unread { background: color-mix(in srgb, var(--gs-accent-soft) 42%, transparent); }
.wk__notif-icon {
  width: 28px; height: 28px; border-radius: 8px; flex: none; display: grid; place-items: center;
  font-size: 13px; background: var(--gs-surface); border: 1px solid var(--gs-border);
}
.wk__notif-body { min-width: 0; flex: 1; display: grid; gap: 2px; }
.wk__notif-body strong { font-size: 12.8px; font-weight: 600; color: var(--gs-fg); }
.wk__notif-body small { font-size: 11.8px; line-height: 1.55; color: var(--gs-fg-muted); }
.wk__notif-body time { font-size: 11px; color: var(--gs-fg-subtle); }
.wk__notif-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gs-accent); flex: none; margin-top: 8px; }

.wk__lead-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.wk__lead { width: 100%; display: flex; align-items: center; gap: 10px; text-align: left; font: inherit; cursor: pointer; background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 11px; padding: 10px 12px; transition: border-color .15s ease, background .15s ease; }
.wk__lead:hover { border-color: var(--gs-accent-soft-border); background: var(--gs-surface-3); }
.wk__lead-avatar {
  width: 30px; height: 30px; border-radius: 9px; flex: none; display: grid; place-items: center;
  font-size: 13px; font-weight: 700; color: var(--gs-accent-strong); background: var(--gs-accent-soft);
}
.wk__lead-body { min-width: 0; flex: 1; display: grid; gap: 2px; }
.wk__lead-body strong { font-size: 12.8px; color: var(--gs-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk__lead-body small { font-size: 11.5px; color: var(--gs-fg-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wk__lead-side { flex: none; display: grid; justify-items: end; gap: 3px; }
.wk__lead-badge { font-size: 10.5px; font-weight: 600; border-radius: 999px; padding: 2px 7px; background: var(--gs-divider); color: var(--gs-fg-2); }
.wk__lead-badge--recommended { background: var(--gs-accent-soft); color: var(--gs-accent-strong); }
.wk__lead-badge--needs_review { background: var(--gs-warn-bg); color: var(--gs-warn); }
.wk__lead-badge--sanctions_hold { background: var(--gs-danger-bg); color: var(--gs-danger); }
.wk__lead-score { font-size: 11px; color: var(--gs-fg-muted); font-variant-numeric: tabular-nums; }

.wk__empty { margin: 0; padding: 26px 10px; text-align: center; font-size: 12.8px; line-height: 1.7; color: var(--gs-fg-subtle); }
.wk__empty p { margin: 0 0 8px; }

@media (max-width: 1024px) {
  .wk__kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wk__panels { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .wk__hero { flex-direction: column; align-items: flex-start; }
  .wk__refresh { align-self: stretch; }
  .wk__next { flex-direction: column; align-items: flex-start; }
  .wk__next-cta { align-self: stretch; justify-content: center; }
  .wk__kpi-grid { grid-template-columns: minmax(0, 1fr); }
  .wk__notifications { scroll-margin-top: 16px; }
}
</style>
