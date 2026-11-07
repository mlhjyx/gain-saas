import { BadRequestException, ForbiddenException, HttpException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from './http-exception.filter.js';

function host(res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }): ArgumentsHost {
  return {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
}

function makeRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status, json }, status, json };
}

describe('GlobalHttpExceptionFilter：SaaS 自抛错统一挂三层文案（P5）', () => {
  it('只有 error.code 时按词表补 userCopy（NO_APPROVED_CLAIMS）', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { res, status, json } = makeRes();
    filter.catch(
      new BadRequestException({ error: { code: 'NO_APPROVED_CLAIMS', message: '先审批事实' } }),
      host(res),
    );
    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0]![0] as { error: { code: string; userCopy: { title: string; why: string; next: string } } };
    expect(body.error.code).toBe('NO_APPROVED_CLAIMS');
    expect(body.error.userCopy.title).toContain('企业事实');
    expect(body.error.userCopy.why).toBeTruthy();
    expect(body.error.userCopy.next).toContain('事实');
  });

  it('未登记码也补 fallback 三层文案（而不是裸 message）', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { res, json } = makeRes();
    filter.catch(new ForbiddenException({ error: { code: 'SOME_FUTURE_CODE', message: 'x' } }), host(res));
    const body = json.mock.calls[0]![0] as { error: { userCopy?: { title?: string } } };
    expect(body.error.userCopy?.title).toBeTruthy();
  });

  it('已有 userCopy（如引擎映射）不被覆盖', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { res, json } = makeRes();
    filter.catch(
      new BadRequestException({
        error: { code: 'SUPPRESSED', userCopy: { title: '自定义标题', why: 'w', next: 'n' } },
      }),
      host(res),
    );
    const body = json.mock.calls[0]![0] as { error: { userCopy: { title: string } } };
    expect(body.error.userCopy.title).toBe('自定义标题');
  });

  it('非对象响应（字符串）原样透出', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { res, json } = makeRes();
    filter.catch(new HttpException('forbidden', 403), host(res));
    expect(json).toHaveBeenCalledWith('forbidden');
  });

  it('未捕获异常 → 500 INTERNAL 且带可读文案', () => {
    const filter = new GlobalHttpExceptionFilter();
    const { res, status, json } = makeRes();
    filter.catch(new Error('boom'), host(res));
    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]![0] as { error: { code: string; userCopy: { title: string } } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.userCopy.title).toContain('系统');
  });
});
