import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ModelGatewayAuthGuard } from './model-gateway-auth.guard.js';
import { ModelGatewayService } from './model-gateway.service.js';

/**
 * 引擎侧 OpenAI 兼容入口。只做聚合网关:路由、Key 注入、模型别名回写、元数据日志。
 * 带 new-api settlement 头的站点构建请求透传给 new-api;获客主链路走本地路由。
 */
@Controller('v1')
@UseGuards(ModelGatewayAuthGuard)
export class ModelGatewayRuntimeController {
  constructor(private readonly gateway: ModelGatewayService) {}

  @Get('models')
  async models() {
    const { models } = await this.gateway.listPublicModels();
    return { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'gainos' })) };
  }

  private send(result: { status: number; body: unknown; headers: Record<string, string> }, response: Response) {
    for (const [key, value] of Object.entries(result.headers)) response.setHeader(key, value);
    response.setHeader('cache-control', result.headers['cache-control'] ?? 'no-store');
    response.status(result.status);
    return result.body;
  }

  @Post('chat/completions')
  async chat(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.send(await this.gateway.chatCompletion(body, request.headers), response);
  }

  @Post('responses')
  async responses(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.send(await this.gateway.proxySettlement('responses', body, request.headers), response);
  }

  @Post('messages')
  async messages(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.send(await this.gateway.proxySettlement('messages', body, request.headers), response);
  }

  @Post('embeddings')
  async embeddings(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.send(await this.gateway.proxySettlement('embeddings', body, request.headers), response);
  }
}
