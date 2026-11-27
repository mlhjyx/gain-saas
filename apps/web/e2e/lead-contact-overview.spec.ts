import { expect, test } from '@playwright/test';

import { errorPayload, installMockBackend, loginAs } from './support/mock-backend';

const LEAD = '/leads/lead-contact-overview';
const COMPANY = '/canonical-companies/contact-company';
const NOW = '2026-11-27T10:00:00.000Z';
const COMPANY_NAME = 'Nordwerk Industrial Pumps';
const DOMAIN = 'nordwerk.example';
const PROFILE = 'https://www.linkedin.com/in/mira-hofmann';
const EMAIL = `buyer@${DOMAIN}`;
const PHONE = '+39 02 9988 7766';
const DESCRIPTION = 'Distributes pumps and fluid handling equipment for manufacturers.';

const leadPackage = {
  company: {
    canonical_company_id: 'contact-company',
    city: 'Milan',
    country: 'IT',
    domain: DOMAIN,
    name: COMPANY_NAME,
  },
  company_channels: [{ channel: 'email', value: `sales@${DOMAIN}` }],
  lead_id: 'lead-contact-overview',
  sanctions: { screened_at: NOW, status: 'clear' },
  social_profiles: [
    { platform: 'whatsapp', url: 'https://wa.me/39029988766' },
    { platform: 'facebook', source: 'structured_org', url: 'https://www.facebook.com/nordwerk-pumps' },
    { platform: 'x', url: 'https://x.com/nordwerk_pumps' },
  ],
  status: 'REVIEW',
};

const companyOverview = {
  description: DESCRIPTION,
  main_business: ['Industrial pumps', 'Fluid handling', 'Spare parts', 'Installation'],
  official_website: `https://${DOMAIN}/`,
  sources: [
    { fetched_at: NOW, field: 'description', source_url: `https://${DOMAIN}/about` },
    { fetched_at: null, field: 'main_business', source_url: `https://${DOMAIN}/products` },
    { fetched_at: null, field: 'website', source_url: 'javascript:alert(1)' },
    { fetched_at: null, field: 'location', source_url: `https://hidden:value@${DOMAIN}/address` },
  ],
};

const canonicalCompany = {
  company: {
    contacts: [
      {
        contactPoints: [
          { id: 'profile', status: 'UNVERIFIED', type: 'linkedin', value: PROFILE },
          { id: 'email', status: 'VALID', type: 'email', value: EMAIL, verifiedAt: NOW },
          { id: 'phone', status: 'VALID', type: 'phone', value: PHONE, verifiedAt: NOW },
          { id: 'other-phone', status: 'BLOCKED', type: 'phone', value: '+39 02 9988 7788' },
        ],
        department: 'Procurement',
        fullName: 'Mira Hofmann',
        id: 'mira',
        title: 'Purchasing Manager',
      },
    ],
    id: leadPackage.company.canonical_company_id,
    name: COMPANY_NAME,
  },
  evidence: [
    {
      allowedActions: ['display', 'outreach'],
      entityId: 'mira',
      field: 'email',
      fetchedAt: NOW,
      license: 'public',
      sourceUrl: `https://${DOMAIN}/team`,
      value: { email: EMAIL },
    },
    {
      allowedActions: ['match'],
      entityId: 'mira',
      field: 'person.profile',
      license: 'public',
      sourceUrl: `https://${DOMAIN}/restricted-source`,
    },
  ],
};

test('联系人和所属公司并排，分开查看个人和企业渠道与可用来源', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', `${LEAD}/package`, { ...leadPackage, company_overview: companyOverview });
  backend.set('GET', COMPANY, canonicalCompany);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await loginAs(page);
  await page.goto(`${LEAD}?tab=people&icp=profile-pumps&queue=recommended`);

  await expect(page.getByRole('heading', { level: 1, name: '联系人与联系方式' })).toBeVisible();
  const person = page.locator('[data-gs="lead-contact-identity"]');
  const company = page.locator('[data-gs="lead-contact-company"]');
  await expect(person.getByRole('heading', { name: 'Mira Hofmann' })).toBeVisible();
  await expect(person).toContainText('Purchasing Manager');
  await expect(company.getByRole('heading', { name: COMPANY_NAME })).toBeVisible();
  await expect(company).toContainText(DESCRIPTION);
  await expect(company).toContainText('意大利');
  await expect(company).toContainText('Milan（注册地）');
  await expect(company).toContainText('Spare parts');
  await expect(company.getByText('Installation', { exact: true })).toBeHidden();
  await expect(company.getByRole('link', { name: DOMAIN })).toHaveAttribute('href', `https://${DOMAIN}/`);
  expect((await company.boundingBox())!.x).toBeGreaterThan((await person.boundingBox())!.x);

  await company.getByRole('button', { name: '资料与来源' }).click();
  await expect(company.getByText('Installation', { exact: true })).toBeVisible();
  await expect(company.getByRole('link', { name: `https://${DOMAIN}/about` })).toHaveAttribute('rel', /noreferrer/);
  await expect(company.getByRole('link', { name: `https://${DOMAIN}/products` })).toBeVisible();
  await expect(company.locator('a[href^="javascript:"], a[href*="hidden:value"]')).toHaveCount(0);

  const individual = page.locator('[data-gs="person-contact-channels"]');
  const profile = individual.locator('[data-channel="linkedin"]');
  await person.getByRole('button', { name: /查看.*LinkedIn.*渠道/ }).click();
  await expect(profile).toBeFocused();
  await expect(profile.getByText(PROFILE, { exact: true })).toBeVisible();
  await expect(profile.getByRole('link', { name: '打开渠道' })).toHaveAttribute('href', PROFILE);
  await expect(individual.locator('[data-channel="email"]').getByRole('button', { name: '写邮件' })).toBeVisible();
  await expect(individual.locator('[data-channel="email"] a[href^="https:"]')).toHaveAttribute('href', `https://${DOMAIN}/team`);
  await expect(individual.locator('[data-channel="phone"]').getByRole('link', { name: '拨打电话' })).toHaveAttribute('href', 'tel:+390299887766');
  await expect(individual.locator('[data-channel="phone"]').getByRole('button', { name: '复制', exact: true })).toHaveCount(1);
  await expect(individual).toContainText('已拦截');
  await expect(page.locator('a[href$="/restricted-source"]')).toHaveCount(0);
  await profile.getByRole('button', { name: '复制', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROFILE);

  const publicChannels = page.locator('[data-gs="people-public-channels"]');
  await expect(publicChannels.locator('[data-channel="facebook"]')).toContainText('https://www.facebook.com/nordwerk-pumps');
  await expect(publicChannels.locator('[data-channel="facebook"]')).toContainText('企业官网');
  await expect(individual.locator('[data-channel="facebook"]')).toHaveCount(0);
  await person.getByRole('button', { name: '查看企业的 WhatsApp' }).click();
  await expect(publicChannels.locator('[data-channel="whatsapp"]')).toBeFocused();
  await expect(page.locator('[data-gs="contacts-enrich"]')).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  expect((await company.boundingBox())!.y).toBeGreaterThan((await person.boundingBox())!.y);
  expect(await page.getByRole('main').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(backend.calls.filter((call) => call.method === 'POST' && call.path.startsWith(COMPANY))).toHaveLength(0);
  expect(backend.callsTo('POST', '/outreach/t0/check')).toHaveLength(0);

  await page.getByRole('button', { name: '返回线索' }).click();
  await page.waitForURL((url) => url.searchParams.get('tab') === 'package');
  await expect(page.getByRole('heading', { level: 1, name: COMPANY_NAME })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('icp')).toBe('profile-pumps');
  expect(new URL(page.url()).searchParams.get('queue')).toBe('recommended');
});

test('普通成员能查看旧线索的企业公开资料，个人接口和未核实的官网链接均不出现', async ({ page }) => {
  const backend = await installMockBackend(page, { role: 'member' });
  backend.set('GET', `${LEAD}/package`, {
    ...leadPackage,
    company: { ...leadPackage.company, city: null, country: 'DE' },
  });
  backend.set('GET', COMPANY, canonicalCompany);
  await loginAs(page);
  await page.goto(`${LEAD}?tab=people`);

  const company = page.locator('[data-gs="lead-contact-company"]');
  await expect(company.getByRole('heading', { name: COMPANY_NAME })).toBeVisible();
  await expect(company).toContainText('暂无有来源的公司简介');
  await expect(company).toContainText('德国');
  await expect(company).toContainText(DOMAIN);
  await expect(company.getByRole('link', { name: DOMAIN })).toHaveCount(0);
  await expect(company.getByRole('button', { name: '资料与来源' })).toHaveCount(0);
  const publicChannels = page.locator('[data-gs="people-public-channels"]');
  await expect(publicChannels).toContainText(`sales@${DOMAIN}`);
  await expect(publicChannels.locator('[data-channel="email"]').getByRole('link', { name: '写邮件' })).toHaveCount(0);
  await expect(page.getByText('Mira Hofmann')).toHaveCount(0);
  await expect(page.locator('[data-gs="decision-makers-admin-only"]')).toBeVisible();
  expect(backend.callsTo('GET', COMPANY)).toHaveLength(0);
});

test('个人联系人读取失败时先看企业资料，可在原页重试', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', `${LEAD}/package`, { ...leadPackage, company_overview: companyOverview });
  backend.set('GET', COMPANY, async ({ route }) => {
    await route.fulfill({
      json: errorPayload('UPSTREAM_UNAVAILABLE', { title: '暂时无法读取联系人' }),
      status: 502,
    });
    return true;
  });
  await loginAs(page);
  await page.goto(`${LEAD}?tab=people`);

  const company = page.locator('[data-gs="lead-contact-company"]');
  const error = page.locator('[data-gs="decision-makers-error"]');
  await expect(error).toContainText('暂时无法读取联系人');
  await expect(company).toContainText(DESCRIPTION);
  await company.getByRole('button', { name: '资料与来源' }).click();
  await expect(company.getByRole('link', { name: `https://${DOMAIN}/about` })).toBeVisible();

  backend.set('GET', COMPANY, canonicalCompany);
  await error.getByRole('button', { name: '刷新' }).click();
  await expect(page.getByRole('heading', { name: 'Mira Hofmann' })).toBeVisible();
  await expect(company.getByRole('link', { name: `https://${DOMAIN}/about` })).toBeVisible();
  expect(backend.calls.filter((call) => call.method === 'GET' && call.path === COMPANY)).toHaveLength(2);
});

test('具名邮箱被服务端禁联时，写邮件按目标核验而不打开本地客户端', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', `${LEAD}/package`, { ...leadPackage, company_overview: companyOverview });
  backend.set('GET', COMPANY, canonicalCompany);
  backend.set('POST', '/outreach/t0/check', {
    blockCode: 'SUPPRESSED',
    blockedAll: true,
    channels: { mailto: { allowed: false, reasonCode: 'SUPPRESSED' } },
  });
  await loginAs(page);
  await page.goto(`${LEAD}?tab=people`);

  const email = page.locator('[data-gs="person-contact-channels"] [data-channel="email"]');
  const compose = email.getByRole('button', { name: '写邮件' });
  await expect(compose).toBeVisible();
  expect(backend.callsTo('POST', '/outreach/t0/check')).toHaveLength(0);

  await compose.click();
  await expect(page.getByText(/该线索或收件邮箱位于禁联名单/)).toBeVisible();
  const checks = backend.callsTo('POST', '/outreach/t0/check');
  expect(checks).toHaveLength(1);
  expect(checks[0]?.body).toMatchObject({
    contactRef: 'mira',
    email: EMAIL,
    leadId: leadPackage.lead_id,
  });
  await expect(email.locator('a[href^="mailto:"]')).toHaveCount(0);
});

test('合规待核时保留企业资料，隐藏联系渠道和补强入口', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', `${LEAD}/package`, {
    ...leadPackage,
    company_overview: { ...companyOverview, official_website: 'javascript:alert(1)' },
    sanctions: { screened_at: NOW, status: 'potential_match' },
  });
  backend.set('GET', COMPANY, canonicalCompany);
  await loginAs(page);
  await page.goto(`${LEAD}?tab=people`);

  const company = page.locator('[data-gs="lead-contact-company"]');
  await expect(company).toContainText(DESCRIPTION);
  await expect(company).toContainText(DOMAIN);
  await expect(company.getByRole('link', { name: DOMAIN })).toHaveCount(0);
  await expect(page.locator('[data-gs="people-public-channels"]')).not.toContainText(`sales@${DOMAIN}`);
  await expect(page.locator('[data-gs="contacts-enrich"], [data-gs="contacts-discover"]')).toHaveCount(0);
  expect(backend.callsTo('GET', COMPANY)).toHaveLength(0);
});
