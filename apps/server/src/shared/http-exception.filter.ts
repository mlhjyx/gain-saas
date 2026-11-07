import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { copyForError } from '@gain-saas/shared';

/**
 * 全局异常出口:所有未捕获错误统一为 ClientErrorBody(PRD §14.4 三层文案 + 技术详情)。
 * HttpException 原样透出;若响应带 error.code 却没有 userCopy(SaaS 自抛错的常态),
 * 按 packages/shared 词表补三层文案——一处覆盖 guard/控制器/引导等全部自抛错。
 */
function withUserCopy(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as { error?: { code?: unknown; userCopy?: unknown } };
  const error = record.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return body;
  if (typeof error.code !== 'string' || error.userCopy !== undefined) return body;
  const copy = copyForError(error.code);
  return {
    ...record,
    error: { ...error, userCopy: { title: copy.title, why: copy.why, next: copy.next } },
  };
}

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(withUserCopy(exception.getResponse()));
      return;
    }
    const copy = copyForError('INTERNAL');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: 'INTERNAL',
        userCopy: { title: copy.title, why: copy.why, next: copy.next },
      },
      meta: { engineCode: 'INTERNAL', engineMessage: exception instanceof Error ? exception.message : String(exception) },
    });
  }
}
