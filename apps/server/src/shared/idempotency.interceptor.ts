import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, from, of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import {
  IDEMPOTENCY_KEY_PATTERN,
  IdempotencyService,
} from './idempotency.service.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * BFF 幂等拦截器（P5b-05）：请求带 `Idempotency-Key` 时
 *  - 首次：正常执行，成功后存下 (status, body)；
 *  - 重放：直接返回首次的 (status, body)，不重复执行副作用；
 *  - 同键不同请求体：409 `IDEMPOTENCY_KEY_REUSED`。
 *
 * 只对租户域（`req.tenant` 存在）的变更方法生效；未带键的请求完全不受影响。
 * 路径 scope 用「方法 + 路由模板」而非原始 URL，避免 query 干扰重放匹配。
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const method = req.method.toUpperCase();
    if (!MUTATING.has(method)) return next.handle();

    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) return next.handle();
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        error: {
          code: 'IDEMPOTENCY_KEY_INVALID',
          message: 'Idempotency-Key 必须是 8–128 位的字母/数字/._:-',
        },
      });
    }
    const tenant = (req as Request & { tenant?: { workspaceId: string } })
      .tenant;
    if (!tenant) return next.handle();

    const routePath =
      (req.route?.path as string | undefined) ??
      req.originalUrl.split('?')[0] ??
      req.path;
    // scope 必须含真实路径参数:按路由模板聚合时,同一 key + 同空体会把资源 A 的
    // 响应重放给资源 B(B 永远不会执行)。req.params 在拦截器阶段已由控制器路由填充。
    const params = (req as Request & { params?: Record<string, string> }).params ?? {};
    const paramSuffix = Object.keys(params).sort().map((k) => `/${params[k]}`).join('');
    const scope = `${method} ${req.baseUrl ?? ''}${routePath}${paramSuffix}`;
    const requestHash = this.idempotency.requestHash(req.body);
    const workspaceId = tenant.workspaceId;

    return from(
      this.idempotency.lookup(workspaceId, scope, key),
    ).pipe(
      mergeMap((existing) => {
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException({
              error: {
                code: 'IDEMPOTENCY_KEY_REUSED',
                message:
                  '同一 Idempotency-Key 被用于不同的请求体；请为新请求生成新键',
              },
            });
          }
          res.status(existing.responseStatus);
          return of(existing.responseBody);
        }
        return next.handle().pipe(
          mergeMap((data) =>
            from(
              this.idempotency
                .save({
                  workspaceId,
                  scope,
                  key,
                  requestHash,
                  responseStatus: res.statusCode,
                  body: data ?? null,
                })
                .then((stored) => {
                  // 并发同键：另一个请求先落库；本次按重放返回已存响应。
                  if (stored.requestHash !== requestHash) {
                    throw new ConflictException({
                      error: {
                        code: 'IDEMPOTENCY_KEY_REUSED',
                        message:
                          '同一 Idempotency-Key 被用于不同的请求体；请为新请求生成新键',
                      },
                    });
                  }
                  return stored.responseBody;
                }),
            ),
          ),
        );
      }),
    );
  }
}
