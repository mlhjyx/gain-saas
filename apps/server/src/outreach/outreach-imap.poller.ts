import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OutreachIngestService } from './outreach-ingest.service.js';

export const OUTREACH_IMAP_CLIENT = Symbol('OUTREACH_IMAP_CLIENT');

export interface OutreachImapMessage {
  uid: number;
  raw: string;
}

/**
 * 极窄的 IMAP 客户端接口：只为「取未读 + 标记已读」。测试注入 fake，
 * 生产实现 ImapFlowClient 惰性加载 imapflow（未安装时给出明确错误，不影响其他功能）。
 */
export interface OutreachImapClient {
  fetchUnseen(mailbox: string): Promise<OutreachImapMessage[]>;
  markSeen(mailbox: string, uid: number): Promise<void>;
}

/**
 * imapflow 适配器。依赖不在 package.json（安装会阻塞 CI 环境），
 * 仅在 OUTREACH_IMAP_ENABLED=true 且模块可用时工作；否则抛清晰错误，由轮询器记日志跳过。
 */
@Injectable()
export class ImapFlowClient implements OutreachImapClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async withClient<T>(fn: (client: unknown, lock: unknown) => Promise<T>, mailbox: string): Promise<T> {
    const spec = 'imapflow';
    let module: { ImapFlow?: new (options: Record<string, unknown>) => unknown };
    try {
      module = (await import(spec)) as typeof module;
    } catch {
      throw new Error('IMAP 客户端依赖未安装（imapflow），拒绝轮询');
    }
    if (!module.ImapFlow) throw new Error('imapflow 导出缺失');
    const client = new module.ImapFlow({
      host: this.config.OUTREACH_IMAP_HOST,
      port: this.config.OUTREACH_IMAP_PORT,
      secure: true,
      auth: {
        user: this.config.OUTREACH_IMAP_USER,
        pass: this.config.OUTREACH_IMAP_PASSWORD,
      },
      tls: { rejectUnauthorized: this.config.OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED },
      logger: false,
    }) as {
      connect(): Promise<void>;
      logout(): Promise<void>;
      getMailboxLock(name: string): Promise<{ release(): void }>;
    };
    await client.connect();
    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        return await fn(client, lock);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async fetchUnseen(mailbox: string): Promise<OutreachImapMessage[]> {
    if (!this.config.OUTREACH_IMAP_HOST || !this.config.OUTREACH_IMAP_USER) {
      throw new Error('IMAP 未配置（OUTREACH_IMAP_HOST/OUTREACH_IMAP_USER）');
    }
    return this.withClient(async (client) => {
      const messages: OutreachImapMessage[] = [];
      const flow = client as {
        fetch(
          range: Record<string, unknown>,
          options: Record<string, unknown>,
        ): AsyncIterable<{ uid: number; source?: Buffer }>;
      };
      for await (const message of flow.fetch({ seen: false }, { source: true, uid: true })) {
        if (!message.source) continue;
        messages.push({ uid: message.uid, raw: message.source.toString('utf8') });
      }
      return messages;
    }, mailbox);
  }

  async markSeen(mailbox: string, uid: number): Promise<void> {
    await this.withClient(async (client) => {
      const flow = client as {
        messageFlagsAdd(uid: number, flags: string[], options: Record<string, unknown>): Promise<boolean>;
      };
      await flow.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    }, mailbox);
  }
}

export interface ImapPollSummary {
  processed: number;
  duplicates: number;
  unmatched: number;
  errors: number;
}

/**
 * IMAP 入站轮询（P4-06，OUTREACH_IMAP_ENABLED 默认 false）：
 * 每 OUTREACH_IMAP_POLL_INTERVAL_MS 遍历 ACTIVE 信箱，把未读邮件交给 ingest，
 * 成功/重复处理后标记 \Seen；单封失败不阻塞其余邮件。
 * 凭据是进程级单信箱模式（多信箱凭据引用随 outreach_mailbox.secret_ref 卡片落地）。
 */
@Injectable()
export class OutreachImapPoller implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: OutreachIngestService,
    @Inject(OUTREACH_IMAP_CLIENT) private readonly client: OutreachImapClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.OUTREACH_IMAP_ENABLED) return;
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.config.OUTREACH_IMAP_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async pollOnce(): Promise<ImapPollSummary> {
    const summary: ImapPollSummary = { processed: 0, duplicates: 0, unmatched: 0, errors: 0 };
    const mailboxes = await this.prisma.outreachMailbox.findMany({
      where: { state: 'ACTIVE' },
      select: { address: true, workspaceId: true },
    });
    for (const mailbox of mailboxes) {
      let messages: OutreachImapMessage[];
      try {
        messages = await this.client.fetchUnseen(mailbox.address);
      } catch {
        summary.errors += 1;
        continue;
      }
      for (const message of messages) {
        try {
          const result = await this.ingest.ingest(
            { userId: 'imap-ingest', workspaceId: mailbox.workspaceId, role: 'admin' },
            message.raw,
          );
          if (result.outcome === 'DUPLICATE') summary.duplicates += 1;
          else if (result.outcome === 'UNMATCHED') summary.unmatched += 1;
          else summary.processed += 1;
          await this.client.markSeen(mailbox.address, message.uid);
        } catch {
          summary.errors += 1;
        }
      }
    }
    return summary;
  }
}
