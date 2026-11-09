import {
  BadRequestException,
  Body,
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
import { OutreachExperimentsService } from './outreach-experiments.service.js';

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  hypothesis: z.string().trim().min(1).max(2000),
  primaryMetric: z.string().trim().min(1).max(64),
  campaignId: z.string().uuid().optional(),
  design: z.enum(['holdout', 'ab']).optional(),
  holdoutRatio: z.coerce.number().gt(0).lt(1).optional(),
  strata: z.unknown().optional(),
  analysisPlan: z.unknown().optional(),
});

const assignBody = z.object({
  subjectType: z.enum(['account', 'contact']).optional(),
  subjectRefs: z.array(z.string().uuid()).min(1).max(500),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** 实验与 holdout（P4-09）：创建/启动/归档/分配均管理员；列表租户可见。 */
@Controller('api/outreach/experiments')
@UseGuards(TenantGuard)
export class OutreachExperimentsController {
  constructor(private readonly experiments: OutreachExperimentsService) {}

  @Get()
  async list(@Req() req: Request) {
    return { data: await this.experiments.list(req.tenant!) };
  }

  @Get(':experimentId')
  async get(@Req() req: Request, @Param('experimentId') experimentId: string) {
    return { data: await this.experiments.get(req.tenant!, experimentId) };
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Req() req: Request, @Body() body: unknown) {
    const parsed = createBody.safeParse(body);
    if (!parsed.success) invalid('实验字段不合法');
    return { data: await this.experiments.create(req.tenant!, parsed.data) };
  }

  @Post(':experimentId/start')
  @UseGuards(AdminGuard)
  async start(@Req() req: Request, @Param('experimentId') experimentId: string) {
    return { data: await this.experiments.start(req.tenant!, experimentId) };
  }

  @Post(':experimentId/archive')
  @UseGuards(AdminGuard)
  async archive(@Req() req: Request, @Param('experimentId') experimentId: string) {
    return { data: await this.experiments.archive(req.tenant!, experimentId) };
  }

  @Post(':experimentId/assignments')
  @UseGuards(AdminGuard)
  async assign(
    @Req() req: Request,
    @Param('experimentId') experimentId: string,
    @Body() body: unknown,
  ) {
    const parsed = assignBody.safeParse(body);
    if (!parsed.success) invalid('分配字段不合法');
    return { data: await this.experiments.assign(req.tenant!, experimentId, parsed.data) };
  }
}
