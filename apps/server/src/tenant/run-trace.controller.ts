import { BadRequestException, Controller, Get, HttpException, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { EngineHttp } from '../bff/engine-http.js';
import { TenantGuard } from './tenant.guard.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * M2 步 9b-4：「过程」时间线——run 的决策轨迹（源侦察员选源/跳过原因 + 资格判定员批量判定/被否候选）。
 *
 * 走租户控制器而非 BFF routes 表（SD7 允许业务控制器；与 claim-drafts 同理，避免改 BFF 注册表）：
 * 引擎端是只读端点（GET /api/v1/runs/:runId/trace），跨租户在引擎侧就是 404。
 * 响应按既有分页约定包一层 { data: { data, page } }，前端 requestClient 解出 { data, page }。
 */
@Controller('api/runs')
@UseGuards(TenantGuard)
export class RunTraceController {
  constructor(private readonly engine: EngineHttp) {}

  @Get(':runId/trace')
  async trace(
    @Req() req: Request,
    @Param('runId') runId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const tenant = req.tenant!;
    if (!UUID.test(runId)) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'runId 必须是 UUID' },
      });
    }
    const query: Record<string, string> = {};
    if (limit !== undefined) query.limit = limit;
    if (cursor !== undefined && cursor !== '') query.cursor = cursor;
    let response: Awaited<ReturnType<EngineHttp['call']>>;
    try {
      response = await this.engine.call(tenant, 'GET', `/runs/${runId}/trace`, { query });
    } catch {
      throw new HttpException(
        { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: '引擎不可达' } },
        502,
      );
    }
    if (response.status >= 400) {
      throw new HttpException(
        this.engine.toClientError(response.status, response.body),
        this.engine.toClientStatus(response.status, response.body),
      );
    }
    return { data: response.body };
  }
}
