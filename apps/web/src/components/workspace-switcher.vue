<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import { Select } from 'ant-design-vue';

import { gainosApi, type WorkspaceSummary } from '#/api/gainos';

/**
 * 头部工作空间切换器（SD2/SD11）：把切换从设置页提到一级可见位置。
 * 切换成功后整页刷新——所有数据、守卫与文件状态都以 workspace 为边界。
 */
defineOptions({ name: 'WorkspaceSwitcher' });

const workspaces = ref<WorkspaceSummary[]>([]);
const current = ref<string | undefined>(undefined);
const switching = ref(false);

async function load() {
  try {
    const rows = await gainosApi.workspaces();
    workspaces.value = rows ?? [];
    current.value = rows?.find((workspace) => workspace.current)?.id;
  } catch {
    // 会话切换/未登录期间静默失败，不打扰主界面。
  }
}

async function onChange(value: unknown) {
  const workspaceId = String(value ?? '');
  if (!workspaceId || workspaceId === current.value) return;
  switching.value = true;
  try {
    await gainosApi.switchWorkspace(workspaceId);
    window.location.assign('/workspace');
  } catch {
    switching.value = false;
  }
}

onMounted(load);
</script>

<template>
  <Select
    v-if="workspaces.length > 1"
    :loading="switching"
    :options="workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))"
    :value="current"
    class="workspace-switcher"
    popup-match-select-width
    size="small"
    @change="onChange"
  />
</template>

<style scoped>
.workspace-switcher {
  min-width: 140px;
  max-width: 220px;
}
</style>
