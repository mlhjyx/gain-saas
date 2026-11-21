import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomUUID, randomBytes } from 'node:crypto';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import {
  invitationExpiry,
  isInvitationUsable,
  normalizeRole,
  validateEmail,
  validatePassword,
} from './auth.helpers.js';
import { SessionService } from './session.service.js';

/**
 * 注册 / 登录 / 登出 / 邀请(A1–A4)。
 * SD6:INVITE_CODE 配置时注册需邀请码(公开自助在 design partner 阶段不开放)。
 * 工作空间 UUID = 引擎租户 id;workspace_registry 同步登记(事件消费遍历用,SD4)。
 */
/**
 * 一企一空间（2026-11-21 产品决策）：企业名的归一化比对。
 * 归一化 = NFKC → 去全部空白 → 小写；"琏升科技股份有限公司1"这类后缀重复靠
 * 包含关系兜住（较短方 ≥6 字符，避免"11"vs"111"式测试名误伤；
 * "宁波市盛源鑫实业"与"东莞市盛源鑫实业"互不包含，正常放行）。
 */
export function normalizeCompanyName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export function findEnterpriseConflict(input: string, existing: readonly string[]): string | null {
  const a = normalizeCompanyName(input);
  if (!a) return null;
  for (const name of existing) {
    const b = normalizeCompanyName(name);
    if (!b) continue;
    if (a === b) return name;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.length >= 6 && longer.includes(shorter)) return name;
  }
  return null;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** 注册策略（公开）：邀请码仅在部署侧配置了 INVITE_CODE 时需要。 */
  registrationPolicy(): { inviteCodeRequired: boolean } {
    return { inviteCodeRequired: Boolean(this.config.INVITE_CODE) };
  }

  async register(input: Record<string, unknown>) {
    const email = validateEmail(input.email);
    const password = validatePassword(input.password);
    const companyName = typeof input.companyName === 'string' && input.companyName.trim() ? input.companyName.trim().slice(0, 128) : null;
    if (!email || !password || !companyName) {
      throw new UnauthorizedException({
        error: { code: 'VALIDATION_ERROR', message: '邮箱、密码(≥10 位含字母数字)与公司名称必填' },
      });
    }
    if (this.config.INVITE_CODE && input.inviteCode !== this.config.INVITE_CODE) {
      throw new UnauthorizedException({ error: { code: 'INVITE_CODE_INVALID', message: '邀请码无效' } });
    }
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new UnauthorizedException({ error: { code: 'EMAIL_TAKEN', message: '该邮箱已注册,请直接登录' } });
    }
    // 一企一空间：企业查重在下方的写入事务内(fail-fast;advisory lock 防并发同名)。
    const passwordHash = await argon2.hash(password);
    // 查重 + user + workspace 一个事务,并用 advisory lock 串行化同名企业:
    // 否则两个并发注册都能通过 findMany,各自建出重复空间(正是本功能要消灭的形态)。
    const { user, workspace } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${normalizeCompanyName(companyName)}))`;
      const activeWorkspaces = await tx.workspace.findMany({
        where: { status: 'ACTIVE' },
        select: { name: true, createdAt: true },
      });
      const conflict = findEnterpriseConflict(
        companyName,
        activeWorkspaces.map((w) => w.name),
      );
      if (conflict) {
        const hit = activeWorkspaces.find((w) => w.name === conflict)!;
        throw new ConflictException({
          error: { code: 'COMPANY_WORKSPACE_EXISTS', message: '该企业已开通工作空间,请通过邀请加入' },
          meta: {
            existingWorkspaceName: hit.name,
            existingCreatedAt: hit.createdAt.toISOString().slice(0, 10),
          },
        });
      }
      const createdUser = await tx.user.create({ data: { email, passwordHash } });
      // 工作空间 + 管理员成员 + 事件消费登记,同一事务
      const createdWorkspace = await tx.workspace.create({
        data: {
          id: randomUUID(),
          name: companyName,
          memberships: { create: { userId: createdUser.id, role: 'admin' } },
          registry: { create: {} },
        },
        include: { memberships: true },
      });
      return { user: createdUser, workspace: createdWorkspace };
    });
    await this.audit.record({ realm: 'tenant', actorId: user.id, action: 'auth.register', target: workspace.id, detail: { email } });
    const membership = workspace.memberships[0];
    const session = await this.sessions.issue(user.id, workspace.id, 'admin');
    return { user, workspace, membership, session };
  }

  async login(input: Record<string, unknown>) {
    const email = validateEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    if (!email || !password) {
      throw new UnauthorizedException({ error: { code: 'VALIDATION_ERROR', message: '邮箱与密码必填' } });
    }
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: { memberships: { where: { status: 'active' }, orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    const ok = user && (await argon2.verify(user.passwordHash, password));
    if (!user || !ok || user.memberships.length === 0) {
      // 统一文案,不区分"用户不存在/密码错"(防枚举)
      throw new UnauthorizedException({ error: { code: 'AUTH_FAILED', message: '邮箱或密码不正确' } });
    }
    if (user.status !== 'active') {
      throw new UnauthorizedException({ error: { code: 'AUTH_DISABLED', message: '账号已停用,请联系管理员' } });
    }
    const membership = user.memberships[0];
    await this.audit.record({ realm: 'tenant', actorId: user.id, action: 'auth.login', target: membership.workspaceId });
    const session = await this.sessions.issue(user.id, membership.workspaceId, membership.role as 'admin' | 'member');
    return { user, membership, session };
  }

  async changePassword(userId: string, currentJti: string, input: Record<string, unknown>): Promise<void> {
    const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : '';
    const newPassword = validatePassword(input.newPassword);
    if (!currentPassword || !newPassword) {
      throw new UnauthorizedException({
        error: { code: 'VALIDATION_ERROR', message: '新密码至少 10 位且包含字母与数字' },
      });
    }
    if (currentPassword === newPassword) {
      throw new UnauthorizedException({ error: { code: 'VALIDATION_ERROR', message: '新密码不能与旧密码相同' } });
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await argon2.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException({ error: { code: 'AUTH_FAILED', message: '旧密码不正确' } });
    }
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await argon2.hash(newPassword) } });
    // 改密后让其他设备上的会话失效，当前会话保留，避免用户被立刻登出。
    await this.prisma.session.updateMany({
      where: { realm: 'tenant', subjectType: 'user', subjectId: userId, jti: { not: currentJti }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({ realm: 'tenant', actorId: userId, action: 'auth.change_password' });
  }

  async logout(jti: string, userId: string): Promise<void> {
    await this.sessions.revoke(jti);
    await this.audit.record({ realm: 'tenant', actorId: userId, action: 'auth.logout' });
  }

  /** SD2:切换当前工作空间 —— 必须是本人有效成员资格,重发会话 cookie。 */
  async switchWorkspace(userId: string, jti: string, workspaceId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { userId, workspaceId, status: 'active' },
    });
    if (!membership) {
      throw new UnauthorizedException({ error: { code: 'NOT_A_MEMBER', message: '你不属于该工作空间' } });
    }
    await this.sessions.revoke(jti);
    await this.audit.record({ realm: 'tenant', actorId: userId, action: 'auth.switch_workspace', target: workspaceId });
    return this.sessions.issue(userId, workspaceId, membership.role as 'admin' | 'member');
  }

  async createInvitation(workspaceId: string, actorId: string, input: Record<string, unknown>) {
    const email = validateEmail(input.email);
    const role = normalizeRole(input.role);
    if (!email || !role) {
      throw new UnauthorizedException({ error: { code: 'VALIDATION_ERROR', message: '邮箱与角色必填' } });
    }
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      const alreadyMember = await this.prisma.membership.findFirst({ where: { workspaceId, userId: existingUser.id } });
      if (alreadyMember) {
        throw new UnauthorizedException({ error: { code: 'ALREADY_MEMBER', message: '该用户已是工作空间成员' } });
      }
    }
    const invitation = await this.prisma.invitation.create({
      data: { workspaceId, email, role, token: randomBytes(24).toString('hex'), expiresAt: invitationExpiry() },
    });
    await this.audit.record({ realm: 'tenant', actorId, action: 'members.invite', target: invitation.id, detail: { email, role } });
    return invitation;
  }

  async acceptInvitation(input: Record<string, unknown>) {
    const password = validatePassword(input.password);
    const token = typeof input.token === 'string' && input.token ? input.token : null;
    if (!token || !password) {
      throw new UnauthorizedException({ error: { code: 'VALIDATION_ERROR', message: '邀请链接无效或密码不合规(≥10 位含字母数字)' } });
    }
    const invitation = await this.prisma.invitation.findUnique({ where: { token } });
    if (!invitation || !isInvitationUsable(invitation)) {
      throw new UnauthorizedException({ error: { code: 'INVITE_INVALID', message: '邀请不存在、已使用或已过期' } });
    }
    let user = await this.prisma.user.findUnique({ where: { email: invitation.email } });
    if (!user) {
      user = await this.prisma.user.create({ data: { email: invitation.email, passwordHash: await argon2.hash(password) } });
    } else {
      const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
      if (!ok) {
        throw new UnauthorizedException({ error: { code: 'AUTH_FAILED', message: '该邮箱已存在,请用已有密码接受邀请' } });
      }
    }
    const membership = await this.prisma.membership.create({
      data: { userId: user.id, workspaceId: invitation.workspaceId, role: invitation.role },
    });
    await this.prisma.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
    await this.audit.record({
      realm: 'tenant',
      actorId: user.id,
      action: 'members.accept_invite',
      target: invitation.workspaceId,
      detail: { role: invitation.role },
    });
    const session = await this.sessions.issue(user.id, invitation.workspaceId, invitation.role as 'admin' | 'member');
    return { user, membership, session };
  }
}
