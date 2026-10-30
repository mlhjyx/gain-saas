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
import { OpsService } from './ops.service.js';

@Controller('api/ops')
@UseGuards(OpsGuard)
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('overview')
  overview() {
    return this.ops.overview();
  }

  @Get('probe')
  probe() {
    return this.ops.probe();
  }

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
  async exportSources(@Res() res: Response, @Query('status') status?: string) {
    const { csv, filename } = await this.ops.exportSources(status);
    sendCsv(res, csv, filename);
  }

  @Get('export/fetches')
  async exportFetches(@Res() res: Response, @Query('status') status?: string) {
    const { csv, filename } = await this.ops.exportFetches(status);
    sendCsv(res, csv, filename);
  }

  @Get('export/entities')
  async exportEntities(@Res() res: Response, @Query('sourceId') sourceId?: string, @Query('search') search?: string) {
    const { csv, filename } = await this.ops.exportEntities(sourceId, search);
    sendCsv(res, csv, filename);
  }

  @Get('export/leads')
  async exportLeads(
    @Res() res: Response,
    @Query('workspaceId') workspaceId?: string,
    @Query('queue') queue?: string,
  ) {
    const { csv, filename } = await this.ops.exportLeads(workspaceId, queue);
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
