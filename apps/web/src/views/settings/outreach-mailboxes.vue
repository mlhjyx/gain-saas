<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import { gainosApi } from '#/api/gainos';
import SettingsShell from '#/components/gainos/settings-shell.vue';
import { $t } from '#/locales';
import ByoMailboxPanel from '#/views/outreach/ByoMailboxPanel.vue';

defineOptions({ name: 'SettingsOutreachMailboxes' });

const isAdmin = ref(true);

async function loadRole(): Promise<void> {
  try {
    const ctx = await gainosApi.workspaceContext();
    if (ctx?.workspace?.role) {
      isAdmin.value = ctx.workspace.role === 'admin';
      return;
    }
  } catch {
    // fallback to session
  }
  try {
    const session = await gainosApi.session();
    if (session?.workspace?.role) {
      isAdmin.value = session.workspace.role === 'admin';
    }
  } catch {
    // keep default
  }
}

onMounted(() => {
  void loadRole();
});
</script>

<template>
  <SettingsShell
    :subtitle="$t('outreach-byo.pageSubtitle')"
    :title="$t('outreach-byo.pageTitle')"
  >
    <ByoMailboxPanel :is-admin="isAdmin" />
  </SettingsShell>
</template>
