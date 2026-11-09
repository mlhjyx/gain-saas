import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import {
  CALL_OBJECTION_CODES,
  CALL_OUTCOMES,
  CALL_TRIGGER_TYPES,
  OutreachCallsService,
} from './outreach-calls.service.js';

const basisBody = z.object({
  contactRef: z.string().uuid(),
  phoneE164: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  companyName: z.string().trim().min(1).max(200),
  contactRole: z.string().trim().max(200).optional(),
  triggerType: z.enum(CALL_TRIGGER_TYPES),
  triggerEvidence: z.unknown(),
  relevanceStatement: z.string().trim().min(20).max(2000),
  collectedSourceUrl: z.string().trim().url().max(2048),
  collectedAt: z.string().datetime(),
  validUntil: z.string().datetime().optional(),
  scriptTemplateId: z.string().uuid(),
  legalReviewId: z.string().uuid(),
  reviewedBy: z.string().trim().min(1).max(200),
  reviewedAt: z.string().datetime(),
});

const attemptBody = z.object({
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  durationSeconds: z.coerce.number().int().min(0).max(7200).optional(),
  outcome: z.enum(CALL_OUTCOMES),
  objectionCode: z.enum(CALL_OBJECTION_CODES).optional(),
  notesHash: z.string().trim().regex(/^[0-9a-fA-F]{64}$/).optional(),
  notesRef: z.string().trim().max(256).optional(),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/**
 * DE 电话推定同意证据链（P4-10）：basis 与拨号记录。四问校验与法审/话术门在服务层 fail-closed。
 * 真机拨号、话术文本与律师意见为外部素材；本端点是唯一拨号台账入口。
 */
@Controller('api/outreach')
@UseGuards(TenantGuard)
export class OutreachCallsController {
  constructor(private readonly calls: OutreachCallsService) {}

  @Get('call-bases')
  async listBasis(@Req() req: Request, @Query('contactRef') contactRef?: string) {
    return { data: await this.calls.listBasis(req.tenant!, contactRef) };
  }

  @Get('call-bases/:basisId')
  async getBasis(@Req() req: Request, @Param('basisId') basisId: string) {
    return { data: await this.calls.getBasis(req.tenant!, basisId) };
  }

  @Post('call-bases')
  @UseGuards(AdminGuard)
  async createBasis(@Req() req: Request, @Body() body: unknown) {
    const parsed = basisBody.safeParse(body);
    if (!parsed.success) invalid('拨号依据字段不合法');
    return { data: await this.calls.createBasis(req.tenant!, parsed.data) };
  }

  @Get('call-bases/:basisId/attempts')
  async listAttempts(@Req() req: Request, @Param('basisId') basisId: string) {
    return { data: await this.calls.listAttempts(req.tenant!, basisId) };
  }

  @Post('call-bases/:basisId/attempts')
  @UseGuards(AdminGuard)
  async createAttempt(
    @Req() req: Request,
    @Param('basisId') basisId: string,
    @Body() body: unknown,
  ) {
    const parsed = attemptBody.safeParse(body);
    if (!parsed.success) invalid('拨号记录字段不合法');
    return { data: await this.calls.createAttempt(req.tenant!, basisId, parsed.data) };
  }
}
