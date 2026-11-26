/**
 * 该文件可自行根据业务逻辑进行调整
 */
import type { RequestClientOptions } from '@vben/request';

import { useAppConfig } from '@vben/hooks';
import { preferences } from '@vben/preferences';
import {
  authenticateResponseInterceptor,
  errorMessageResponseInterceptor,
  RequestClient,
} from '@vben/request';
import { useAccessStore } from '@vben/stores';


import { $t } from '#/locales';
import { feedback } from '#/feedback';
import { useAuthStore } from '#/store';

import { refreshTokenApi } from './core';
import { httpFailureCopy } from './failure-copy';

const { apiURL } = useAppConfig(import.meta.env, import.meta.env.PROD);

function createRequestClient(baseURL: string, options?: RequestClientOptions) {
  const client = new RequestClient({
    ...options,
    baseURL,
    // 模型生成类接口（ICP/查询计划/接触草稿）在 BFF 侧最长 240s；
    // vben 默认 10s 会先超时，导致后端已成功、前端却报失败并浪费一次性 Grant。
    timeout: 240_000,
  });

  /**
   * 重新认证逻辑
   */
  async function doReAuthenticate() {
    console.warn('Access token or refresh token is invalid or expired. ');
    const accessStore = useAccessStore();
    const authStore = useAuthStore();
    accessStore.setAccessToken(null);
    if (
      preferences.app.loginExpiredMode === 'modal' &&
      accessStore.isAccessChecked
    ) {
      accessStore.setLoginExpired(true);
    } else {
      await authStore.logout();
    }
  }

  /**
   * 刷新token逻辑
   */
  async function doRefreshToken() {
    const accessStore = useAccessStore();
    const resp = await refreshTokenApi();
    const newToken = resp.data;
    accessStore.setAccessToken(newToken);
    return newToken;
  }

  function formatToken(token: null | string) {
    return token ? `Bearer ${token}` : null;
  }

  // 请求头处理
  client.addRequestInterceptor({
    fulfilled: async (config) => {
      const accessStore = useAccessStore();

      config.headers.Authorization = formatToken(accessStore.accessToken);
      config.headers['Accept-Language'] = preferences.app.locale;
      return config;
    },
  });

  // 处理返回的响应数据格式:gain-saas 信封 { data, ... } / 失败 { error:{code,userCopy}, meta }
  // 成功(HTTP 2xx)→ 解包 data;错误走 reject 链，由下方 errorMessage 拦截器呈现三层文案
  client.addResponseInterceptor({
    fulfilled: (response) => {
      const body = response?.data;
      if (body && typeof body === 'object' && 'error' in body) {
        // HTTP 2xx 但带 error 信封(不应发生，防御)
        return Promise.reject(new Error(body.error?.userCopy?.title ?? '请求失败'));
      }
      return body && typeof body === 'object' && 'data' in body ? body.data : body;
    },
  });

  // token过期的处理
  client.addResponseInterceptor(
    authenticateResponseInterceptor({
      client,
      doReAuthenticate,
      doRefreshToken,
      // gain-saas 是 Cookie 滑动会话，没有 refresh-token 端点；开启会让 401 走
      // refresh→404→logout 的无效链路（登录失败时尤其明显）。
      enableRefreshToken: false,
      formatToken,
    }),
  );

  // 通用的错误处理：取后端三层文案(PRD §14.4 发生了什么/为什么/怎么办),没有则按状态码
  client.addResponseInterceptor(
    errorMessageResponseInterceptor((_msg, error) => {
      const url = String(error?.config?.url ?? '');
      // 登录/注册/邀请页自己展示行内错误，不再叠加全局 toast。
      if (url.includes('/auth/login') || url.includes('/auth/register') || url.includes('/auth/accept-invite')) {
        return;
      }
      const isMarketRequest = error?.config?.marketCandidateRequest === true;
      const responseCode = error?.response?.data?.error?.code;
      const responseStatus = error?.response?.status;
      const requestMethod = String(error?.config?.method ?? '').toUpperCase();
      let requestPath = '';
      try {
        requestPath = new URL(String(error?.config?.url ?? ''), 'http://local').pathname;
      } catch {
        requestPath = '';
      }
      // 仅初始 prepare 的 400 + 两个精确码由市场候选面板独占行内通知；不吞 cold-read/execute/recover/feedback/5xx。
      if (
        isMarketRequest &&
        error?.config?.marketPrepareNotify === true &&
        requestMethod === 'POST' &&
        responseStatus === 400 &&
        (responseCode === 'VALIDATION_ERROR' || responseCode === 'NO_APPROVED_CLAIMS') &&
        /^\/companies\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/market-candidate-generations$/.test(
          requestPath,
        )
      ) {
        return;
      }
      const userCopy = error?.response?.data?.error?.userCopy;
      // 引擎对接未就绪(502 降级)由各页面就地说明;市场候选请求不靠中文标题子串判断通知归属。
      if (
        !isMarketRequest &&
        (userCopy?.title?.includes('服务授权') || userCopy?.title?.includes('Service authorization'))
      ) {
        return;
      }
      if (userCopy?.title) {
        feedback.message.error(
          userCopy.next ? `${userCopy.title}——${userCopy.next}` : userCopy.title,
        );
        return;
      }
      if (isMarketRequest) {
        feedback.message.error(
          `${$t('gainos.marketCandidates.errorFallbackTitle')}——${$t('gainos.marketCandidates.errorFallbackNext')}`,
        );
        return;
      }
      // 没有三层文案时（网关 502、断网等）按状态码给本语言的说明；
      // 以前会把响应里的英文原文或 axios 的英文消息直接弹出来。
      const copy = httpFailureCopy(error);
      feedback.message.error(copy.next ? `${copy.title}——${copy.next}` : copy.title);
    }),
  );

  return client;
}

export const requestClient = createRequestClient(apiURL, {
  responseReturn: 'data',
});

export const baseRequestClient = new RequestClient({ baseURL: apiURL });
