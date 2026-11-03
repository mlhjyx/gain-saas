<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import { $t } from '#/locales';

import { failureText, gainosApi, type ComplianceDeclarationView } from '#/api/gainos';

defineOptions({ name: 'SettingsCompliance' });

const BASIS_KINDS = ['legitimate_interest', 'consent', 'contract', 'legal_obligation'] as const;

const current = ref<ComplianceDeclarationView | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref<{ title: string; next?: string } | null>(null);
const savedVersion = ref<number | null>(null);

const form = ref({
  basis: 'legitimate_interest' as (typeof BASIS_KINDS)[number],
  ref: '',
  note: '',
});

function fmtTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    current.value = (await gainosApi.complianceDeclaration()) ?? null;
    if (current.value) {
      form.value.basis = current.value.basis as (typeof BASIS_KINDS)[number];
      form.value.ref = current.value.ref ?? '';
      form.value.note = current.value.note ?? '';
    }
  } catch (err) {
    error.value = failureText(err);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = null;
  savedVersion.value = null;
  try {
    const res = await gainosApi.declareCompliance({
      basis: form.value.basis,
      ...(form.value.ref.trim() ? { ref: form.value.ref.trim() } : {}),
      ...(form.value.note.trim() ? { note: form.value.note.trim() } : {}),
    });
    current.value = res;
    savedVersion.value = current.value?.version ?? null;
  } catch (err) {
    error.value = failureText(err);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="compliance-page">
    <h2>{{ $t('gainos.compliance.title') }}</h2>
    <p class="intro">{{ $t('gainos.compliance.intro') }}</p>

    <div v-if="loading" class="muted">…</div>
    <div v-else>
      <div v-if="current" class="current-card">
        <div class="row">
          <strong>{{ $t('gainos.compliance.current') }}</strong>
          <span class="tag">{{ $t('gainos.compliance.version') }} v{{ current.version }}</span>
          <span class="muted">{{ fmtTime(current.declaredAt) }}</span>
        </div>
        <div class="row">
          <span>{{ $t('gainos.compliance.basis') }}：{{ $t(`gainos.compliance.basisOptions.${current.basis}`) }}</span>
        </div>
        <div v-if="current.ref" class="row">
          <span>{{ $t('gainos.compliance.ref') }}：{{ current.ref }}</span>
        </div>
        <div v-if="current.note" class="row note">
          <span>{{ current.note }}</span>
        </div>
      </div>
      <div v-else class="empty-card">{{ $t('gainos.compliance.none') }}</div>

      <div class="form-card">
        <label class="field">
          <span>{{ $t('gainos.compliance.basis') }}</span>
          <select v-model="form.basis">
            <option v-for="kind in BASIS_KINDS" :key="kind" :value="kind">
              {{ $t(`gainos.compliance.basisOptions.${kind}`) }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>{{ $t('gainos.compliance.ref') }}</span>
          <input v-model="form.ref" maxlength="500" placeholder="LIA-2026-11" />
        </label>
        <label class="field">
          <span>{{ $t('gainos.compliance.note') }}</span>
          <textarea v-model="form.note" maxlength="4000" rows="5"></textarea>
          <small class="muted">{{ $t('gainos.compliance.noteHint') }}</small>
        </label>
        <div class="actions">
          <button :disabled="saving" @click="save">
            {{ saving ? '…' : $t('gainos.compliance.save') }}
          </button>
          <span v-if="savedVersion" class="ok">{{ $t('gainos.compliance.saved') }} v{{ savedVersion }}</span>
        </div>
      </div>

      <div v-if="error" class="error-card">
        <strong>{{ error.title }}</strong>
        <span v-if="error.next">{{ error.next }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.compliance-page { max-width: 720px; display: flex; flex-direction: column; gap: 16px; }
.intro { color: var(--text-muted, #6b7280); line-height: 1.6; margin: 0; }
.current-card, .empty-card, .form-card, .error-card { border: 1px solid var(--border, #e5e7eb); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.empty-card { color: var(--text-muted, #6b7280); }
.error-card { border-color: #fca5a5; color: #b91c1c; }
.row { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.tag { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: rgba(16,185,129,.12); color: #059669; }
.muted { color: var(--text-muted, #6b7280); font-size: 13px; }
.note { white-space: pre-wrap; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field span { font-size: 13px; color: var(--text-muted, #6b7280); }
select, input, textarea { border: 1px solid var(--border, #e5e7eb); border-radius: 8px; padding: 8px 10px; font: inherit; background: transparent; }
.actions { display: flex; gap: 12px; align-items: center; }
button { border-radius: 8px; padding: 8px 16px; background: #059669; color: #fff; border: 0; cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
.ok { color: #059669; }
</style>
