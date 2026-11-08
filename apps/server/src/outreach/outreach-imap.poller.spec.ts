import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachIngestOutcome } from './outreach-ingest.service.js';
import {
  OutreachImapPoller,
  type OutreachImapClient,
  type OutreachImapMessage,
} from './outreach-imap.poller.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface MailboxRow {
  address: string;
  workspaceId: string;
}

class FakePollerPrisma {
  mailboxes: MailboxRow[] = [];
  readonly outreachMailbox = {
    findMany: async () => this.mailboxes.map((row) => ({ ...row })),
  };
}

function client(
  messagesByMailbox: Record<string, OutreachImapMessage[] | Error>,
  seen: Array<{ mailbox: string; uid: number }> = [],
): OutreachImapClient {
  return {
    fetchUnseen: async (mailbox: string) => {
      const value = messagesByMailbox[mailbox];
      if (value instanceof Error) throw value;
      return value ?? [];
    },
    markSeen: async (mailbox: string, uid: number) => {
      seen.push({ mailbox, uid });
    },
  };
}

function poller(
  prisma: FakePollerPrisma,
  imapClient: OutreachImapClient,
  ingestResult: (raw: string) => OutreachIngestOutcome = () => ({
    outcome: 'REPLY',
    replyId: 'r1',
    contactRef: 'c1',
  }),
) {
  const ingest = { ingest: vi.fn(async (_tenant, raw: string) => ingestResult(raw)) };
  const config = { OUTREACH_IMAP_ENABLED: false } as AppConfig;
  return {
    ingest,
    instance: new OutreachImapPoller(
      prisma as unknown as PrismaService,
      ingest as never,
      imapClient,
      config,
    ),
  };
}

describe('OutreachImapPoller（P4-06，配置门控）', () => {
  it('遍历 ACTIVE 信箱：成功 ingest 后标记已读，重复/未匹配分别计数', async () => {
    const prisma = new FakePollerPrisma();
    prisma.mailboxes = [{ address: 'outreach@example.test', workspaceId: WS }];
    const seen: Array<{ mailbox: string; uid: number }> = [];
    const imapClient = client(
      {
        'outreach@example.test': [
          { uid: 1, raw: 'raw-1' },
          { uid: 2, raw: 'raw-2' },
          { uid: 3, raw: 'raw-3' },
        ],
      },
      seen,
    );
    const { instance, ingest } = poller(prisma, imapClient, (raw) =>
      raw === 'raw-2'
        ? { outcome: 'DUPLICATE', externalId: 'x' }
        : raw === 'raw-3'
          ? { outcome: 'UNMATCHED', reason: 'SEND_NOT_FOUND' }
          : { outcome: 'REPLY', replyId: 'r1', contactRef: 'c1' },
    );

    const summary = await instance.pollOnce();

    expect(summary).toEqual({ processed: 1, duplicates: 1, unmatched: 1, errors: 0 });
    expect(ingest.ingest).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([
      { mailbox: 'outreach@example.test', uid: 1 },
      { mailbox: 'outreach@example.test', uid: 2 },
      { mailbox: 'outreach@example.test', uid: 3 },
    ]);
  });

  it('单个信箱取信失败不阻塞其他信箱', async () => {
    const prisma = new FakePollerPrisma();
    prisma.mailboxes = [
      { address: 'bad@example.test', workspaceId: WS },
      { address: 'good@example.test', workspaceId: WS },
    ];
    const imapClient = client({
      'bad@example.test': new Error('IMAP down'),
      'good@example.test': [{ uid: 9, raw: 'raw-9' }],
    });
    const { instance } = poller(prisma, imapClient);

    const summary = await instance.pollOnce();
    expect(summary).toEqual({ processed: 1, duplicates: 0, unmatched: 0, errors: 1 });
  });

  it('单封 ingest 抛错计入 errors 且不标记已读', async () => {
    const prisma = new FakePollerPrisma();
    prisma.mailboxes = [{ address: 'outreach@example.test', workspaceId: WS }];
    const seen: Array<{ mailbox: string; uid: number }> = [];
    const imapClient = client(
      { 'outreach@example.test': [{ uid: 7, raw: 'raw-7' }] },
      seen,
    );
    const ingest = {
      ingest: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const instance = new OutreachImapPoller(
      prisma as unknown as PrismaService,
      ingest as never,
      imapClient,
      { OUTREACH_IMAP_ENABLED: false } as AppConfig,
    );

    const summary = await instance.pollOnce();
    expect(summary.errors).toBe(1);
    expect(seen).toHaveLength(0);
  });
});
