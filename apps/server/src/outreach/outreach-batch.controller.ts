import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachBatchService } from './outreach-batch.service.js';

const createBatchBody = z.object({
  name: z.string().trim().min(1).max(200),
  campaignId: z.string().uuid().optional(),
});

const draftBody = z.object({
  contactRef: z.string().uuid(),
  recipientEmail: z.string().trim().email().max(320),
  companyName: z.string().trim().max(200).optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
});

const decideBody = z.object({
  decision: z.enum(['approve', 'decline']),
  reason: z.string().trim().max(500).optional(),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** M2 步 11-2：触达批次、草稿编辑与批次审批；批准后只入待发队列（发送在 11-3，默认关）。 */
@Controller('api/outreach/batches')
@UseGuards(TenantGuard)
export class OutreachBatchController {
  constructor(private readonly batches: OutreachBatchService) {}

  @Get()
  async list(@Req() req: Request) {
    return { data: await this.batches.listBatches(req.tenant!) };
  }

  @Get(':batchId')
  async detail(@Req() req: Request, @Param('batchId') batchId: string) {
    return { data: await this.batches.getBatch(req.tenant!, batchId) };
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Req() req: Request, @Body() body: unknown) {
    const parsed = createBatchBody.safeParse(body);
    if (!parsed.success) invalid('批次名称必填且不超过 200 字');
    return { data: await this.batches.createBatch(req.tenant!, parsed.data) };
  }

  @Post(':batchId/drafts')
  @UseGuards(AdminGuard)
  async addDraft(
    @Req() req: Request,
    @Param('batchId') batchId: string,
    @Body() body: unknown,
  ) {
    const parsed = draftBody.safeParse(body);
    if (!parsed.success) invalid('草稿字段不合法');
    return { data: await this.batches.addDraft(req.tenant!, batchId, parsed.data) };
  }

  @Patch(':batchId/drafts/:draftId')
  @UseGuards(AdminGuard)
  async updateDraft(
    @Req() req: Request,
    @Param('batchId') batchId: string,
    @Param('draftId') draftId: string,
    @Body() body: unknown,
  ) {
    const parsed = draftBody.safeParse(body);
    if (!parsed.success) invalid('草稿字段不合法');
    return {
      data: await this.batches.updateDraft(req.tenant!, batchId, draftId, parsed.data),
    };
  }

  @Delete(':batchId/drafts/:draftId')
  @UseGuards(AdminGuard)
  async removeDraft(
    @Req() req: Request,
    @Param('batchId') batchId: string,
    @Param('draftId') draftId: string,
  ) {
    return { data: await this.batches.removeDraft(req.tenant!, batchId, draftId) };
  }

  @Post(':batchId/submit')
  @UseGuards(AdminGuard)
  async submit(@Req() req: Request, @Param('batchId') batchId: string) {
    return { data: await this.batches.submitBatch(req.tenant!, batchId) };
  }

  @Post(':batchId/approvals/:approvalId/decide')
  @UseGuards(AdminGuard)
  async decide(
    @Req() req: Request,
    @Param('batchId') batchId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
  ) {
    const parsed = decideBody.safeParse(body);
    if (!parsed.success) invalid('decision 必须是 approve 或 decline');
    return {
      data: await this.batches.decideApproval(
        req.tenant!,
        batchId,
        approvalId,
        parsed.data,
      ),
    };
  }

  @Post(':batchId/reopen')
  @UseGuards(AdminGuard)
  async reopen(@Req() req: Request, @Param('batchId') batchId: string) {
    return { data: await this.batches.reopenBatch(req.tenant!, batchId) };
  }
}
