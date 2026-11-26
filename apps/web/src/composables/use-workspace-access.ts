import type { WorkspaceContextView } from '#/api/gainos';

import { computed, ref } from 'vue';

import { useUserStore } from '@vben/stores';
import { defineStore } from 'pinia';

import { gainosApi } from '#/api/gainos';

export type WorkspaceRole = 'admin' | 'member';

const useWorkspaceAccessStore = defineStore('gainos-workspace-access', () => {
  const context = ref<WorkspaceContextView | null>(null);
  const loaded = ref(false);
  const loadedForKey = ref<string | null>(null);
  let inFlight: Promise<WorkspaceContextView | null> | null = null;
  let inFlightKey: string | null = null;
  let requestSeq = 0;

  async function ensureLoaded(identityKey: string, force = false): Promise<WorkspaceContextView | null> {
    if (!force && loaded.value && loadedForKey.value === identityKey) {
      return context.value;
    }
    if (!force && inFlight && inFlightKey === identityKey) {
      return inFlight;
    }

    const seq = ++requestSeq;
    const request = (async () => {
      let nextContext: WorkspaceContextView | null = null;
      try {
        const res = await gainosApi.workspaceContext();
        nextContext = res ?? null;
      } catch {
        nextContext = null;
      } finally {
        if (seq === requestSeq) {
          context.value = nextContext;
          loaded.value = true;
          loadedForKey.value = identityKey;
          inFlight = null;
          inFlightKey = null;
        }
      }
      return seq === requestSeq ? context.value : nextContext;
    })();

    inFlight = request;
    inFlightKey = identityKey;
    return request;
  }

  function $reset(): void {
    requestSeq += 1;
    context.value = null;
    loaded.value = false;
    loadedForKey.value = null;
    inFlight = null;
    inFlightKey = null;
  }

  return {
    $reset,
    context,
    ensureLoaded,
    loaded,
    loadedForKey,
  };
});

/**
 * 工作空间角色与能力组合式函数（PR-A2）：
 * - `isAdmin` 以 `userStore.userInfo?.roles` 与 `/api/workspace/context` 双重一致为准；
 * - 上下文未加载完成、接口异常或角色不一致时严格 fail-closed（写能力一律返回 false）；
 * - `can(action)` 消费服务端 `allowedActions`，为波次 C M9 解锁 member 起草能力预留接口。
 */
export function useWorkspaceAccess() {
  const userStore = useUserStore();
  const store = useWorkspaceAccessStore();

  const identityKey = computed(() => {
    const info = userStore.userInfo;
    if (!info) return '';
    const roles = Array.isArray(info.roles) ? [...info.roles].sort().join(',') : '';
    return `${info.userId ?? ''}:${roles}`;
  });

  const loaded = computed(() => store.loaded && store.loadedForKey === identityKey.value);

  const effectiveContext = computed<WorkspaceContextView | null>(() =>
    loaded.value ? store.context : null,
  );

  const sessionRoles = computed<string[]>(() =>
    Array.isArray(userStore.userInfo?.roles) ? userStore.userInfo.roles : [],
  );

  const role = computed<WorkspaceRole | null>(() => {
    const ctx = effectiveContext.value;
    if (!ctx) return null;
    const contextRole = ctx.workspace?.role;
    const sessionIsAdmin = sessionRoles.value.includes('admin');
    const sessionIsMember = sessionRoles.value.includes('member');
    if (sessionIsAdmin && contextRole === 'admin') {
      return 'admin';
    }
    if (contextRole === 'member' || sessionIsMember) {
      return 'member';
    }
    return null;
  });

  const isAdmin = computed<boolean>(() => role.value === 'admin');

  const allowedActions = computed<readonly string[]>(() => {
    const ctx = effectiveContext.value;
    if (!ctx) return [];
    // 若服务端返回 admin 上下文但当前会话角色并非 admin，按 fail-closed 拒绝全部动作。
    if (ctx.workspace?.role === 'admin' && !sessionRoles.value.includes('admin')) {
      return [];
    }
    return Array.isArray(ctx.allowedActions) ? ctx.allowedActions : [];
  });

  function can(action: string): boolean {
    if (!loaded.value || !effectiveContext.value) return false;
    return allowedActions.value.includes(action);
  }

  function ensureLoaded(force = false): Promise<WorkspaceContextView | null> {
    return store.ensureLoaded(identityKey.value, force);
  }

  return {
    allowedActions,
    can,
    ensureLoaded,
    isAdmin,
    loaded,
    role,
  };
}
