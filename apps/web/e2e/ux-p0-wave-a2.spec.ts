import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-26T08:00:00.000Z';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const CANONICAL_ID = '44444444-4444-4444-8444-444444444444';

function resolveOrigin(baseURL?: string): string {
  return new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
}

test('F5 reload syncs accessCodes when an admin is downgraded to member (Review Focus #5)', async ({
  page,
  baseURL,
}) => {
  const origin = resolveOrigin(baseURL);
  const backend = await installMockBackend(page, { origin, role: 'admin' });

  let currentRole: 'admin' | 'member' = 'admin';
  backend.set('GET', '/workspace/context', async ({ route }) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          user: backend.session.user,
          workspace: { ...backend.session.workspaces[0], role: currentRole },
          onboarding: { complete: true, companyId: null },
          allowedActions:
            currentRole === 'admin'
              ? ['workspace.rename', 'campaigns.view', 'campaigns.draft', 'outreach.view', 'outreach.draft']
              : ['workspace.leave', 'acquisition.run', 'leads.review', 'qgo.manage', 't0.outreach', 'campaigns.view', 'outreach.view'],
        },
      }),
    });
    return true;
  });

  backend.set('GET', `/leads/${LEAD_ID}/package`, {
    lead_id: LEAD_ID,
    status: 'QUALIFIED',
    company: {
      canonical_company_id: CANONICAL_ID,
      name: 'Nordic Pump GmbH',
      domain: 'nordicpump.de',
      country: 'DE',
    },
    company_channels: [],
    social_profiles: [],
    scores: { total: 0.85 },
    fit: { verdict: 'MATCH', reasons: ['工业泵分销商'] },
    evidence: [],
    sanctions: { status: 'CLEAR', screened_at: NOW },
  });
  backend.set('GET', `/canonical-companies/${CANONICAL_ID}`, {
    company: {
      id: CANONICAL_ID,
      name: 'Nordic Pump GmbH',
      domain: 'nordicpump.de',
      country: 'DE',
      contacts: [],
    },
    evidence: [],
  });

  // 1. Sign in as admin: accessStore persists accessCodes = ['ADMIN'].
  await loginAs(page);
  await page.goto(`/leads/${LEAD_ID}?tab=people`);
  await expect(page.getByText('Nordic Pump GmbH')).toBeVisible();
  await expect(page.getByText('联系人信息仅管理员可见')).toHaveCount(0);

  // 2. Downgrade role to member on the server while keeping persisted browser storage, then F5 reload.
  currentRole = 'member';
  backend.session.workspace.role = 'member';
  backend.session.workspaces[0]!.role = 'member';

  await page.reload();

  // 3. Persisted stale ['ADMIN'] accessCode must be cleared on reload -> member sees admin-only notice.
  await expect(page.getByText('联系人信息仅管理员可见')).toBeVisible({ timeout: 10_000 });
});
