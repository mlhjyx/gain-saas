import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export const PRISMA_SERVICE_OPTIONS = Symbol('PRISMA_SERVICE_OPTIONS');

export interface PrismaServiceOptions {
  datasourceUrl?: string;
  enforcePrincipal?: boolean;
}

export interface AppDatabasePrincipalEvidence {
  currentUser: string;
  sessionUser: string;
  rolSuper: boolean;
  rolBypassRls: boolean;
  rolCreateDb: boolean;
  rolCreateRole: boolean;
  rolReplication: boolean;
  rolInherit: boolean;
  memberships: string[];
}

export const DATABASE_PRINCIPAL_QUERY = `
  SELECT
    current_user::text AS "currentUser",
    session_user::text AS "sessionUser",
    r.rolsuper AS "rolSuper",
    r.rolbypassrls AS "rolBypassRls",
    r.rolcreatedb AS "rolCreateDb",
    r.rolcreaterole AS "rolCreateRole",
    r.rolreplication AS "rolReplication",
    r.rolinherit AS "rolInherit",
    COALESCE(
      ARRAY(
        SELECT g.rolname::text
        FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid
        WHERE m.member = r.oid
      ),
      ARRAY[]::text[]
    ) AS "memberships"
  FROM pg_roles r
  WHERE r.rolname = current_user
`;

export function isAuthorizedAppDatabasePrincipal(
  evidence: AppDatabasePrincipalEvidence | null | undefined,
): boolean {
  if (!evidence) return false;
  return (
    evidence.sessionUser === 'gain_saas_app' &&
    evidence.currentUser === 'gain_saas_app' &&
    !evidence.rolSuper &&
    !evidence.rolBypassRls &&
    !evidence.rolCreateDb &&
    !evidence.rolCreateRole &&
    !evidence.rolReplication &&
    evidence.rolInherit &&
    Array.isArray(evidence.memberships) &&
    evidence.memberships.length === 0
  );
}

const UNAVAILABLE_APP_DATABASE_URL = 'postgresql://gain_saas_app@127.0.0.1:0/gain_saas';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkspaceScope {
  workspaceId: string;
  tx: Prisma.TransactionClient;
}

const workspaceStorage = new AsyncLocalStorage<WorkspaceScope>();

const OWN_METHODS = new Set([
  'withWorkspace',
  'health',
  'verifyPrincipal',
  'onModuleInit',
  'onModuleDestroy',
]);

/**
 * SaaS 自有库连接（运行时优先 APP_DATABASE_URL = gain_saas_app 非 owner 角色）。
 * 生产环境强制校验 principal 与 APP_DATABASE_URL；租户表查询/写入经 withWorkspace()
 * 在单事务内通过 set_config('app.current_workspace_id', wid, true) 注入 RLS 上下文，
 * 并由 AsyncLocalStorage + Proxy 透明绑定同上下文内的嵌套服务调用。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly shouldEnforcePrincipal: boolean;
  private principalVerified = false;

  constructor(
    @Optional()
    @Inject(PRISMA_SERVICE_OPTIONS)
    options?: PrismaServiceOptions,
  ) {
    const appUrl = options?.datasourceUrl?.trim() || process.env.APP_DATABASE_URL?.trim();
    const fallbackUrl =
      process.env.NODE_ENV !== 'production' ? process.env.DATABASE_URL?.trim() : undefined;
    const datasourceUrl = appUrl || fallbackUrl || UNAVAILABLE_APP_DATABASE_URL;
    super({ datasourceUrl });

    this.shouldEnforcePrincipal =
      options?.enforcePrincipal ??
      (process.env.NODE_ENV === 'production' || Boolean(process.env.APP_DATABASE_URL?.trim()));

    const target = this;
    return new Proxy(this, {
      get(obj, prop) {
        if (prop === 'then') return undefined;
        if (typeof prop === 'string' && OWN_METHODS.has(prop)) {
          const val = Reflect.get(obj, prop, obj);
          return typeof val === 'function' ? val.bind(obj) : val;
        }
        const store = workspaceStorage.getStore();
        if (store) {
          if (prop === '$transaction') {
            return (arg: unknown) => {
              if (typeof arg === 'function') {
                return (arg as (tx: Prisma.TransactionClient) => Promise<unknown>)(store.tx);
              }
              if (Array.isArray(arg)) {
                return Promise.all(arg);
              }
              throw new Error('Unsupported $transaction argument inside withWorkspace');
            };
          }
          if (
            prop === '$queryRaw' ||
            prop === '$queryRawUnsafe' ||
            prop === '$executeRaw' ||
            prop === '$executeRawUnsafe'
          ) {
            const txVal = Reflect.get(store.tx, prop, store.tx);
            return typeof txVal === 'function' ? txVal.bind(store.tx) : txVal;
          }
          if (
            typeof prop === 'string' &&
            !prop.startsWith('$') &&
            !prop.startsWith('_') &&
            prop in store.tx
          ) {
            return Reflect.get(store.tx, prop, store.tx);
          }
        }
        const val = Reflect.get(target, prop, target);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.shouldEnforcePrincipal) {
      await this.verifyPrincipal();
    }
  }

  async verifyPrincipal(): Promise<AppDatabasePrincipalEvidence> {
    const rows = await PrismaClient.prototype.$queryRawUnsafe.call(
      this,
      DATABASE_PRINCIPAL_QUERY,
    ) as AppDatabasePrincipalEvidence[];
    const evidence = rows[0];
    if (!isAuthorizedAppDatabasePrincipal(evidence)) {
      throw new Error(
        `DATABASE_PRINCIPAL_INVALID: expected non-privileged role gain_saas_app, got ${JSON.stringify(evidence ?? null)}`,
      );
    }
    this.principalVerified = true;
    return evidence;
  }

  async withWorkspace<T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
      throw new Error('INVALID_WORKSPACE_ID: workspaceId must be a valid UUID');
    }
    const normalizedId = workspaceId.toLowerCase();
    const current = workspaceStorage.getStore();
    if (current) {
      if (current.workspaceId !== normalizedId) {
        throw new Error(
          `CROSS_WORKSPACE_CONTEXT_VIOLATION: active=${current.workspaceId} requested=${normalizedId}`,
        );
      }
      return fn(current.tx);
    }
    if (this.shouldEnforcePrincipal && !this.principalVerified) {
      await this.verifyPrincipal();
    }
    return PrismaClient.prototype.$transaction.call(
      this,
      async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${normalizedId}, true)`;
        return workspaceStorage.run({ workspaceId: normalizedId, tx }, () => fn(tx));
      },
      options,
    ) as Promise<T>;
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      await PrismaClient.prototype.$queryRaw.call(this, Prisma.sql`SELECT 1`);
      if (this.shouldEnforcePrincipal) {
        await this.verifyPrincipal();
      }
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await PrismaClient.prototype.$disconnect
      .call(this)
      .catch((err: unknown) => this.logger.warn(`断开数据库连接失败: ${String(err)}`));
  }
}
