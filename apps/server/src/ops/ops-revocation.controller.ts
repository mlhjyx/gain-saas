import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { OpsGuard, type OpsRequest } from './ops.guard.js';
import { RevocationRequestError, PlatformRevocationService } from '../r4/platform-revocation.service.js';
import { REVOCATION_REASON_CODES } from '../r4/revocation-issuer.service.js';

/**
 * 运营台的平台撤销接口（P9）。
 *
 * 设计约束：
 *  - 撤销是 schedule 级、当前不可重开的动作：创建前 UI 必须二次确认并说明后果；
 *  - 操作员发起的请求立即进入投递（PENDING）；自动来源的请求在受审计重开路径
 *    就绪前停在 PENDING_CONFIRMATION，由这里确认；
 *  - 取消只允许从未投递或已确定未提交的请求——PENDING 可能已提交，取消它等于
 *    把未知当未提交，必须拒绝。
 */

const createSchema = z.object({
  scheduleId: z.string().trim().min(1).max(100),
  reasonCode: z.enum(REVOCATION_REASON_CODES),
  note: z.string().trim().max(300).optional(),
}).strict();

const cancelSchema = z.object({
  reason: z.string().trim().min(1).max(300),
}).strict();

@Controller('api/ops/r4')
@UseGuards(OpsGuard)
export class OpsRevocationController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly revocations: PlatformRevocationService,
  ) {}

  @Get('revocations')
  async list(@Query('limit') limit?: string) {
    return { requests: await this.revocations.list(Number(limit) || 100) };
  }

  @Get('revocations/:id')
  async get(@Param('id') id: string) {
    return { data: await this.call(() => this.revocations.get(id)) };
  }

  @Post('revocations')
  @HttpCode(202)
  async create(@Body() body: unknown, @Req() req: OpsRequest) {
    this.assertEnabled();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({ error: { code: 'VALIDATION', message: 'scheduleId/reasonCode/note 不合法' } });
    return {
      data: await this.call(() => this.revocations.create({
        ...parsed.data,
        source: 'OPERATOR',
        requestedBy: req.opsUser!.email,
      })),
    };
  }

  @Post('revocations/:id/confirm')
  @HttpCode(200)
  async confirm(@Param('id') id: string, @Req() req: OpsRequest) {
    this.assertEnabled();
    return { data: await this.call(() => this.revocations.confirm(id, req.opsUser!.email)) };
  }

  @Post('revocations/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() body: unknown, @Req() req: OpsRequest) {
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException({ error: { code: 'VALIDATION', message: 'reason 必填且不超过 300 字' } });
    return { data: await this.call(() => this.revocations.cancel(id, req.opsUser!.email, parsed.data.reason)) };
  }

  @Get('policy-state')
  async policyState() {
    return { states: await this.revocations.policyStates() };
  }

  private assertEnabled(): void {
    if (!this.config.R4_REVOCATION_TRIGGER_ENABLED)
      throw new ServiceUnavailableException({
        error: {
          code: 'R4_REVOCATION_TRIGGER_DISABLED',
          message: '撤销自动触发未启用（R4_REVOCATION_TRIGGER_ENABLED=false）',
        },
      });
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RevocationRequestError) {
        if (error.code.endsWith('_NOT_FOUND'))
          throw new NotFoundException({ error: { code: error.code, message: error.message } });
        throw new BadRequestException({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }
}
