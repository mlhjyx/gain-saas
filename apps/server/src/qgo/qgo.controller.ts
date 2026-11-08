import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { QgoService, type PromoteQgoInput } from './qgo.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 商机（QGO）租户端点（M2 步 10）。全部经 TenantGuard（admin/member），
 * workspace 过滤在服务层，跨租户一律 404。错误体由全局过滤器补三层文案。
 */
@Controller('api/qgos')
@UseGuards(TenantGuard)
export class QgoController {
  constructor(private readonly qgos: QgoService) {}

  /** 从已接受的线索提升为商机（证据门 + next_step；幂等：同 lead 重复提升返回同一 QGO）。 */
  @Post()
  async promote(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const tenant = req.tenant!;
    return { data: await this.qgos.promote(tenant, body as PromoteQgoInput) };
  }

  @Get()
  async list(
    @Req() req: Request,
    @Query('state') state?: string,
    @Query('campaignId') campaignId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const tenant = req.tenant!;
    if (cursor !== undefined && !UUID.test(cursor)) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'cursor 必须是 UUID' } });
    }
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const page = await this.qgos.list(tenant, { state, campaignId, limit: n, cursor });
    return { data: page.data, page: { next_cursor: page.nextCursor, has_more: page.hasMore } };
  }

  @Get(':id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.qgos.detail(req.tenant!, id) };
  }

  @Post(':id/accept')
  async accept(@Req() req: Request, @Param('id') id: string) {
    return { data: await this.qgos.accept(req.tenant!, id) };
  }

  @Post(':id/decline')
  async decline(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return { data: await this.qgos.decline(req.tenant!, id, body.reason) };
  }
}
