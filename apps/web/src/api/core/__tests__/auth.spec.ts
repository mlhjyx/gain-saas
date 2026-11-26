import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { basePostMock, requestPostMock } = vi.hoisted(() => ({
  basePostMock: vi.fn(),
  requestPostMock: vi.fn(),
}));

vi.mock('#/api/request', () => ({
  baseRequestClient: {
    post: basePostMock,
  },
  requestClient: {
    get: vi.fn(),
    post: requestPostMock,
  },
}));

vi.mock('@vben/preferences', () => ({
  preferences: {
    app: {
      locale: 'zh-CN',
    },
  },
}));

import { changePasswordApi } from '../auth';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj)
    .flatMap(([key, value]) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? flattenKeys(value as Record<string, unknown>, prefix ? `${prefix}.${key}` : key)
        : [prefix ? `${prefix}.${key}` : key],
    )
    .sort();
}

describe('auth.changePasswordApi（Review Focus #7）与 gainosB3 文案对称性', () => {
  beforeEach(() => {
    basePostMock.mockReset();
    requestPostMock.mockReset();
  });

  it('changePasswordApi 必须走 baseRequestClient（绝不经过 requestClient 触发 401 登出拦截器）', async () => {
    const payload = { currentPassword: 'WrongPassword1', newPassword: 'NewPassword2026' };
    basePostMock.mockResolvedValueOnce({ data: { ok: true } });

    await changePasswordApi(payload);

    expect(basePostMock).toHaveBeenCalledTimes(1);
    expect(basePostMock).toHaveBeenCalledWith(
      '/auth/password',
      payload,
      expect.objectContaining({
        headers: expect.objectContaining({ 'Accept-Language': 'zh-CN' }),
        withCredentials: true,
      }),
    );
    expect(requestPostMock).not.toHaveBeenCalled();
  });

  it('输错旧密码返回 HTTP 401 时由 baseRequestClient 原样抛出给页面处理', async () => {
    const err401 = {
      isAxiosError: true,
      response: {
        data: { error: { code: 'AUTH_FAILED', message: '旧密码不正确' } },
        status: 401,
      },
    };
    basePostMock.mockRejectedValueOnce(err401);

    await expect(
      changePasswordApi({ currentPassword: 'Wrong12345', newPassword: 'ValidPass123' }),
    ).rejects.toEqual(err401);
    expect(requestPostMock).not.toHaveBeenCalled();
  });

  it('gainosB3.json 中英文键 100% 对称', () => {
    const zh = JSON.parse(
      readFileSync(resolve(__dirname, '../../../locales/langs/zh-CN/gainosB3.json'), 'utf8'),
    ) as Record<string, unknown>;
    const en = JSON.parse(
      readFileSync(resolve(__dirname, '../../../locales/langs/en-US/gainosB3.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(flattenKeys(zh)).toEqual(flattenKeys(en));
  });
});
