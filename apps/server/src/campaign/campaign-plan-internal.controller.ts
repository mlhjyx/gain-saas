import {
  Body,
  Controller,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CampaignServiceTokenGuard } from './campaign-internal.controller.js';
import { CampaignPlanJobService } from './campaign-plan-job.service.js';

/**
 * M2.1 服务端点（引擎 → 本仓，`x-service-token` fail-closed，沿用 M2.0 verify guard）：
 *  - `POST campaign-revisions`：交付原始 CampaignPlan → zod 校验 + canonical plan_hash → 落 DRAFT revision；
 *    幂等键 (jobId, plan_hash)：重复回调返回已存在 revision；
 *  - `PATCH campaign-plan-jobs/:jobId`：失败回写 `{state:'FAILED', error, issues?}`（重复同码幂等）。
 */
@Controller('api/internal/v1')
@UseGuards(CampaignServiceTokenGuard)
export class CampaignPlanInternalController {
  constructor(private readonly jobs: CampaignPlanJobService) {}

  @Post('campaign-revisions')
  @HttpCode(201)
  async completeRevision(@Body() body: unknown) {
    const data = await this.jobs.completePlanJob(body);
    return { data };
  }

  @Patch('campaign-plan-jobs/:jobId')
  @HttpCode(200)
  async reportFailure(@Param('jobId') jobId: string, @Body() body: unknown) {
    const data = await this.jobs.reportJobFailure(jobId, body);
    return { data };
  }
}
