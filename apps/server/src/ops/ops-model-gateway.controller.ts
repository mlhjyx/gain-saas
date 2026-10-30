import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { OpsGuard, type OpsRequest } from './ops.guard.js';
import { ModelGatewayService } from '../model-gateway/model-gateway.service.js';

/** 运营台的模型网关配置面:厂商、模型别名路由、连通性测试与近期调用。 */
@Controller('api/ops/model-gateway')
@UseGuards(OpsGuard)
export class OpsModelGatewayController {
  constructor(private readonly gateway: ModelGatewayService) {}

  @Get()
  async overview() {
    return this.gateway.overview();
  }

  @Post('providers')
  @HttpCode(201)
  async createProvider(@Body() body: unknown, @Req() req: OpsRequest) {
    return { data: await this.gateway.createProvider(body, req.opsUser!.id) };
  }

  @Patch('providers/:id')
  async updateProvider(@Param('id') id: string, @Body() body: unknown, @Req() req: OpsRequest) {
    return { data: await this.gateway.updateProvider(id, body, req.opsUser!.id) };
  }

  @Delete('providers/:id')
  async deleteProvider(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.gateway.deleteProvider(id, req.opsUser!.id) };
  }

  @Post('probe')
  @HttpCode(200)
  async probe(@Body() body: unknown) {
    return { data: await this.gateway.probeProvider(body) };
  }

  @Post('providers/:id/test')
  @HttpCode(200)
  async testProvider(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const model = typeof body.model === 'string' ? body.model : undefined;
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey : undefined;
    return { data: await this.gateway.testProvider(id, model, apiKey) };
  }

  @Get('providers/:id/models')
  async providerModels(@Param('id') id: string) {
    return { data: await this.gateway.listProviderModels(id) };
  }

  @Post('routes')
  @HttpCode(201)
  async createRoute(@Body() body: unknown, @Req() req: OpsRequest) {
    return { data: await this.gateway.createRoute(body, req.opsUser!.id) };
  }

  @Patch('routes/:id')
  async updateRoute(@Param('id') id: string, @Body() body: unknown, @Req() req: OpsRequest) {
    return { data: await this.gateway.updateRoute(id, body, req.opsUser!.id) };
  }

  @Delete('routes/:id')
  async deleteRoute(@Param('id') id: string, @Req() req: OpsRequest) {
    return { data: await this.gateway.deleteRoute(id, req.opsUser!.id) };
  }
}
