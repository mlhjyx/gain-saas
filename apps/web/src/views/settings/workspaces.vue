<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';

import { $t } from '#/locales';

import { failureText, gainosApi, type WorkspaceSummary } from '#/api/gainos';

defineOptions({ name: 'SettingsWorkspaces' });

const loading = ref(true);
const error = ref<{ title: string; next?: string } | null>(null);
const notice = ref<string | null>(null);
const workspaces = ref<WorkspaceSummary[]>([]);
const current = computed(() => workspaces.value.find((workspace) => workspace.current) ?? null);
const renameName = ref('');
const renaming = ref(false);
const createName = ref('');
const creating = ref(false);
const busyId = ref('');

function unwrap<T>(value: T | { data?: T }): T {
  return (value as { data?: T })?.data ?? (value as T);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await gainosApi.workspaces();
    workspaces.value = unwrap(data) ?? [];
    renameName.value = current.value?.name ?? '';
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

async function rename(): Promise<void> {
  if (!current.value || !renameName.value.trim()) return;
  renaming.value = true;
  error.value = null;
  notice.value = null;
  try {
    await gainosApi.renameWorkspace(current.value.id, renameName.value.trim());
    notice.value = $t('gainos.workspaces.renamed');
    await load();
  } catch (err) {
    error.value = failureText(err);
  } finally {
    renaming.value = false;
  }
}

async function create(): Promise<void> {
  const name = createName.value.trim();
  if (!name) return;
  creating.value = true;
  error.value = null;
  notice.value = null;
  try {
    const created = unwrap(await gainosApi.createWorkspace(name));
    await gainosApi.switchWorkspace(created.id);
    window.location.assign('/workspace');
  } catch (err) {
    error.value = failureText(err);
    creating.value = false;
  }
}

async function switchTo(workspace: WorkspaceSummary): Promise<void> {
  if (workspace.current) return;
  busyId.value = workspace.id;
  error.value = null;
  notice.value = null;
  try {
    await gainosApi.switchWorkspace(workspace.id);
    window.location.assign('/workspace');
  } catch (err) {
    error.value = failureText(err);
    busyId.value = '';
  }
}

async function leave(workspace: WorkspaceSummary): Promise<void> {
  if (!window.confirm($t('gainos.workspaces.leaveConfirm', { name: workspace.name }))) return;
  busyId.value = workspace.id;
  error.value = null;
  notice.value = null;
  try {
    const result = unwrap(await gainosApi.leaveWorkspace(workspace.id));
    if (result.currentWorkspace) {
      window.location.assign('/auth/login');
      return;
    }
    notice.value = $t('gainos.workspaces.left');
    await load();
  } catch (err) {
    error.value = failureText(err);
  } finally {
    busyId.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="ws">
    <header class="ws__head">
      <div>
        <h1>{{ $t('gainos.workspaces.title') }}</h1>
        <p>{{ $t('gainos.workspaces.subtitle') }}</p>
      </div>
      <button type="button" class="ws__refresh" :disabled="loading" @click="load">{{ $t('gainos.common.refresh') }}</button>
    </header>

    <p v-if="notice" class="ws__notice" role="status">{{ notice }}</p>
    <div v-if="error" class="ws__error" role="alert">
      <strong>{{ error.title }}</strong><span v-if="error.next">{{ error.next }}</span>
    </div>

    <section v-if="current" class="ws__card">
      <h2>{{ $t('gainos.workspaces.currentTitle') }}</h2>
      <p class="ws__muted">{{ $t('gainos.workspaces.currentDesc') }}</p>
      <div class="ws__row">
        <input v-model="renameName" maxlength="128" :aria-label="$t('gainos.workspaces.name')" />
        <button type="button" class="ws__primary" :disabled="renaming || !renameName.trim()" @click="rename">
          {{ renaming ? $t('gainos.common.loading') : $t('gainos.workspaces.rename') }}
        </button>
      </div>
    </section>

    <section class="ws__card">
      <h2>{{ $t('gainos.workspaces.listTitle') }}</h2>
      <p v-if="loading" class="ws__muted">{{ $t('gainos.common.loading') }}</p>
      <table v-else class="ws__table">
        <thead><tr><th>{{ $t('gainos.workspaces.name') }}</th><th>{{ $t('gainos.workspaces.role') }}</th><th>{{ $t('gainos.workspaces.action') }}</th></tr></thead>
        <tbody>
          <tr v-for="workspace in workspaces" :key="workspace.id">
            <td>
              <strong>{{ workspace.name }}</strong>
              <span v-if="workspace.current" class="ws__badge">{{ $t('gainos.workspaces.current') }}</span>
            </td>
            <td>{{ workspace.role === 'admin' ? $t('gainos.workspaces.admin') : $t('gainos.workspaces.member') }}</td>
            <td>
              <button v-if="!workspace.current" type="button" class="ws__secondary" :disabled="busyId === workspace.id" @click="switchTo(workspace)">
                {{ $t('gainos.workspaces.switch') }}
              </button>
              <button type="button" class="ws__danger" :disabled="busyId === workspace.id || workspaces.length <= 1" @click="leave(workspace)">
                {{ $t('gainos.workspaces.leave') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="ws__muted">{{ $t('gainos.workspaces.leaveHint') }}</p>
    </section>

    <section class="ws__card">
      <h2>{{ $t('gainos.workspaces.createTitle') }}</h2>
      <p class="ws__muted">{{ $t('gainos.workspaces.createDesc') }}</p>
      <form class="ws__row" @submit.prevent="create">
        <input v-model="createName" maxlength="128" :placeholder="$t('gainos.workspaces.namePlaceholder')" :aria-label="$t('gainos.workspaces.name')" />
        <button type="submit" class="ws__primary" :disabled="creating || !createName.trim()">
          {{ creating ? $t('gainos.common.loading') : $t('gainos.workspaces.create') }}
        </button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.ws {
  padding: clamp(18px, 2.4vw, 32px) clamp(18px, 2.4vw, 34px) clamp(32px, 4vh, 48px);
  max-width: 1280px; margin: 0 auto; display: grid; gap: 16px;
}
.ws > * { width: 100%; max-width: 860px; justify-self: center; }
.ws__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.ws__head h1 { margin: 0; font-size: 22px; color: var(--gs-fg); }
.ws__head p { margin: 6px 0 0; font-size: 13px; color: var(--gs-fg-muted); line-height: 1.7; max-width: 640px; }
.ws__refresh { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 9px; padding: 7px 14px; font-size: 12.5px; cursor: pointer; color: var(--gs-fg-2); }
.ws__notice { margin: 0; padding: 10px 14px; border-radius: 10px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 13px; font-weight: 600; }
.ws__error { margin: 0; padding: 10px 14px; border-radius: 10px; background: var(--gs-warn-bg); border: 1px solid var(--gs-warn); color: var(--gs-warn); font-size: 13px; display: grid; gap: 2px; }
.ws__card { background: var(--gs-surface); border: 1px solid var(--gs-border); border-radius: 14px; padding: 18px 20px; display: grid; gap: 10px; }
.ws__card h2 { margin: 0; font-size: 15px; font-weight: 650; color: var(--gs-fg); }
.ws__muted { margin: 0; font-size: 12.5px; color: var(--gs-fg-subtle); line-height: 1.7; }
.ws__row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.ws__row input { flex: 1; min-width: 220px; border: 1px solid var(--gs-border-strong); border-radius: 9px; padding: 9px 11px; font-size: 13px; background: var(--gs-surface); color: var(--gs-fg); }
.ws__primary { border: 0; border-radius: 9px; padding: 9px 16px; background: var(--gs-accent); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
.ws__primary:disabled { opacity: .5; cursor: default; }
.ws__secondary { border: 1px solid var(--gs-border-strong); background: var(--gs-surface); border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; color: var(--gs-fg-2); margin-right: 8px; }
.ws__danger { border: 1px solid var(--gs-danger-border); background: var(--gs-surface); border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; color: var(--gs-danger); }
.ws__danger:disabled { opacity: .45; cursor: default; }
.ws__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ws__table th, .ws__table td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--gs-border); vertical-align: middle; }
.ws__table th { color: var(--gs-fg-muted); font-weight: 600; font-size: 12px; }
.ws__table tr:last-child td { border-bottom: 0; }
.ws__badge { margin-left: 8px; border-radius: 999px; padding: 2px 8px; background: var(--gs-accent-soft); color: var(--gs-accent-strong); font-size: 11px; font-weight: 600; }
@media (max-width: 640px) {
  .ws__head { flex-direction: column; }
  .ws__table { display: block; overflow-x: auto; }
}
</style>
