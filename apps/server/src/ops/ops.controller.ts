import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { OpsGuard, type OpsRequest } from './ops.guard.js';
import { OpsChannelsService } from './ops-channels.service.js';
import { OpsCampaignMetricsService } from './ops-campaign-metrics.service.js';
import { OpsService } from './ops.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

@Controller('api/ops')
@UseGuards(OpsGuard)
export class OpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly opsChannels: OpsChannelsService,
    private readonly campaignMetrics: OpsCampaignMetricsService,
  ) {}

  @Get('overview')
  overview() {
    return this.ops.overview();
  }

  /**
   * M2.2 Campaign 指标（设计 §5）：审批通过率 / 每通过计划成本 / 人工修改距离 / 重规划轮次分布。
   * 只读、ops 专属（OpsGuard 之后），租户接口不可达。窗口缺省近 28 天，最长 365 天。
   */
  @Get('campaign-metrics')
  async campaignMetricsQuery(@Query() query: Record<string, unknown>) {
    const to = typeof query.to === 'string' ? new Date(query.to) : new Date();
    const from = typeof query.from === 'string' ? new Date(query.from) : new Date(to.getTime() - 28 * DAY_MS);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
      throw new BadRequestException('from/to 必须是 ISO 时间且 from < to');
    }
    if (to.getTime() - from.getTime() > 365 * DAY_MS) {
      throw new BadRequestException('窗口最长 365 天');
    }
    const workspaceId = typeof query.workspaceId === 'string' ? query.workspaceId : undefined;
    if (workspaceId !== undefined && !UUID_RE.test(workspaceId)) {
      throw new BadRequestException('workspaceId 必须是 UUID');
    }
    return {
      metrics: await this.campaignMetrics.campaignMetrics({
        from,
        to,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      }),
    };
  }

  // GET /probe 已移除:概览内部直接调用 service.probe(),无页面/脚本使用该 HTTP 路由(2026-11-03 清理)。

  @Get('providers')
  async providers() {
    return { providers: await this.ops.providers() };
  }

  @Post('providers/:key/status')
  @HttpCode(200)
  async providerStatus(@Param('key') key: string, @Body() body: Record<string, unknown>, @Req() req: OpsRequest) {
    const status = typeof body.status === 'string' ? body.status : '';
    return { data: await this.ops.setProviderStatus(key, status, req.opsUser!.id) };
  }

  /** 平台渠道数据源（P3）：注册/治理/启停/试跑只属于运营台，经 saas-ops 引擎身份落库。 */
  @Get('channels')
  async channels(@Req() req: OpsRequest) {
    return { channels: await this.opsChannels.list(req.opsUser!.id) };
  }

  @Post('channels')
  @HttpCode(201)
  async createChannel(@Body() body: unknown, @Req() req: OpsRequest) {
    return { data: await this.opsChannels.create(req.opsUser!.id, body) };
  }

  @Patch('channels/:id')
  async updateChannel(@Param('id') id: string, @Body() body: unknown, @Req() req: OpsRequest) {
    return { data: await this.opsChannels.patch(req.opsUser!.id, id, body) };
  }

  @Post('channels/:id/preview')
  @HttpCode(200)
  async previewChannel(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.opsChannels.preview(req.opsUser!.id, id) };
  }

  @Post('channels/:id/run')
  @HttpCode(200)
  async runChannel(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.opsChannels.run(req.opsUser!.id, id) };
  }

  @Get('channels/:id/records')
  async channelRecords(
    @Param('id') id: string,
    @Query('limit') limit: string | undefined,
    @Req() req: OpsRequest,
  ) {
    return { data: await this.opsChannels.records(req.opsUser!.id, id, limit) };
  }

  @Get('sources')
  async sources(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return { sources: await this.ops.sources({ status, q, limit: Number(limit) || undefined }) };
  }

  @Get('sources/:id')
  source(@Param('id') id: string) {
    return this.ops.source(id);
  }

  @Post('sources')
  @HttpCode(201)
  async createSource(@Body() body: unknown, @Req() req: OpsRequest) {
    return { data: await this.ops.createSource(body, req.opsUser!.id) };
  }

  @Patch('sources/:id')
  async updateSource(@Param('id') id: string, @Body() body: unknown, @Req() req: OpsRequest) {
    return { data: await this.ops.updateSource(id, body, req.opsUser!.id) };
  }

  @Post('sources/:id/acquire-now')
  @HttpCode(200)
  async acquireNow(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.ops.acquireNow(id, req.opsUser!.id) };
  }

  @Post('sources/:id/status')
  @HttpCode(200)
  async sourceStatus(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: OpsRequest) {
    const status = typeof body.status === 'string' ? body.status : '';
    return { data: await this.ops.setSourceStatus(id, status, req.opsUser!.id) };
  }

  @Delete('sources/:id')
  async deleteSource(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.ops.deleteSource(id, req.opsUser!.id) };
  }

  @Post('workspaces/:id/status')
  @HttpCode(200)
  async workspaceStatus(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: OpsRequest) {
    const status = typeof body.status === 'string' ? body.status : '';
    const note = typeof body.note === 'string' ? body.note : undefined;
    return { data: await this.ops.setWorkspaceStatus(id, status, req.opsUser!.id, note) };
  }

  @Get('budget')
  async budget() {
    return { data: await this.ops.budget() };
  }

  @Get('workspaces')
  async workspaces() {
    return { workspaces: await this.ops.workspaces() };
  }

  @Get('users')
  async users(@Query('q') q?: string) {
    return { users: await this.ops.users(q) };
  }

  @Post('users/:id/status')
  @HttpCode(200)
  async userStatus(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: OpsRequest) {
    const status = typeof body.status === 'string' ? body.status : '';
    return { data: await this.ops.setUserStatus(id, status, req.opsUser!.id) };
  }

  @Get('workspaces/:id/runs')
  async runs(@Param('id') id: string) {
    return { runs: await this.ops.runs(id) };
  }

  @Get('workspaces/:id/leads')
  async leads(@Param('id') id: string) {
    return { leads: await this.ops.leads(id) };
  }

  @Get('workspaces/:id/outbox')
  async outbox(@Param('id') id: string) {
    return { outbox: await this.ops.outbox(id) };
  }

  @Get('workspaces/:id/provider-attribution')
  async providerAttribution(@Param('id') id: string) {
    return { providers: await this.ops.providerAttribution(id) };
  }
  /** M2 步 10：候选批次（qualify 每批一条 CandidateBatchCompleted 的事件投影）。 */
  @Get('workspaces/:id/candidate-batches')
  async candidateBatches(@Param('id') id: string, @Query('limit') limit?: string) {
    return { batches: await this.ops.candidateBatches(id, { limit: Number(limit) || undefined }) };
  }

  @Get('workspaces/:id/traces')
  async traces(@Param('id') id: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    return { traces: await this.ops.traces(id, { status, limit: Number(limit) || undefined }) };
  }

  @Get('fetches')
  async fetches(@Query('status') status?: string, @Query('limit') limit?: string) {
    return { fetches: await this.ops.fetches({ status, limit: Number(limit) || undefined }) };
  }

  @Get('changes')
  async changes(@Query('type') type?: string, @Query('limit') limit?: string) {
    return { changes: await this.ops.changes({ type, limit: Number(limit) || undefined }) };
  }

  @Get('export/sources')
  async exportSources(@Res() res: Response, @Req() req: OpsRequest, @Query('status') status?: string) {
    const { csv, filename } = await this.ops.exportSources(req.opsUser!.id, status);
    sendCsv(res, csv, filename);
  }

  @Get('export/fetches')
  async exportFetches(@Res() res: Response, @Req() req: OpsRequest, @Query('status') status?: string) {
    const { csv, filename } = await this.ops.exportFetches(req.opsUser!.id, status);
    sendCsv(res, csv, filename);
  }

  @Get('export/entities')
  async exportEntities(
    @Res() res: Response,
    @Req() req: OpsRequest,
    @Query('sourceId') sourceId?: string,
    @Query('search') search?: string,
  ) {
    const { csv, filename } = await this.ops.exportEntities(req.opsUser!.id, sourceId, search);
    sendCsv(res, csv, filename);
  }

  @Get('export/leads')
  async exportLeads(
    @Res() res: Response,
    @Req() req: OpsRequest,
    @Query('workspaceId') workspaceId?: string,
    @Query('queue') queue?: string,
  ) {
    const { csv, filename } = await this.ops.exportLeads(req.opsUser!.id, workspaceId, queue);
    sendCsv(res, csv, filename);
  }

  @Get('audit')
  async audit(@Query('limit') limit?: string) {
    return { entries: await this.ops.auditLog(Number(limit) || 100) };
  }

  @Get('schedules')
  async schedules() {
    return this.ops.schedules();
  }

  @Get('workflows')
  async workflows(@Query('status') status?: string, @Query('limit') limit?: string) {
    return { workflows: await this.ops.workflows(status, Number(limit) || 50) };
  }

  @Post('schedules')
  @HttpCode(201)
  async createSchedule(@Body() body: Record<string, unknown>, @Req() req: OpsRequest) {
    const scheduleId = typeof body.scheduleId === 'string' ? body.scheduleId.trim() : '';
    const workflowType = typeof body.workflowType === 'string' ? body.workflowType.trim() : '';
    const intervalMinutes = Number(body.intervalMinutes);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(scheduleId) || !workflowType || !Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525600) {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: 'scheduleId/workflowType/intervalMinutes 不合法' } });
    }
    return {
      data: await this.ops.createSchedule(
        { scheduleId, workflowType, intervalMinutes, ...(typeof body.note === 'string' ? { note: body.note.slice(0, 200) } : {}) },
        req.opsUser!.id,
      ),
    };
  }

  @Post('schedules/:id/pause')
  @HttpCode(200)
  async pauseSchedule(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: OpsRequest) {
    return { data: await this.ops.pauseSchedule(id, typeof body.note === 'string' ? body.note.slice(0, 200) : undefined, req.opsUser!.id) };
  }

  @Post('schedules/:id/unpause')
  @HttpCode(200)
  async unpauseSchedule(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.ops.unpauseSchedule(id, req.opsUser!.id) };
  }

  @Post('schedules/:id/trigger')
  @HttpCode(200)
  async triggerSchedule(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.ops.triggerSchedule(id, req.opsUser!.id) };
  }

  @Delete('schedules/:id')
  async deleteSchedule(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.ops.deleteSchedule(id, req.opsUser!.id) };
  }
}

function sendCsv(res: Response, csv: string, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(csv);
}
