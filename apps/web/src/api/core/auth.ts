/**
 * 认证 API 适配层(gain-saas 对接):
 * 后端合同 = POST /api/auth/login {email,password} → 信封 {data:{user,workspace,role}},
 * 会话凭据是 httpOnly Cookie(无 accessToken);vben 端用占位 token 满足其内部状态机,
 * 真实鉴权一律由 Cookie 完成(同源请求自动携带)。
 * 术语与文案见 packages/shared(PRD §14.2)。
 */
import { preferences } from '@vben/preferences';

import { baseRequestClient, requestClient } from '#/api/request';
import { newAttemptId } from '#/utils/attempt-id';

export const AUTH_SESSION_CHANGING_KEY = 'gainos.auth.session-changing';

function announceAuthChange(): void {
  try {
    window.localStorage.setItem(AUTH_SESSION_CHANGING_KEY, newAttemptId());
  } catch {
    // 浏览器在受限存储环境下仍可正常登录。
  }
}

export namespace AuthApi {
  /** 登录接口参数(界面 username 字段即邮箱) */
  export interface LoginParams {
    password?: string;
    username?: string;
  }

  /** vben 内部状态机需要 accessToken;gain-saas 为 Cookie 会话，给占位值 */
  export interface LoginResult {
    accessToken: string;
  }

  export interface RefreshTokenResult {
    data: string;
    status: number;
  }
}

/**
 * 登录(Cookie 会话)。必须走 baseRequestClient：登录失败返回的 401
 * 不能经过 authenticateResponseInterceptor，否则会被当成“会话过期”触发
 * refresh→logout→再次 401 的递归，页面一直停在提交中。
 */
export async function loginApi(data: AuthApi.LoginParams) {
  announceAuthChange();
  await baseRequestClient.post('/auth/login', {
    email: data.username,
    password: data.password,
  });
  return { accessToken: 'cookie-session' } as AuthApi.LoginResult;
}

/** 刷新 token:gain-saas 无此概念(滑动续期在服务端),保留占位不被登录流程调用 */
export async function refreshTokenApi() {
  return baseRequestClient.post<AuthApi.RefreshTokenResult>(
    '/auth/refresh',
    undefined,
    { withCredentials: true },
  );
}

/** 退出登录(撤销服务端会话)。同样绕开会话过期拦截器，避免登出失败时递归。 */
export async function logoutApi() {
  announceAuthChange();
  return baseRequestClient.post('/auth/logout');
}

/**
 * 改密：校验旧密码，保留当前会话并撤销其他设备会话。
 * 必须走 baseRequestClient：输错旧密码时服务端返回 HTTP 401，不能经过 requestClient
 * 的会话过期拦截器，否则会把用户直接踢回登录页（Review Focus #7）。
 */
export async function changePasswordApi(data: { currentPassword: string; newPassword: string }) {
  return baseRequestClient.post('/auth/password', data, {
    headers: { 'Accept-Language': preferences.app.locale },
    withCredentials: true,
  });
}

/**
 * 权限码：由角色推导(PRD §2.2 admin/member 两档)。
 * 管理员专属操作(认领审批/制裁复核/导出等)在 BFF 侧由 AdminGuard 强制,
 * 前端 code 只用于界面显隐。
 */
export async function getAccessCodesApi() {
  const session = await requestClient.get<{ workspace: { role: string } }>('/auth/session');
  return session.workspace.role === 'admin' ? ['ADMIN'] : [];
}

/** 注册(创建工作空间；内测阶段可能需要邀请码,SD6) */
export async function registerApi(data: {
  companyName: string;
  email: string;
  password: string;
  inviteCode?: string;
}) {
  announceAuthChange();
  return requestClient.post<unknown>('/auth/register', data);
}

/** 接受邀请(带 token 的链接进入；只设密码即加入) */
export async function acceptInviteApi(data: { token: string; password: string }) {
  announceAuthChange();
  return requestClient.post<unknown>('/auth/accept-invite', data);
}
