import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from '../ops/attribution-test-pg.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { EngineTokenSigner } from './engine-token.signer.js';
import { EventConsumerService } from './event-consumer.service.js';

const available = dockerAvailable();

describe.skipIf(!available)('EventConsumerService DeletionCompleted PG16 RLS cascade', () => {
  let pg: DisposablePostgres;
  let adminPrisma: PrismaClient;
  let appPrisma: PrismaService;

  const WS_A = randomUUID();
  const WS_B = randomUUID();

  beforeAll(async () => {
    pg = startDisposablePostgres();
    adminPrisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
    appPrisma = new PrismaService({ datasourceUrl: pg.appDatabaseUrl, enforcePrincipal: true });
    await appPrisma.verifyPrincipal();
  }, 900_000);

  afterAll(async () => {
    await appPrisma?.onModuleDestroy().catch(() => undefined);
    await adminPrisma?.$disconnect().catch(() => undefined);
    pg?.stop();
  }, 120_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('erases all gain_saas PII for company + erased_contact_refs in WS_A under gain_saas_app RLS without affecting WS_B', async () => {
    const userId = randomUUID();
    const companyA = randomUUID();
    const contactA = randomUUID();
    const companyB = randomUUID();
    const contactB = randomUUID();
    const leadA = randomUUID();
    const leadB = randomUUID();
    const cpA = randomUUID();
    const cpB = randomUUID();
    const reqId = randomUUID();
    const eventId = randomUUID();
    const leadEventIdA = randomUUID();
    const leadEventIdB = randomUUID();

    await adminPrisma.workspace.createMany({
      data: [
        { id: WS_A, name: 'DSR Tenant A' },
        { id: WS_B, name: 'DSR Tenant B' },
      ],
    });
    await adminPrisma.workspaceRegistry.createMany({
      data: [
        { workspaceId: WS_A, enabled: true },
        { workspaceId: WS_B, enabled: false },
      ],
    });

    const seedTenant = async (
      wsId: string,
      companyRef: string,
      contactRef: string,
      leadRef: string,
      cpId: string,
      email: string,
      leadEvId: string,
    ) => {
      const batch = await adminPrisma.outreachBatch.create({
        data: { workspaceId: wsId, name: 'Batch 1', createdBy: userId },
      });
      const draft = await adminPrisma.outreachDraft.create({
        data: {
          workspaceId: wsId,
          batchId: batch.id,
          contactRef,
          contactPointId: cpId,
          recipientEmail: email,
          companyName: 'Target Co',
          subject: `Hello ${email}`,
          body: `Secret body for ${email}`,
        },
      });
      await adminPrisma.outreachSend.create({
        data: {
          workspaceId: wsId,
          batchId: batch.id,
          draftId: draft.id,
          attempt: 1,
          recipientEmail: email,
          subjectHash: 'a'.repeat(64),
          bodyHash: 'b'.repeat(64),
          mailboxAddress: 'sender@acme.example',
        },
      });
      await adminPrisma.outreachSendJob.create({
        data: {
          workspaceId: wsId,
          batchId: batch.id,
          draftId: draft.id,
          idempotencyKey: `job-${draft.id}`,
        },
      });
      await adminPrisma.outreachBounceWriteback.create({
        data: {
          workspaceId: wsId,
          contactPointId: cpId,
          event: 'hard_bounce',
          messageId: `msg-${draft.id}`,
        },
      });
      await adminPrisma.outreachReply.create({
        data: {
          workspaceId: wsId,
          contactRef,
          recipientEmail: email,
          subject: 'Re: Hello',
          snippet: `Reply from ${email}`,
        },
      });
      await adminPrisma.outreachUnsubscribeToken.create({
        data: {
          workspaceId: wsId,
          contactRef,
          recipientEmail: email,
          tokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await adminPrisma.outreachConsent.create({
        data: {
          workspaceId: wsId,
          contactRef,
          status: 'OPT_IN',
          source: 'manual',
          lawfulBasis: 'legitimate_interest',
        },
      });
      const basis = await adminPrisma.outreachCallBasis.create({
        data: {
          workspaceId: wsId,
          contactRef,
          phoneE164: '+4915112345678',
          companyName: 'Target Co',
          triggerType: 'fair_visit',
          triggerEvidence: { booth: 'A1' },
          relevanceStatement: 'Direct buyer of industrial valves in Germany.',
          collectedSourceUrl: 'https://example.com',
          collectedAt: new Date('2026-11-01'),
          scriptTemplateId: randomUUID(),
          legalReviewId: randomUUID(),
          reviewedBy: 'owner',
          reviewedAt: new Date('2026-11-02'),
          validUntil: new Date('2027-01-01'),
          createdBy: userId,
        },
      });
      await adminPrisma.outreachCallAttempt.create({
        data: {
          workspaceId: wsId,
          basisId: basis.id,
          attemptNo: 1,
          startedAt: new Date(),
          outcome: 'NO_ANSWER',
          createdBy: userId,
        },
      });
      const exp = await adminPrisma.outreachExperiment.create({
        data: {
          workspaceId: wsId,
          name: 'Exp 1',
          hypothesis: 'H1',
          primaryMetric: 'reply_rate',
          assignmentSalt: 'c'.repeat(64),
          createdBy: userId,
        },
      });
      await adminPrisma.outreachExperimentAssignment.createMany({
        data: [
          { workspaceId: wsId, experimentId: exp.id, subjectType: 'contact', subjectRef: contactRef, arm: 'holdout', bucket: 10 },
          { workspaceId: wsId, experimentId: exp.id, subjectType: 'account', subjectRef: companyRef, arm: 'holdout', bucket: 11 },
        ],
      });
      await adminPrisma.outreachAuditPackage.create({
        data: {
          workspaceId: wsId,
          batchId: batch.id,
          contentHash: 'd'.repeat(64),
          packageHash: 'e'.repeat(64),
          createdBy: userId,
          package: {
            schemaVersion: 'outreach-audit-package/v1',
            drafts: [
              {
                draftId: draft.id,
                contactRef,
                recipientEmail: email,
                companyName: 'Target Co',
                subject: `Hello ${email}`,
                body: `Secret body for ${email}`,
              },
            ],
          },
        },
      });
      const qgo = await adminPrisma.qgo.create({
        data: {
          workspaceId: wsId,
          leadRef,
          canonicalCompanyRef: companyRef,
          title: 'Target Co Opportunity',
          evidence: [{ kind: 'fit' }],
          nextStep: 'Call buyer',
          createdBy: userId,
        },
      });
      const sao = await adminPrisma.sao.create({
        data: {
          workspaceId: wsId,
          qgoId: qgo.id,
          state: 'ACCEPTED',
          decidedBy: userId,
          decidedAt: new Date(),
        },
      });
      await adminPrisma.opportunityOutcome.create({
        data: {
          workspaceId: wsId,
          saoId: sao.id,
          outcome: 'REPLIED',
          occurredAt: new Date(),
          source: 'MANUAL',
          createdBy: userId,
        },
      });
      await adminPrisma.qualifiedLead.create({
        data: {
          workspaceId: wsId,
          eventId: leadEvId,
          leadId: leadRef,
          snapshot: { company_ref: { canonical_company_id: companyRef, name: 'Target Co' } },
        },
      });
      await adminPrisma.eventInbox.create({
        data: {
          workspaceId: wsId,
          eventId: leadEvId,
          type: 'LeadQualified',
          occurredAt: new Date(),
          projectionStatus: 'APPLIED',
          payload: {
            lead_id: leadRef,
            company_ref: { canonical_company_id: companyRef, name: 'Target Co' },
            contact_email: email,
          },
        },
      });
    };

    await seedTenant(WS_A, companyA, contactA, leadA, cpA, 'alice@target-a.example', leadEventIdA);
    await seedTenant(WS_B, companyB, contactB, leadB, cpB, 'bob@target-b.example', leadEventIdB);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                event_id: eventId,
                event_type: 'DeletionCompleted',
                workspace_id: WS_A,
                occurred_at: new Date().toISOString(),
                aggregate_id: reqId,
                payload: {
                  snapshot_version: 1,
                  deletion_request_id: reqId,
                  subject_type: 'company',
                  subject_ref: companyA,
                  erased_contact_refs: [contactA],
                  contacts_erased: 1,
                  contact_points_erased: 1,
                  field_evidence_erased: 1,
                  signals_revoked: 0,
                  companies_suppressed: 1,
                  leads_rescore_requested: 1,
                  rule_version: 'v1',
                  erased_at: new Date().toISOString(),
                },
              },
            ],
            page: { next_cursor: null, has_more: false },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { acked: 1 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const consumer = new EventConsumerService(
      {
        EVENT_CONSUMER_ENABLED: true,
        EVENT_CONSUMER_PAGE_LIMIT: 100,
        ENGINE_ORIGIN: 'http://engine.test',
        WORKSPACE_QUOTA_ENFORCE: false,
      } as AppConfig,
      { mint: vi.fn(async () => 'token') } as unknown as EngineTokenSigner,
      appPrisma,
    );

    const res = await consumer.consumeOnce();
    expect(res).toEqual({ workspaces: 1, pulled: 1, acked: 1 });

    // WS_A: all PII tables erased/scrubbed
    expect(await adminPrisma.outreachDraft.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachSend.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachSendJob.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachBounceWriteback.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachReply.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachUnsubscribeToken.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachConsent.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachCallBasis.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachCallAttempt.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.outreachExperimentAssignment.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.qgo.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.sao.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.opportunityOutcome.count({ where: { workspaceId: WS_A } })).toBe(0);
    expect(await adminPrisma.qualifiedLead.count({ where: { workspaceId: WS_A } })).toBe(0);

    const pkgA = await adminPrisma.outreachAuditPackage.findFirst({ where: { workspaceId: WS_A } });
    expect(JSON.stringify(pkgA?.package)).not.toContain('alice@target-a.example');
    expect(JSON.stringify(pkgA?.package)).toContain('[ERASED]');

    const inboxA = await adminPrisma.eventInbox.findUnique({ where: { eventId: leadEventIdA } });
    expect(inboxA?.payload).toEqual({ redacted: true, reason: 'GDPR_ART17', deletionRequestId: reqId });

    const mirror = await adminPrisma.deletionMirror.findUnique({ where: { engineRequestId: reqId } });
    expect(mirror).toMatchObject({ workspaceId: WS_A, status: 'COMPLETED' });
    expect(mirror!.saasDeleted).toBeGreaterThanOrEqual(15);

    // WS_B: completely untouched
    expect(await adminPrisma.outreachDraft.count({ where: { workspaceId: WS_B } })).toBe(1);
    expect(await adminPrisma.outreachSend.count({ where: { workspaceId: WS_B } })).toBe(1);
    expect(await adminPrisma.qgo.count({ where: { workspaceId: WS_B } })).toBe(1);
    expect(await adminPrisma.qualifiedLead.count({ where: { workspaceId: WS_B } })).toBe(1);
    const pkgB = await adminPrisma.outreachAuditPackage.findFirst({ where: { workspaceId: WS_B } });
    expect(JSON.stringify(pkgB?.package)).toContain('bob@target-b.example');
    const inboxB = await adminPrisma.eventInbox.findUnique({ where: { eventId: leadEventIdB } });
    expect(JSON.stringify(inboxB?.payload)).toContain('bob@target-b.example');
  }, 120_000);
});
