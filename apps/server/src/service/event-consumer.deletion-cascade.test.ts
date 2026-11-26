import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import type { EngineTokenSigner } from './engine-token.signer.js';

const WORKSPACE = '33fe8b32-e417-4355-af91-96fc042d59e0';
const EVENT_ID = '0193632e-8b9a-7c1d-8f00-123456789aaa';
const REQ_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_1 = '33333333-3333-4333-8333-333333333333';
const CONTACT_2 = '44444444-4444-4444-8444-444444444444';
const CONTACT_OTHER = '55555555-5555-4555-8555-555555555555';
const DRAFT_1 = '66666666-6666-4666-8666-666666666666';
const DRAFT_2 = '77777777-7777-4777-8777-777777777777';
const BATCH_1 = '88888888-8888-4888-8888-888888888888';
const CP_1 = '99999999-9999-4999-8999-999999999999';
const BASIS_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QGO_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SAO_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LEAD_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PKG_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const INBOX_LEAD_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function createCascadeHarness(options: {
  drafts?: Array<{ id: string; batchId: string; contactPointId: string | null }>;
  bases?: Array<{ id: string }>;
  auditPackages?: Array<{ id: string; package: unknown }>;
  qgos?: Array<{ id: string; leadRef: string; sao: { id: string } | null }>;
  qualifiedLeads?: Array<{ id: string; leadId: string; snapshot: unknown }>;
  inboxRows?: Array<{ id: string; eventId: string; type: string; payload: unknown }>;
} = {}) {
  const tx = {
    eventInbox: {
      findMany: vi.fn(async () => options.inboxRows ?? []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    notification: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
    qualifiedLead: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => options.qualifiedLeads ?? []),
      deleteMany: vi.fn(async () => ({ count: (options.qualifiedLeads ?? []).length })),
    },
    costLedger: { createMany: vi.fn(async () => ({ count: 0 })) },
    taskRun: { updateMany: vi.fn(async () => ({ count: 0 })) },
    campaignPlanJob: { updateMany: vi.fn(async () => ({ count: 0 })) },
    outreachDraft: {
      findMany: vi.fn(async () => options.drafts ?? []),
      deleteMany: vi.fn(async () => ({ count: (options.drafts ?? []).length })),
    },
    outreachSendJob: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    outreachSend: { deleteMany: vi.fn(async () => ({ count: 2 })) },
    outreachBounceWriteback: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    outreachReply: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    outreachUnsubscribeToken: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    outreachConsent: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    outreachCallBasis: {
      findMany: vi.fn(async () => options.bases ?? []),
      deleteMany: vi.fn(async () => ({ count: (options.bases ?? []).length })),
    },
    outreachCallAttempt: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    outreachExperimentAssignment: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    outreachAuditPackage: {
      findMany: vi.fn(async () => options.auditPackages ?? []),
      update: vi.fn(async () => ({})),
    },
    qgo: {
      findMany: vi.fn(async () => options.qgos ?? []),
      deleteMany: vi.fn(async () => ({ count: (options.qgos ?? []).length })),
    },
    sao: { deleteMany: vi.fn(async () => ({ count: (options.qgos ?? []).filter((q) => q.sao).length })) },
    opportunityOutcome: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    deletionMirror: { upsert: vi.fn(async () => ({})) },
  };

  const prismaObj: Record<string, unknown> = {
    $queryRaw: vi.fn(async () => [{ workspace_id: WORKSPACE, cursor: null }]),
    workspaceRegistry: {
      update: vi.fn(async () => ({})),
    },
    eventInbox: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      createMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  prismaObj.withWorkspace = vi.fn(async (_wid: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({
      ...prismaObj,
      ...tx,
      eventInbox: {
        ...(prismaObj.eventInbox as Record<string, unknown>),
        ...tx.eventInbox,
      },
    }),
  );

  const config = {
    EVENT_CONSUMER_ENABLED: true,
    EVENT_CONSUMER_PAGE_LIMIT: 100,
    ENGINE_ORIGIN: 'http://engine.test',
  } as AppConfig;
  const signer = { mint: vi.fn(async () => 'token') } as unknown as EngineTokenSigner;
  return { service: new EventConsumerService(config, signer, prismaObj as unknown as PrismaService), tx };
}

async function deliverDeletionCompleted(
  service: EventConsumerService,
  payload: Record<string, unknown>,
  aggregateId = REQ_ID,
) {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              event_id: EVENT_ID,
              event_type: 'DeletionCompleted',
              workspace_id: WORKSPACE,
              occurred_at: '2026-11-26T00:00:00.000Z',
              aggregate_id: aggregateId,
              payload,
            },
          ],
          page: { next_cursor: null, has_more: false },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { acked: 1 } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return service.consumeOnce();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EventConsumerService DeletionCompleted GDPR cascade erasure', () => {
  it('erases all contact-keyed outreach PII tables, scrubs audit packages & event_inbox, and writes deletion_mirror for subject_type=contact', async () => {
    const { service, tx } = createCascadeHarness({
      drafts: [{ id: DRAFT_1, batchId: BATCH_1, contactPointId: CP_1 }],
      bases: [{ id: BASIS_1 }],
      auditPackages: [
        {
          id: PKG_1,
          package: {
            schemaVersion: 'outreach-audit-package/v1',
            drafts: [
              {
                draftId: DRAFT_1,
                contactRef: CONTACT_1,
                recipientEmail: 'alice@buyer.example',
                companyName: 'Buyer Corp',
                subject: 'Hi Alice',
                body: 'Personal outreach body',
              },
              {
                draftId: DRAFT_2,
                contactRef: CONTACT_OTHER,
                recipientEmail: 'bob@other.example',
                companyName: 'Other Corp',
                subject: 'Hi Bob',
                body: 'Keep intact',
              },
            ],
          },
        },
      ],
      inboxRows: [
        {
          id: INBOX_LEAD_ID,
          eventId: '0193632e-8b9a-7c1d-8f00-999999999999',
          type: 'LeadQualified',
          payload: { lead_id: LEAD_1, contact_ref: CONTACT_1, email: 'alice@buyer.example' },
        },
      ],
    });

    await deliverDeletionCompleted(service, {
      snapshot_version: 1,
      deletion_request_id: REQ_ID,
      subject_type: 'contact',
      subject_ref: CONTACT_1,
      contacts_erased: 1,
      contact_points_erased: 1,
      field_evidence_erased: 2,
      signals_revoked: 0,
      companies_suppressed: 0,
      leads_rescore_requested: 0,
      rule_version: 'v1',
      erased_at: '2026-11-26T00:00:00.000Z',
    });

    expect(tx.outreachSendJob.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, draftId: { in: [DRAFT_1] } },
    });
    expect(tx.outreachSend.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, draftId: { in: [DRAFT_1] } },
    });
    expect(tx.outreachBounceWriteback.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, contactPointId: { in: [CP_1] } },
    });
    expect(tx.outreachDraft.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, contactRef: { in: [CONTACT_1] } },
    });
    expect(tx.outreachReply.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, contactRef: { in: [CONTACT_1] } },
    });
    expect(tx.outreachUnsubscribeToken.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, contactRef: { in: [CONTACT_1] } },
    });
    expect(tx.outreachConsent.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, contactRef: { in: [CONTACT_1] } },
    });
    expect(tx.outreachCallAttempt.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, basisId: { in: [BASIS_1] } },
    });
    expect(tx.outreachCallBasis.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, contactRef: { in: [CONTACT_1] } },
    });
    expect(tx.outreachExperimentAssignment.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, subjectType: 'contact', subjectRef: { in: [CONTACT_1] } },
    });

    // Audit package scrubbed for CONTACT_1 while preserving CONTACT_OTHER
    expect(tx.outreachAuditPackage.update).toHaveBeenCalledWith({
      where: { id: PKG_1 },
      data: {
        package: expect.objectContaining({
          drafts: [
            expect.objectContaining({
              draftId: DRAFT_1,
              contactRef: CONTACT_1,
              recipientEmail: '[ERASED]',
              companyName: '[ERASED]',
              subject: '[ERASED]',
              body: '[ERASED]',
            }),
            expect.objectContaining({
              draftId: DRAFT_2,
              contactRef: CONTACT_OTHER,
              recipientEmail: 'bob@other.example',
              body: 'Keep intact',
            }),
          ],
        }),
      },
    });

    // event_inbox PII redacted while keeping row for idempotency
    expect(tx.eventInbox.update).toHaveBeenCalledWith({
      where: { id: INBOX_LEAD_ID },
      data: {
        payload: {
          redacted: true,
          reason: 'GDPR_ART17',
          deletionRequestId: REQ_ID,
        },
      },
    });

    // Company-only tables not touched
    expect(tx.qgo.deleteMany).not.toHaveBeenCalled();

    // deletion_mirror recorded with real count > 0
    expect(tx.deletionMirror.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { engineRequestId: REQ_ID },
        create: expect.objectContaining({
          workspaceId: WORKSPACE,
          engineRequestId: REQ_ID,
          status: 'COMPLETED',
          saasDeleted: expect.any(Number),
        }),
      }),
    );
    const upsertArg = tx.deletionMirror.upsert.mock.calls[0]![0] as { create: { saasDeleted: number } };
    expect(upsertArg.create.saasDeleted).toBeGreaterThanOrEqual(10);

    // Notification uses deletion_request_id
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'DeletionCompleted', refId: REQ_ID }),
      }),
    );
  });

  it('cascades company erasure across qgo/sao/outcomes, qualified_lead, account experiments, AND all erased_contact_refs', async () => {
    const { service, tx } = createCascadeHarness({
      drafts: [
        { id: DRAFT_1, batchId: BATCH_1, contactPointId: CP_1 },
        { id: DRAFT_2, batchId: BATCH_1, contactPointId: null },
      ],
      bases: [{ id: BASIS_1 }],
      qgos: [{ id: QGO_1, leadRef: LEAD_1, sao: { id: SAO_1 } }],
      qualifiedLeads: [
        {
          id: 'ql-match-1',
          leadId: LEAD_1,
          snapshot: { company_ref: { canonical_company_id: COMPANY_ID, name: 'Buyer GmbH' } },
        },
        {
          id: 'ql-other',
          leadId: '00000000-0000-4000-8000-000000000099',
          snapshot: { company_ref: { canonical_company_id: '00000000-0000-4000-8000-000000000088', name: 'Other GmbH' } },
        },
      ],
      inboxRows: [
        {
          id: INBOX_LEAD_ID,
          eventId: '0193632e-8b9a-7c1d-8f00-888888888888',
          type: 'LeadQualified',
          payload: {
            lead_id: LEAD_1,
            company_ref: { canonical_company_id: COMPANY_ID, name: 'Buyer GmbH' },
          },
        },
      ],
    });

    await deliverDeletionCompleted(service, {
      snapshot_version: 1,
      deletion_request_id: REQ_ID,
      subject_type: 'company',
      subject_ref: COMPANY_ID,
      erased_contact_refs: [CONTACT_1, CONTACT_2, 'not-a-uuid'],
      contacts_erased: 2,
      contact_points_erased: 3,
      field_evidence_erased: 4,
      signals_revoked: 0,
      companies_suppressed: 1,
      leads_rescore_requested: 1,
      rule_version: 'v1',
      erased_at: '2026-11-26T00:00:00.000Z',
    });

    // Contact cascade uses deduplicated valid UUIDs from erased_contact_refs
    expect(tx.outreachDraft.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, contactRef: { in: [CONTACT_1, CONTACT_2] } },
    });
    expect(tx.outreachSend.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, draftId: { in: [DRAFT_1, DRAFT_2] } },
    });

    // Company QGO -> SAO -> OpportunityOutcome cascade
    expect(tx.opportunityOutcome.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, saoId: { in: [SAO_1] } },
    });
    expect(tx.sao.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, qgoId: { in: [QGO_1] } },
    });
    expect(tx.qgo.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, canonicalCompanyRef: COMPANY_ID },
    });

    // QualifiedLead deletes only the matched company lead, NOT the unrelated lead
    expect(tx.qualifiedLead.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, id: { in: ['ql-match-1'] } },
    });

    // Account experiment assignments erased
    expect(tx.outreachExperimentAssignment.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, subjectType: 'account', subjectRef: COMPANY_ID },
    });

    // Event inbox LeadQualified payload redacted
    expect(tx.eventInbox.update).toHaveBeenCalledWith({
      where: { id: INBOX_LEAD_ID },
      data: {
        payload: {
          redacted: true,
          reason: 'GDPR_ART17',
          deletionRequestId: REQ_ID,
        },
      },
    });

    expect(tx.deletionMirror.upsert).toHaveBeenCalled();
  });
});
