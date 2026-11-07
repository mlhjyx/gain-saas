import { BadRequestException, Controller, HttpException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { EngineHttp } from '../bff/engine-http.js';
import { TenantGuard } from './tenant.guard.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * P5：从公司档案生成企业事实草稿（NEEDS_REVIEW），为存量空间/理解失败空间解
 * NO_APPROVED_CLAIMS 断点。走租户控制器而非 BFF routes 表（SD7 允许业务控制器；
 * 避免与主会话 M2.0 正在修改的 bff.module/routes 注册冲突）。
 *
 * 路径挂 /api/onboarding（BFF 中间件的既有放行前缀）：数据来源就是注册引导档案，
 * 且这样无需改 bff.module.ts 的放行清单（主会话正在改同一行，避免冲突）。
 * 若后续 /api/companies 进入放行清单，可平移该路径（前端仅改一处 URL）。
 * 引擎端是确定性本地写入：不消费执行预算 Grant。
 */
@Controller('api/onboarding')
@UseGuards(TenantGuard)
export class ClaimDraftsController {
  constructor(private readonly engine: EngineHttp) {}

  @Post('companies/:companyId/claim-drafts')
  async synthesize(@Req() req: Request, @Param('companyId') companyId: string) {
    const tenant = req.tenant!;
    if (!UUID.test(companyId)) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'companyId 必须是 UUID' },
      });
    }
    let response: Awaited<ReturnType<EngineHttp['call']>>;
    try {
      response = await this.engine.call(tenant, 'POST', `/companies/${companyId}/claim-drafts`);
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
    const data = (response.body as { data?: unknown } | null)?.data;
    return { data: data ?? null };
  }
}
