import type { AppConfig } from '../config/configuration.js';

export const LEGACY_WORKSPACE_QUOTA_ALERT_TYPES = [
  'WorkspaceQuotaWarning',
  'WorkspaceQuotaExceeded',
] as const;

export function legacyWorkspaceQuotaAlertsEnabled(
  config: Pick<AppConfig, 'LEGACY_EXECUTION_BUDGET_MODE' | 'WORKSPACE_QUOTA_ENFORCE'>,
): boolean {
  return config.LEGACY_EXECUTION_BUDGET_MODE === 'enforce' && config.WORKSPACE_QUOTA_ENFORCE;
}
