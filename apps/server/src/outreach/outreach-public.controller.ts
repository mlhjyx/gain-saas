import {
  Controller,
  Get,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  OUTREACH_DNC_SUPPRESSOR,
  type OutreachDncSuppressor,
} from './outreach-dnc.checker.js';
import { OutreachUnsubscribeService } from './outreach-unsubscribe.service.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Abmelden / 退订</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 20px;color:#222}button{background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}small{color:#666}</style></head><body>${body}</body></html>`;
}

/**
 * 公共退订端点（M2 步 11-4）。无登录态，凭一次性 token：
 * - GET 只展示确认页，不消费 token（邮件扫描器/预取不会误退订）；
 * - POST 消费 token（支持邮件客户端 List-Unsubscribe=One-Click）。
 * 消费成功后尽力同步平台级抑制；同步失败不回滚租户内退订，只记日志。
 */
const PUBLIC_RATE_LIMIT_MAX = 60;
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60_000;

@Controller('api/public/outreach')
export class OutreachPublicController {
  private readonly logger = new Logger(OutreachPublicController.name);
  private readonly rateHits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly unsubscribe: OutreachUnsubscribeService,
    @Inject(OUTREACH_DNC_SUPPRESSOR)
    private readonly suppressor: OutreachDncSuppressor,
  ) {}

  private applyPublicHeaders(res: Response): void {
    res.setHeader?.('Cache-Control', 'no-store');
    res.setHeader?.('X-Frame-Options', 'DENY');
    res.setHeader?.('Referrer-Policy', 'no-referrer');
  }

  private rateLimited(req: Request): boolean {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    if (this.rateHits.size > 10_000) this.rateHits.clear();
    const entry = this.rateHits.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.rateHits.set(ip, { count: 1, resetAt: now + PUBLIC_RATE_LIMIT_WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > PUBLIC_RATE_LIMIT_MAX;
  }

  @Get('unsubscribe')
  confirm(@Query('token') token: string | undefined, @Res() res: Response) {
    this.applyPublicHeaders(res);
    if (!token) {
      return res
        .status(400)
        .type('html')
        .send(page('<h1>链接无效</h1><p>缺少退订凭据。</p>'));
    }
    const safeToken = escapeHtml(token);
    return res.type('html').send(
      page(
        `<h1>Abmelden / 退订</h1><p>点击下方按钮，确认不再接收此类邮件。</p>` +
          `<form method="post" action="/api/public/outreach/unsubscribe">` +
          `<input type="hidden" name="token" value="${safeToken}">` +
          `<button type="submit">Abmelden / 确认退订</button></form>` +
          `<p><small>Mit dem Absenden werden Sie aus weiteren Kampagnen dieses Absenders entfernt.</small></p>`,
      ),
    );
  }

  @Post('unsubscribe')
  async consume(@Req() req: Request, @Res() res: Response) {
    this.applyPublicHeaders(res);
    if (this.rateLimited(req)) {
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' },
      });
    }
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const bodyToken =
      typeof (req.body as { token?: unknown } | undefined)?.token === 'string'
        ? ((req.body as { token: string }).token)
        : undefined;
    const token = queryToken ?? bodyToken;
    const result = await this.unsubscribe.consume(token);

    if (result.recipientEmail && !result.alreadyUsed) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.suppressor.suppressGlobal(
            {
              userId: 'public:unsubscribe',
              workspaceId: result.workspaceId,
              role: 'admin',
            },
            {
              email: result.recipientEmail,
              reason: 'unsubscribe',
              source: 'gain-saas:unsubscribe',
            },
          );
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) {
        this.logger.warn(
          `平台级抑制同步失败（已重试 1 次，租户内退订已生效）: ${
            lastError instanceof Error ? lastError.message : 'unknown'
          }`,
        );
      }
    }

    if (req.accepts(['json', 'html']) === 'html') {
      return res.type('html').send(
        page(
          `<h1>Abgemeldet / 已退订</h1><p>Sie erhalten von diesem Absender keine weiteren Kampagnen-E-Mails.</p>` +
            `<p><small>Falls Sie weiterhin E-Mails erhalten, antworten Sie bitte direkt auf die Nachricht.</small></p>`,
        ),
      );
    }
    return res.json({
      data: { unsubscribed: true, alreadyUsed: result.alreadyUsed },
    });
  }
}
