import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { copyForError } from '@gain-saas/shared';

/**
 * 全局异常出口:所有未捕获错误统一为 ClientErrorBody(PRD §14.4 三层文案 + 技术详情)。
 * 我们自己抛的 HttpException(401/403/404 等)已是 { error: {...} } 形态,原样透出。
 */
@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(exception.getResponse());
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
