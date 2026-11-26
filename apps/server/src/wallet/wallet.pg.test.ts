import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from '../ops/attribution-test-pg.js';
import type { OpsDatabase } from '../ops/ops-database.service.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { WalletService } from './wallet.service.js';
import { InsufficientCreditsError } from './wallet.types.js';

const available = dockerAvailable();
if (!available) {
  if (process.env.CI === 'true') {
    throw new Error('[wallet.pg] CI requires docker for PG16 wallet integration tests');
  }
  console.warn('[wallet.pg] docker unavailable, skipping PG16 wallet integration tests');
}

describe.skipIf(!available)('Prepaid Credits Wallet PG16 concurrency, idempotency, RLS & profit reconciliation', () => {
  let pg: DisposablePostgres;
  let adminPrisma: PrismaClient;
  let appPrisma: PrismaService;
  let walletService: WalletService;

  const WS_A = randomUUID();
  const WS_B = randomUUID();
  const OPS_ACTOR = randomUUID();

  beforeAll(async () => {
    pg = startDisposablePostgres();
    adminPrisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
    appPrisma = new PrismaService({ datasourceUrl: pg.appDatabaseUrl, enforcePrincipal: true });
    await appPrisma.verifyPrincipal();

    await adminPrisma.workspace.createMany({
      data: [
        { id: WS_A, name: 'Wallet Tenant A' },
        { id: WS_B, name: 'Wallet Tenant B' },
      ],
    });

    // Mirror engine usage_ledger table inside disposable PG16 for real SQL profit reconciliation test
    await adminPrisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS public.usage_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL,
        cost_usd NUMERIC(18, 6) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const opsDb = {
      db: {
        query: async (sql: string, params: unknown[]) =>
          adminPrisma.$queryRawUnsafe(sql, ...params),
      },
    } as unknown as OpsDatabase;

    const config = {
      WALLET_BILLING_ENABLED: true,
      WALLET_HOLD_TTL_MINUTES: 360,
      WALLET_HOLD_SWEEP_INTERVAL_MS: 600_000,
    } as AppConfig;

    walletService = new WalletService(config, appPrisma, new AuditService(appPrisma), opsDb);
  }, 900_000);

  afterAll(async () => {
    await appPrisma?.onModuleDestroy().catch(() => undefined);
    await adminPrisma?.$disconnect().catch(() => undefined);
    pg?.stop();
  }, 120_000);

  it('prevents concurrent overspending under SELECT ... FOR UPDATE row lock (100 credits, 10x30 parallel holds -> exactly 3 win)', async () => {
    await walletService.topUp(
      WS_A,
      { credits: '100', unitPriceMicros: '10000', externalOrderId: `race-topup-${randomUUID()}` },
      OPS_ACTOR,
    );

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, idx) =>
        walletService.holdCredits(WS_A, {
          idempotencyKey: `race-hold-${idx}-${randomUUID()}`,
          actionCode: 'DISCOVERY_QUALIFIED_LEAD',
          refType: 'discovery_run',
          refId: `race-${idx}`,
          credits: '30',
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    for (const rej of rejected) {
      expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsError);
    }

    const summary = await walletService.getSummary(WS_A);
    expect(summary.account.availableCredits).toBe('10');
    expect(summary.account.heldCredits).toBe('90');

    // Release the 3 winning holds to restore clean state
    for (const f of fulfilled) {
      const val = (f as PromiseFulfilledResult<Awaited<ReturnType<WalletService['holdCredits']>>>).value;
      await walletService.releaseHold(WS_A, val.hold!.id, 'CLEANUP_AFTER_RACE', OPS_ACTOR);
    }
    const restored = await walletService.getSummary(WS_A);
    expect(restored.account.availableCredits).toBe('100');
    expect(restored.account.heldCredits).toBe('0');
  }, 60_000);

  it('enforces priority bonus consumption, partial settlement refund, 0-unit full refund, sweeper, RLS isolation, and profit reconciliation', async () => {
    // Seed WS_B with 100 paid ($0.01/credit) + 40 bonus ($0/credit, priority=1)
    await walletService.topUp(
      WS_B,
      { credits: '100', unitPriceMicros: '10000', externalOrderId: 'wsb-paid-1', note: 'paid order' },
      OPS_ACTOR,
    );
    await walletService.grantBonus(
      WS_B,
      {
        credits: '40',
        sourceType: 'PROMO_BONUS',
        expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        externalOrderId: 'wsb-bonus-1',
        note: 'welcome bonus',
      },
      OPS_ACTOR,
    );

    // 1. Hold 100 credits, settle 6 qualified leads (6 * 10 = 60 credits: 40 bonus + 20 paid => $0.20 revenue; 40 refunded)
    const hold1 = await walletService.holdCredits(WS_B, {
      idempotencyKey: 'wsb-run-1',
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      refType: 'discovery_run',
      refId: 'run-b-1',
      credits: '100',
    });
    const settle1 = await walletService.settleHold(WS_B, {
      holdId: hold1.hold!.id,
      billableUnits: 6,
      note: '6 qualified leads',
    });
    expect(settle1.hold.status).toBe('SETTLED');
    expect(settle1.hold.settledCredits).toBe('60');
    expect(settle1.hold.releasedCredits).toBe('40');
    expect(settle1.account.availableCredits).toBe('80'); // 140 - 60
    expect(settle1.account.heldCredits).toBe('0');
    expect(settle1.account.lifetimeSpent).toBe('60');

    // 2. Zero-output settlement refunds 100%
    const hold2 = await walletService.holdCredits(WS_B, {
      idempotencyKey: 'wsb-verify-invalid',
      actionCode: 'CONTACT_VALID_EMAIL',
      refType: 'contact_verify',
      refId: 'pt-invalid',
    });
    const settleZero = await walletService.settleHold(WS_B, {
      holdId: hold2.hold!.id,
      billableUnits: 0,
      note: 'INVALID email',
    });
    expect(settleZero.hold.status).toBe('RELEASED');
    expect(settleZero.account.availableCredits).toBe('80');

    // 3. Expired zombie hold auto-released by sweeper
    const holdExpired = await walletService.holdCredits(WS_B, {
      idempotencyKey: 'wsb-zombie',
      actionCode: 'CONTACT_VALID_EMAIL',
      refType: 'contact_verify',
      refId: 'pt-zombie',
      ttlMs: -60_000, // already expired
    });
    expect(holdExpired.account.heldCredits).toBe('2');
    const swept = await walletService.sweepExpiredHolds(50);
    expect(swept.released).toBeGreaterThanOrEqual(1);
    const afterSweep = await walletService.getSummary(WS_B);
    expect(afterSweep.account.heldCredits).toBe('0');
    expect(afterSweep.account.availableCredits).toBe('80');

    // 4. Cross-tenant FORCE RLS: WS_A cannot read WS_B wallet rows
    const wsASeesLots = await appPrisma.withWorkspace(WS_A, (tx) =>
      tx.walletCreditLot.findMany({ where: { workspaceId: WS_B } }),
    );
    expect(wsASeesLots).toEqual([]);
    const wsASeesLedger = await appPrisma.withWorkspace(WS_A, (tx) =>
      tx.walletLedger.findMany({ where: { workspaceId: WS_B } }),
    );
    expect(wsASeesLedger).toEqual([]);

    // 5. DB privilege hardening: gain_saas_app cannot DELETE wallet_ledger, cannot UPDATE amount, cannot write billing_price_card
    await expect(
      appPrisma.withWorkspace(WS_B, (tx) => tx.walletLedger.deleteMany({ where: { workspaceId: WS_B } })),
    ).rejects.toThrow(/42501|permission denied/i);
    await expect(
      appPrisma.withWorkspace(WS_B, (tx) =>
        tx.$executeRaw`UPDATE public.wallet_ledger SET delta_available = 999999 WHERE workspace_id = ${WS_B}::uuid`,
      ),
    ).rejects.toThrow(/42501|permission denied/i);
    await expect(
      appPrisma.$executeRaw`INSERT INTO public.billing_price_card (action_code, display_name, pricing_mode, credits_per_unit) VALUES ('HACK', 'Hack', 'FLAT_ACTION', 0)`,
    ).rejects.toThrow(/42501|permission denied/i);

    // 6. Ops Price Card CRUD via audited SECURITY DEFINER RPC works via gain_saas_app
    const newCard = await walletService.opsCreatePriceCard(
      {
        actionCode: 'AI_DEEP_REPORT',
        displayName: 'AI 深度分析报告',
        pricingMode: 'FLAT_ACTION',
        creditsPerUnit: '25',
        defaultHoldUnits: 1,
        active: true,
      },
      OPS_ACTOR,
    );
    expect(newCard.creditsPerUnit).toBe('25');
    const updatedCard = await walletService.opsUpdatePriceCard(
      newCard.id,
      { creditsPerUnit: '30', displayName: 'AI 深度分析（升级）' },
      OPS_ACTOR,
    );
    expect(updatedCard.creditsPerUnit).toBe('30');
    expect(updatedCard.displayName).toBe('AI 深度分析（升级）');

    // 7. Profit reconciliation: WS_B paid revenue = 20 * 10,000 = 200,000 micros ($0.20) vs usage_ledger $0.05 (50,000 micros) => 75% margin
    await adminPrisma.$executeRaw`
      INSERT INTO public.usage_ledger (workspace_id, cost_usd)
      VALUES (${WS_B}::uuid, 0.05)
    `;
    const profit = await walletService.opsProfitReconciliation({
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 3_600_000),
      workspaceId: WS_B,
    });
    expect(profit.engineCostStatus).toBe('ok');
    expect(profit.totals.paidRevenueMicros).toBe('200000');
    expect(profit.totals.engineCostMicros).toBe('50000');
    expect(profit.totals.grossProfitMicros).toBe('150000');
    expect(profit.totals.grossMarginPct).toBe(75);
  }, 60_000);

  it('works identically under a NOSUPERUSER NOBYPASSRLS migration owner role (production parity)', async () => {
    const ownerRole = `mt_m9_owner_${randomUUID().slice(0, 8)}`;
    const ownerPw = `pw-${randomUUID().slice(0, 12)}`;
    const dbName = `mt_m9_db_${randomUUID().slice(0, 8)}`;
    const parsedAdmin = new URL(pg.databaseUrl);
    const parsedApp = new URL(pg.appDatabaseUrl);

    await adminPrisma.$executeRawUnsafe(
      `CREATE ROLE "${ownerRole}" LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${ownerPw}'`,
    );
    await adminPrisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
    await adminPrisma.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${dbName}" TO gain_saas_app`);

    const ownerDbUrl = `postgresql://${ownerRole}:${ownerPw}@${parsedAdmin.hostname}:${parsedAdmin.port || '5432'}/${dbName}`;
    const nonSuperAppUrl = `postgresql://gain_saas_app:${decodeURIComponent(parsedApp.password)}@${parsedApp.hostname}:${parsedApp.port || '5432'}/${dbName}`;

    execFileSync(`${process.cwd()}/node_modules/.bin/prisma`, ['migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: ownerDbUrl },
      stdio: 'pipe',
    });

    const nonSuperApp = new PrismaService({ datasourceUrl: nonSuperAppUrl, enforcePrincipal: true });
    const ownerPrisma = new PrismaClient({ datasourceUrl: ownerDbUrl });
    try {
      await nonSuperApp.verifyPrincipal();
      const wsId = randomUUID();
      await ownerPrisma.workspace.create({ data: { id: wsId, name: 'NonSuper Wallet Co' } });

      const svc = new WalletService(
        { WALLET_BILLING_ENABLED: true, WALLET_HOLD_TTL_MINUTES: 360 } as AppConfig,
        nonSuperApp,
        new AuditService(nonSuperApp),
      );
      await svc.topUp(wsId, { credits: '100', unitPriceMicros: '10000', externalOrderId: 'ns-ord-1' }, OPS_ACTOR);
      const accounts = await svc.opsListAccounts(50, 0);
      expect(accounts.some((a) => a.workspaceId === wsId && a.availableCredits === '100')).toBe(true);

      const card = await svc.opsCreatePriceCard(
        {
          actionCode: 'NONSUPER_TEST_ACTION',
          displayName: '非超管属主校验',
          pricingMode: 'FLAT_ACTION',
          creditsPerUnit: '5',
          defaultHoldUnits: 1,
          active: true,
        },
        OPS_ACTOR,
      );
      expect(card.actionCode).toBe('NONSUPER_TEST_ACTION');

      const held = await svc.holdCredits(wsId, {
        idempotencyKey: 'ns-expired-hold',
        actionCode: 'NONSUPER_TEST_ACTION',
        refType: 'test',
        refId: 't-1',
        ttlMs: -5_000,
      });
      expect(held.account.heldCredits).toBe('5');
      const swept = await svc.sweepExpiredHolds(20);
      expect(swept.released).toBe(1);
    } finally {
      await nonSuperApp.onModuleDestroy().catch(() => undefined);
      await ownerPrisma.$disconnect().catch(() => undefined);
    }
  }, 120_000);
});
