import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachBatchService } from './outreach-batch.service.js';
import { OutreachSendService } from './outreach-send.service.js';

const QuickConfirmBodySchema = z
  .object({
    sendNow: z.boolean().optional(),
    mailboxId: z.string().uuid().optional(),
  })
  .strict();

/**
 * M2 步 11-3 + M9-PR2：发送执行、审计包与中小租户合规预检一键确认通道。
 * `POST /send` 受 OUTREACH_SEND_ENABLED 门保护（默认关，返回 409 OUTREACH_SEND_DISABLED）；
 * `POST /preflight` 只读执行合规/法域/DNC/健康度/发信箱预检；
 * `POST /quick-confirm` 在企业多级审批开关关闭且预检放行时一步冻结确认、入队并可选立即触发发送。
 */
@Controller('api/outreach/batches')
@UseGuards(TenantGuard)
export class OutreachSendController {
  constructor(
    private readonly sends: OutreachSendService,
    private readonly batches: OutreachBatchService,
  ) {}

  @Post(':batchId/preflight')
  async preflight(@Req() req: Request, @Param('batchId') batchId: string) {
    return { data: await this.sends.preflightBatch(req.tenant!, batchId) };
  }

  @Post(':batchId/quick-confirm')
  @UseGuards(AdminGuard)
  async quickConfirm(
    @Req() req: Request,
    @Param('batchId') batchId: string,
    @Body() body: unknown,
  ) {
    const parsed = QuickConfirmBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? '请求参数不合法',
        },
      });
    }

    const preflight = await this.sends.preflightBatch(req.tenant!, batchId);
    if (preflight.enterpriseApprovalRequired) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_ENTERPRISE_APPROVAL_REQUIRED',
          message: '当前企业审批策略要求走两段式提交与审批流程，已禁用一键确认发送',
        },
      });
    }
    if (!preflight.health.ok) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_MAILBOX_PAUSED',
          message: preflight.health.error ?? '发信健康度熔断中，暂不可发送',
        },
      });
    }
    if (preflight.readyCount === 0) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_PREFLIGHT_NO_SENDABLE_DRAFTS',
          message: '批次内所有草稿均未通过合规预检（DNC / 法域同意 / 页脚），暂无可发送草稿',
        },
      });
    }

    const confirmation = await this.batches.quickConfirmBatch(req.tenant!, batchId, {
      mailboxId: parsed.data.mailboxId,
    });
    const sendResult = parsed.data.sendNow
      ? await this.sends.sendBatch(req.tenant!, batchId)
      : undefined;

    return {
      data: {
        preflight,
        confirmation,
        ...(sendResult ? { sendResult } : {}),
      },
    };
  }

  @Post(':batchId/send')
  @UseGuards(AdminGuard)
  async send(@Req() req: Request, @Param('batchId') batchId: string) {
    return { data: await this.sends.sendBatch(req.tenant!, batchId) };
  }

  @Get(':batchId/audit-package')
  async auditPackage(@Req() req: Request, @Param('batchId') batchId: string) {
    return { data: await this.sends.getAuditPackage(req.tenant!, batchId) };
  }
}
