import { Body, Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CooperationIntentService } from './cooperation.service.js';

/**
 * 官网公开端点（无登录态）。安全边界：
 * - 只接受 POST；CORS/体积限制/安全响应头由 public-cooperation-cors.ts 前置；
 * - 输入清洗（XSS）与限流在 service 内统一执行；
 * - 响应不回显用户输入，只返回提交编号与时间，避免反射型注入面。
 */
@Controller('api/public/cooperation-intents')
export class CooperationIntentController {
  private readonly logger = new Logger(CooperationIntentController.name);

  constructor(private readonly intents: CooperationIntentService) {}

  @Post()
  @HttpCode(201)
  async submit(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      const row = await this.intents.submit(body, {
        ip: req.ip,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
      });
      return {
        data: { ok: true, reference: row.id, receivedAt: row.createdAt.toISOString() },
      };
    } catch (error) {
      const status = (error as { getStatus?: () => number })?.getStatus?.();
      if (status === 429) {
        res.setHeader('Retry-After', '600');
      }
      throw error;
    }
  }
}
