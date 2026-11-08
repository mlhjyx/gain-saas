/**
 * 用户信息适配层:GET /api/auth/session → vben UserInfo。
 * 身份链（v3.0 P5b-14）：realName 是「人」（姓名或邮箱前缀），公司名单独放在
 * workspaceName 上；顶栏与头像用公司名，问候/水印用人名——不再把公司名塞进 realName。
 */
import type { UserInfo } from '@vben/types';

import { requestClient } from '#/api/request';

export interface GainosUserInfo extends UserInfo {
  /** 当前公司显示名；顶栏与头像用。 */
  workspaceName?: string;
}

/** 生成品牌色首字头像(vben 默认取 alt 末两字,中文长名会得到"公司"这类无意义片段) */
function initialAvatar(name: string): string {
  const initial = (name.trim()[0] ?? 'G').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="36" fill="#00B96B"/><text x="36" y="38" text-anchor="middle" dominant-baseline="central" font-size="32" font-family="PingFang SC,Microsoft YaHei,system-ui,sans-serif" fill="#ffffff">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function personName(email: string): string {
  const prefix = (email.split('@')[0] ?? '').trim();
  return prefix || email;
}

interface SessionResponse {
  user: { email: string; id: string; name?: null | string };
  workspace: { id: string; role: 'admin' | 'member' };
  workspaces: Array<{ id: string; name: string; role: string }>;
}

export async function getUserInfoApi(): Promise<GainosUserInfo> {
  const session = await requestClient.get<SessionResponse>('/auth/session');
  const company =
    session.workspaces.find((w) => w.id === session.workspace.id)?.name ??
    '公司';
  const userInfo: GainosUserInfo = {
    userId: session.user.id,
    username: session.user.email,
    realName: session.user.name?.trim() || personName(session.user.email),
    workspaceName: company,
    roles: [session.workspace.role],
    avatar: initialAvatar(company),
    desc: '',
    homePath: '/workspace',
    token: '',
  };
  return userInfo;
}
