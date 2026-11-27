import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { classifyReplyIntent, parseEmail } from './outreach-email-ingest.js';
import { buildReplyCopilotDraft } from './outreach-reply-copilot.js';
import { OutreachReplyService } from './outreach-reply.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const CONTACT_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const CONTACT_OTHER_CO = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const REPLY_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const tenant: OutreachTenant = {
  userId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  workspaceId: WS,
  role: 'admin',
};

describe('回复副驾升级：异议归类 + 多语种草稿 + 合规门禁', () => {
  it('识别已有供应商/价格异议（英文与中文），归类为 NEUTRAL 且生成二供切入草稿', () => {
    const emailEn = parseEmail(
      [
        'From: buyer@solarnrg.nl',
        'Subject: Re: N-type solar modules',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Thanks, we already have an existing supplier for our modules.',
        '',
        'On Tue, Export Team wrote:',
        '> Click here to unsubscribe.',
      ].join('\r\n'),
    );
    const analyzed = classifyReplyIntent(emailEn);
    expect(analyzed.intent).toBe('OBJECTION_PRICE_OR_SUPPLIER');
    expect(analyzed.classification).toBe('NEUTRAL');

    const draft = buildReplyCopilotDraft({
      replyId: REPLY_ID,
      kind: 'REPLY',
      classification: 'NEUTRAL',
      subject: emailEn.subject,
      snippet: 'Thanks, we already have an existing supplier for our modules.',
      recipientEmail: 'buyer@solarnrg.nl',
      companyName: 'SolarNRG Trading B.V.',
      countryCode: 'NL',
      sellerCompanyName: 'Liansheng Solar',
    });
    expect(draft.sendBlocked).toBe(false);
    expect(draft.recommendedAction).toBe('HANDLE_OBJECTION');
    expect(draft.suggestedBody).toContain('backup supplier');
    expect(draft.suggestedBody).toContain('SolarNRG Trading B.V.');

    const emailZh = parseEmail(
      [
        'From:采购 <buyer@pv-partner.cn>',
        'Subject: Re: 光伏组件合作',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '你们价格偏高，而且我们已有固定供应商了。',
      ].join('\r\n'),
    );
    expect(classifyReplyIntent(emailZh).intent).toBe('OBJECTION_PRICE_OR_SUPPLIER');
  });

  it('转交新联系人自动生成致谢原联系人 + 新联系人破冰双草稿', () => {
    const draft = buildReplyCopilotDraft({
      replyId: REPLY_ID,
      kind: 'REPLY',
      classification: 'POSITIVE',
      subject: 'Re: Photovoltaic modules',
      snippet: 'Please contact our procurement lead anna.schmidt@solarnrg.de directly.',
      recipientEmail: 'info@solarnrg.de',
      companyName: 'SolarNRG GmbH',
      countryCode: 'DE',
      sellerCompanyName: 'GainOS Solar',
    });
    expect(draft.sendBlocked).toBe(false);
    expect(draft.recommendedAction).toBe('FOLLOW_UP_REFERRED_CONTACT');
    expect(draft.referredEmails).toEqual(['anna.schmidt@solarnrg.de']);
    expect(draft.referralIntroDraft).not.toBeNull();
    expect(draft.referralIntroDraft?.to).toBe('anna.schmidt@solarnrg.de');
    expect(draft.referralIntroDraft?.body).toContain('SolarNRG GmbH');
  });

  it('退订/投诉/硬退/明确拒联严格拦截外发草稿（sendBlocked=true）', () => {
    for (const sample of [
      { kind: 'UNSUBSCRIBE' as const, classification: 'UNKNOWN' as const },
      { kind: 'COMPLAINT' as const, classification: 'UNKNOWN' as const },
      { kind: 'BOUNCE' as const, classification: 'UNKNOWN' as const },
      { kind: 'REPLY' as const, classification: 'NEGATIVE' as const },
    ]) {
      const draft = buildReplyCopilotDraft({
        replyId: REPLY_ID,
        ...sample,
        subject: 'Re: Offer',
        snippet: 'Please remove me',
        recipientEmail: 'buyer@example.de',
      });
      expect(draft.sendBlocked).toBe(true);
      expect(draft.recommendedAction).toBe('RESPECT_OPTOUT');
      expect(draft.suggestedBody).toBeNull();
      expect(draft.referralIntroDraft).toBeNull();
    }
  });
});

describe('OutreachReplyService：收到回信自动停同公司待发队列', () => {
  function makeAutoStopPrisma() {
    const drafts = [
      {
        id: 'draft-a-followup',
        workspaceId: WS,
        contactRef: CONTACT_A,
        companyName: 'SolarNRG Trading B.V.',
        recipientEmail: 'ceo@solarnrg.nl',
        status: 'APPROVED',
        rejectionReason: null as string | null,
      },
      {
        id: 'draft-b-sibling',
        workspaceId: WS,
        contactRef: CONTACT_B,
        companyName: '  solarnrg   trading b.v. ',
        recipientEmail: 'buyer@solarnrg.nl',
        status: 'APPROVED',
        rejectionReason: null as string | null,
      },
      {
        id: 'draft-other-co',
        workspaceId: WS,
        contactRef: CONTACT_OTHER_CO,
        companyName: 'Giant Solar Ltd',
        recipientEmail: 'sales@giantsolar.co.uk',
        status: 'APPROVED',
        rejectionReason: null as string | null,
      },
    ];
    const jobs = [
      { id: 'job-a', workspaceId: WS, draftId: 'draft-a-followup', state: 'PENDING', lastError: null as string | null },
      { id: 'job-b', workspaceId: WS, draftId: 'draft-b-sibling', state: 'PENDING', lastError: null as string | null },
      { id: 'job-c', workspaceId: WS, draftId: 'draft-other-co', state: 'PENDING', lastError: null as string | null },
    ];
    const consents: Array<Record<string, unknown>> = [];
    const notifications: Array<Record<string, unknown>> = [];
    const replies: Array<Record<string, unknown>> = [];

    const prisma = {
      withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
      outreachReply: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: REPLY_ID, receivedAt: new Date(), createdAt: new Date(), ...data };
          replies.push(row);
          return row;
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          replies.find((r) => r.id === where.id && r.workspaceId === where.workspaceId) ?? null,
      },
      outreachConsent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          consents.push(data);
          return data;
        },
      },
      outreachDraft: {
        findMany: async () => drafts.filter((d) => d.status === 'DRAFT' || d.status === 'APPROVED'),
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          drafts.find((d) => d.contactRef === where.contactRef) ?? null,
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: { in: string[] }; status: string };
          data: { status: string; rejectionReason: string };
        }) => {
          let count = 0;
          for (const d of drafts) {
            if (where.id.in.includes(d.id) && d.status === where.status) {
              d.status = data.status;
              d.rejectionReason = data.rejectionReason;
              count += 1;
            }
          }
          return { count };
        },
      },
      outreachSendJob: {
        updateMany: async ({
          where,
          data,
        }: {
          where: { draftId: { in: string[] }; state: string };
          data: { state: string; lastError: string };
        }) => {
          let count = 0;
          for (const j of jobs) {
            if (where.draftId.in.includes(j.draftId) && j.state === where.state) {
              j.state = data.state;
              j.lastError = data.lastError;
              count += 1;
            }
          }
          return { count };
        },
      },
      notification: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          notifications.push(data);
          return data;
        },
      },
      workspace: {
        findUnique: async () => ({ name: '琏升科技7股份有限公司' }),
      },
    };
    return { prisma, drafts, jobs, consents, notifications };
  }

  it('正向回信自动取消同联系人与同公司其他人的 PENDING 发信任务，且绝不误拉黑任何人', async () => {
    const { prisma, drafts, jobs, consents, notifications } = makeAutoStopPrisma();
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const svc = new OutreachReplyService(prisma as unknown as PrismaService, audit);

    await svc.record(tenant, {
      contactRef: CONTACT_A,
      recipientEmail: 'ceo@solarnrg.nl',
      kind: 'REPLY',
      classification: 'POSITIVE',
      subject: 'Re: Modules',
      snippet: 'Please send datasheet and pricing.',
      companyName: 'SolarNRG Trading B.V.',
    });

    // 正向回复不写 OPT_OUT
    expect(consents).toHaveLength(0);
    // 同公司两人（A 和 B）的 PENDING job 全部 CANCELLED，其他公司（C）不受影响
    expect(jobs.find((j) => j.id === 'job-a')?.state).toBe('CANCELLED');
    expect(jobs.find((j) => j.id === 'job-b')?.state).toBe('CANCELLED');
    expect(jobs.find((j) => j.id === 'job-c')?.state).toBe('PENDING');
    // 同公司同事 B 的未发草稿被标记为 SKIPPED，避免下一轮 worker 误发
    expect(drafts.find((d) => d.id === 'draft-b-sibling')?.status).toBe('SKIPPED');
    expect(drafts.find((d) => d.id === 'draft-other-co')?.status).toBe('APPROVED');
    // 发出租户提醒通知
    expect(notifications.some((n) => n.type === 'outreach.reply.company_auto_stopped')).toBe(true);

    // 紧接调用回复副驾接口拿到针对性草稿
    const copilot = await svc.getCopilotDraft(tenant, REPLY_ID);
    expect(copilot.recommendedAction).toBe('SEND_DATASHEET_AND_QUOTE');
    expect(copilot.suggestedBody).toContain('琏升科技7股份有限公司');
  });

  it('休假自动回复（OUT_OF_OFFICE）不触发同公司自动停发', async () => {
    const { prisma, jobs, drafts } = makeAutoStopPrisma();
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const svc = new OutreachReplyService(prisma as unknown as PrismaService, audit);

    await svc.record(tenant, {
      contactRef: CONTACT_A,
      recipientEmail: 'ceo@solarnrg.nl',
      kind: 'REPLY',
      classification: 'OUT_OF_OFFICE',
      subject: 'Out of Office',
      snippet: 'Back next Monday.',
      companyName: 'SolarNRG Trading B.V.',
    });

    expect(jobs.every((j) => j.state === 'PENDING')).toBe(true);
    expect(drafts.every((d) => d.status === 'APPROVED')).toBe(true);
  });
});
