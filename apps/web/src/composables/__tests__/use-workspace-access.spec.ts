import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserInfoApiMock, workspaceContextMock } = vi.hoisted(() => ({
  getUserInfoApiMock: vi.fn(),
  workspaceContextMock: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: { value: { fullPath: '/workspace', path: '/workspace' } },
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));

vi.mock('#/api', () => ({
  getAccessCodesApi: vi.fn(async () => []),
  getUserInfoApi: getUserInfoApiMock,
  loginApi: vi.fn(),
  logoutApi: vi.fn(),
}));

vi.mock('#/api/gainos', () => ({
  gainosApi: {
    onboardingStatus: vi.fn(async () => ({ complete: true, companyId: null })),
    workspaceContext: workspaceContextMock,
  },
}));

vi.mock('#/feedback', () => ({
  feedback: {
    confirm: vi.fn(),
    message: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
    notification: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
  },
}));

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

import { useAccessStore, useUserStore } from '@vben/stores';

import { useWorkspaceAccess } from '#/composables/use-workspace-access';
import { useAuthStore } from '#/store/auth';

function mockContext(role: 'admin' | 'member', allowedActions: string[]) {
  return {
    user: { id: 'user-1', email: 'u@acme.example' },
    workspace: { id: 'ws-1', name: 'Acme Co.', role },
    onboarding: { complete: true, companyId: 'co-1' },
    allowedActions,
  };
}

describe('useAuthStore.fetchUserInfo accessCodes sync (Review Focus #5)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getUserInfoApiMock.mockReset();
    workspaceContextMock.mockReset();
  });

  it('clears persisted stale ADMIN accessCode when downgraded member refreshes session', async () => {
    const accessStore = useAccessStore();
    const userStore = useUserStore();
    const authStore = useAuthStore();

    // Simulate persisted localStorage state from prior admin session before F5 refresh.
    accessStore.setAccessCodes(['ADMIN']);
    getUserInfoApiMock.mockResolvedValueOnce({
      userId: 'user-1',
      username: 'member@acme.example',
      realName: 'Member',
      roles: ['member'],
      avatar: '',
      desc: '',
      homePath: '/workspace',
      token: '',
    });

    await authStore.fetchUserInfo();

    expect(userStore.userInfo?.roles).toEqual(['member']);
    expect(accessStore.accessCodes).toEqual([]);
  });

  it('restores ADMIN accessCode when promoted admin refreshes session', async () => {
    const accessStore = useAccessStore();
    const authStore = useAuthStore();

    accessStore.setAccessCodes([]);
    getUserInfoApiMock.mockResolvedValueOnce({
      userId: 'user-1',
      username: 'admin@acme.example',
      realName: 'Admin',
      roles: ['admin'],
      avatar: '',
      desc: '',
      homePath: '/workspace',
      token: '',
    });

    await authStore.fetchUserInfo();

    expect(accessStore.accessCodes).toEqual(['ADMIN']);
  });
});

describe('useWorkspaceAccess', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getUserInfoApiMock.mockReset();
    workspaceContextMock.mockReset();
  });

  it('fails closed before workspaceContext finishes loading even if userInfo claims admin', () => {
    const userStore = useUserStore();
    userStore.setUserInfo({
      userId: 'user-1',
      username: 'admin@acme.example',
      realName: 'Admin',
      roles: ['admin'],
      avatar: '',
      desc: '',
      homePath: '/workspace',
      token: '',
    });

    const access = useWorkspaceAccess();

    expect(access.loaded.value).toBe(false);
    expect(access.isAdmin.value).toBe(false);
    expect(access.role.value).toBeNull();
    expect(access.allowedActions.value).toEqual([]);
    expect(access.can('campaigns.draft')).toBe(false);
    expect(access.can('outreach.draft')).toBe(false);
  });

  it('grants admin capabilities only when userInfo.roles and workspaceContext both agree on admin', async () => {
    const userStore = useUserStore();
    userStore.setUserInfo({
      userId: 'user-1',
      username: 'admin@acme.example',
      realName: 'Admin',
      roles: ['admin'],
      avatar: '',
      desc: '',
      homePath: '/workspace',
      token: '',
    });
    workspaceContextMock.mockResolvedValueOnce(
      mockContext('admin', [
        'workspace.rename',
        'campaigns.view',
        'campaigns.draft',
        'campaigns.approve',
        'outreach.view',
        'outreach.draft',
        'outreach.warmup.view',
      ]),
    );

    const access = useWorkspaceAccess();
    await access.ensureLoaded();

    expect(access.loaded.value).toBe(true);
    expect(access.role.value).toBe('admin');
    expect(access.isAdmin.value).toBe(true);
    expect(access.can('campaigns.draft')).toBe(true);
    expect(access.can('outreach.warmup.view')).toBe(true);
    expect(access.can('reports.view')).toBe(false);
  });

  it('keeps member read-only and supports future M9 member draft grants via can()', async () => {
    const userStore = useUserStore();
    userStore.setUserInfo({
      userId: 'user-2',
      username: 'member@acme.example',
      realName: 'Member',
      roles: ['member'],
      avatar: '',
      desc: '',
      homePath: '/workspace',
      token: '',
    });
    workspaceContextMock.mockResolvedValueOnce(
      mockContext('member', ['workspace.leave', 'campaigns.view', 'outreach.view']),
    );

    const access = useWorkspaceAccess();
    await access.ensureLoaded();

    expect(access.role.value).toBe('member');
    expect(access.isAdmin.value).toBe(false);
    expect(access.can('campaigns.view')).toBe(true);
    expect(access.can('campaigns.draft')).toBe(false);
    expect(access.can('outreach.draft')).toBe(false);
    expect(access.can('outreach.warmup.view')).toBe(false);

    // Wave C M9 future grant: member stays non-admin while gaining draft capability from server allowedActions.
    workspaceContextMock.mockResolvedValueOnce(
      mockContext('member', ['campaigns.view', 'campaigns.draft', 'outreach.view', 'outreach.draft']),
    );
    await access.ensureLoaded(true);

    expect(access.isAdmin.value).toBe(false);
    expect(access.can('campaigns.draft')).toBe(true);
    expect(access.can('outreach.draft')).toBe(true);
    expect(access.can('outreach.approve')).toBe(false);
  });

  it('fails closed on role mismatch in either direction between userInfo and workspaceContext', async () => {
    const userStore = useUserStore();
    userStore.setUserInfo({
      userId: 'user-1',
      username: 'downgraded@acme.example',
      realName: 'Downgraded',
      roles: ['member'],
      avatar: '',
      desc: '',
      homePath: '/workspace',
      token: '',
    });
    workspaceContextMock.mockResolvedValueOnce(
      mockContext('admin', ['campaigns.draft', 'outreach.draft', 'outreach.warmup.view']),
    );

    const access = useWorkspaceAccess();
    await access.ensureLoaded();

    expect(access.isAdmin.value).toBe(false);
    expect(access.role.value).toBe('member');
    expect(access.can('campaigns.draft')).toBe(false);
    expect(access.can('outreach.warmup.view')).toBe(false);

    // Reverse mismatch: userInfo says admin, server context says member.
    userStore.setUserInfo({
      userId: 'user-1',
      username: 'downgraded@acme.example',
      realName: 'Downgraded',
      roles: ['admin'],
      avatar: '',
      desc: '',
      homePath: '/workspace',
      token: '',
    });
    workspaceContextMock.mockResolvedValueOnce(mockContext('member', ['campaigns.view', 'outreach.view']));

    await access.ensureLoaded();

    expect(access.isAdmin.value).toBe(false);
    expect(access.role.value).toBe('member');
    expect(access.can('campaigns.draft')).toBe(false);
  });

  it('deduplicates concurrent ensureLoaded calls and fails closed on API error', async () => {
    const userStore = useUserStore();
    userStore.setUserInfo({
      userId: 'user-1',
      username: 'admin@acme.example',
      realName: 'Admin',
      roles: ['admin'],
      avatar: '',
      desc: '',
      homePath: '/workspace',
      token: '',
    });

    let resolveCtx!: (value: ReturnType<typeof mockContext>) => void;
    workspaceContextMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCtx = resolve;
      }),
    );

    const access = useWorkspaceAccess();
    const p1 = access.ensureLoaded();
    const p2 = access.ensureLoaded();
    expect(workspaceContextMock).toHaveBeenCalledTimes(1);

    resolveCtx(mockContext('admin', ['campaigns.draft']));
    await Promise.all([p1, p2]);
    expect(access.isAdmin.value).toBe(true);

    // Subsequent call without force reuses cache; force=true error fails closed.
    await access.ensureLoaded();
    expect(workspaceContextMock).toHaveBeenCalledTimes(1);

    workspaceContextMock.mockRejectedValueOnce(new Error('network down'));
    await access.ensureLoaded(true);
    expect(access.loaded.value).toBe(true);
    expect(access.isAdmin.value).toBe(false);
    expect(access.can('campaigns.draft')).toBe(false);
  });
});
