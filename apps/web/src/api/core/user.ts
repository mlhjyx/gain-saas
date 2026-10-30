/**
 * 用户信息适配层:GET /api/auth/session → vben UserInfo。
 * realName 显示工作空间(公司)名，让顶栏直接呈现"我在哪家公司的工作空间"。
 */
import type { UserInfo } from '@vben/types';

import { requestClient } from '#/api/request';

/** 生成品牌色首字头像(vben 默认取 alt 末两字,中文长名会得到"公司"这类无意义片段) */
function initialAvatar(name: string): string {
  const initial = (name.trim()[0] ?? 'G').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" rx="36" fill="#00B96B"/><text x="36" y="38" text-anchor="middle" dominant-baseline="central" font-size="32" font-family="PingFang SC,Microsoft YaHei,system-ui,sans-serif" fill="#ffffff">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface SessionResponse {
  user: { email: string; id: string };
  workspace: { id: string; role: 'admin' | 'member' };
  workspaces: Array<{ id: string; name: string; role: string }>;
}

export async function getUserInfoApi() {
  const session = await requestClient.get<SessionResponse>('/auth/session');
  const current =
    session.workspaces.find((w) => w.id === session.workspace.id)?.name ??
    '工作空间';
  const userInfo: UserInfo = {
    userId: session.user.id,
    username: session.user.email,
    realName: current,
    roles: [session.workspace.role],
    avatar: initialAvatar(current),
    desc: '',
    homePath: '/workspace',
    token: '',
  };
  return userInfo;
}
