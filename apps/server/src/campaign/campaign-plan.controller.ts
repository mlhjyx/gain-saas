import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CampaignPlanJobService } from './campaign-plan-job.service.js';

/**
 * M2.1 租户端点（docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md §4.2）：
 * 触发一次受限规划 job（admin）与轮询 job 状态。计划本身只能由引擎经内部回调落成
 * DRAFT revision；本端点不产计划、不执行任何动作。
 */
@Controller('api/campaigns')
@UseGuards(TenantGuard)
export class CampaignPlanController {
  constructor(private readonly jobs: CampaignPlanJobService) {}

  @Post(':campaignId/plan-drafts')
  @UseGuards(AdminGuard)
  @HttpCode(202)
  async createPlanDraft(
    @Req() req: Request,
    @Param('campaignId') campaignId: string,
    @Body() body: unknown,
  ) {
    const data = await this.jobs.createPlanDraft(req.tenant!, campaignId, body);
    return { data };
  }

  @Get(':campaignId/plan-drafts/:jobId')
  async getPlanDraft(
    @Req() req: Request,
    @Param('campaignId') campaignId: string,
    @Param('jobId') jobId: string,
  ) {
    const data = await this.jobs.getPlanJob(req.tenant!, campaignId, jobId);
    return { data };
  }
}
