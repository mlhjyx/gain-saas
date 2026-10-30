import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/** 引擎到网关的 Bearer 鉴权;与 ops 会话完全分离。 */
@Injectable()
export class ModelGatewayAuthGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.MODEL_GATEWAY_API_KEY;
    if (!expected) {
      throw new ServiceUnavailableException({
        error: { message: '模型网关未启用:配置 MODEL_GATEWAY_API_KEY 后重启', type: 'gateway_error', code: 'gateway_disabled' },
      });
    }
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const expectedBuffer = Buffer.from(expected);
    const tokenBuffer = Buffer.from(token);
    if (tokenBuffer.length !== expectedBuffer.length || !timingSafeEqual(tokenBuffer, expectedBuffer)) {
      throw new UnauthorizedException({
        error: { message: '网关 Key 无效', type: 'invalid_request_error', code: 'invalid_api_key' },
      });
    }
    return true;
  }
}
