import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * 归因真库测试共用的一次性 PostgreSQL 供应器（M2 步 12-1/12-3）。
 *
 * - 本机用 default docker context（显式注入，不影响宿主其它项目）；
 * - docker 不可用时本机跳过、CI 直接失败（真库验收不允许静默通过）；
 * - 镜像按 digest 钉住（/global/CLAUDE.md「镜像一律按 digest 钉住」）；
 * - 强制 `--rm` 与 `--memory=512m` 内存上限，并在启动任意阶段失败或进程收到
 *   `SIGINT`/`SIGTERM`/`exit` 时幂等清理容器，正常 `stop()` 后精确注销进程监听器，
 *   防止测试超时/中断泄漏孤儿 Postgres 容器拖垮宿主机。
 */
const dockerEnv = { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? 'default' };
// vitest 以包目录（apps/server）为 root 运行；不走 import.meta（server 的 tsconfig 是 CJS，
// 本文件不属于 *.test.ts 排除面，编译期不允许 import.meta）。
const serverDir = process.cwd();
const prismaBin = `${serverDir}/node_modules/.bin/prisma`;

export const POSTGRES_TEST_IMAGE =
  'postgres:16-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139';
export const POSTGRES_TEST_MEMORY_LIMIT = '512m';

export type DisposablePostgresSignal = 'SIGINT' | 'SIGTERM';

export interface DisposablePostgresProcessLike {
  readonly pid: number;
  on(event: 'exit' | DisposablePostgresSignal, listener: (...args: unknown[]) => void): unknown;
  off(event: 'exit' | DisposablePostgresSignal, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: DisposablePostgresSignal): number;
  kill(pid: number, signal: DisposablePostgresSignal): unknown;
}

export interface DisposablePostgresDeps {
  execFileSync: (
    file: string,
    args: readonly string[],
    options?: ExecFileSyncOptions,
  ) => string | Buffer;
  proc: DisposablePostgresProcessLike;
  sleepMs: (ms: number) => void;
  maxReadyAttempts: number;
  readyPollIntervalMs: number;
}

function defaultSleepMs(ms: number): void {
  // 同步等待：供应器只在 beforeAll 内调用，阻塞即预期行为。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function dockerAvailable(): boolean {
  try {
    // 高负载主机上 docker info 可能超过 10s（本机 load 40+ 实测），放宽到 60s。
    execFileSync('docker', ['info'], { env: dockerEnv, stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

export interface DisposablePostgres {
  readonly containerName: string;
  readonly databaseUrl: string;
  readonly appDatabaseUrl: string;
  stop(): void;
}

/** 起容器 → 等 TCP 就绪（socket 探针会在 init 阶段假就绪）→ 全量迁移。 */
export function startDisposablePostgres(
  deps: Partial<DisposablePostgresDeps> = {},
): DisposablePostgres {
  const run =
    deps.execFileSync ??
    ((file: string, args: readonly string[], options?: ExecFileSyncOptions) =>
      execFileSync(file, args, options));
  const proc: DisposablePostgresProcessLike = deps.proc ?? process;
  const sleepMs = deps.sleepMs ?? defaultSleepMs;
  const maxReadyAttempts = deps.maxReadyAttempts ?? 300;
  const readyPollIntervalMs = deps.readyPollIntervalMs ?? 2_000;

  const containerName = `gain-attribution-${proc.pid}-${randomUUID().slice(0, 8)}`;

  let cleanedUp = false;
  let hooksRegistered = false;

  const removeContainer = (): void => {
    try {
      run('docker', ['rm', '-f', containerName], {
        env: dockerEnv,
        stdio: 'ignore',
        timeout: 30_000,
      });
    } catch {
      /* 容器尚未创建或已被移除 */
    }
  };

  const unregisterHooks = (): void => {
    if (!hooksRegistered) return;
    hooksRegistered = false;
    proc.off('exit', onExit);
    proc.off('SIGINT', onSigInt);
    proc.off('SIGTERM', onSigTerm);
  };

  const cleanup = (): void => {
    unregisterHooks();
    if (cleanedUp) return;
    cleanedUp = true;
    removeContainer();
  };

  const onExit = (): void => {
    cleanup();
  };

  const handleSignal = (signal: DisposablePostgresSignal): void => {
    cleanup();
    // 若进程内已无其他信号监听器（独立脚本场景），重发原信号保持默认退出语义；
    // Vitest 托管场景下其自有信号处理器会接管并正常退出，避免重复强杀。
    if (proc.listenerCount(signal) === 0) {
      proc.kill(proc.pid, signal);
    }
  };

  const onSigInt = (): void => handleSignal('SIGINT');
  const onSigTerm = (): void => handleSignal('SIGTERM');

  // 先挂退出/中断钩子再启动容器，确保 docker run 或迁移中途被中断也能清理孤儿容器。
  proc.on('exit', onExit);
  proc.on('SIGINT', onSigInt);
  proc.on('SIGTERM', onSigTerm);
  hooksRegistered = true;

  try {
    run(
      'docker',
      [
        'run', '-d', '--rm',
        `--memory=${POSTGRES_TEST_MEMORY_LIMIT}`,
        '--name', containerName,
        '-e', 'POSTGRES_PASSWORD=attribution-test',
        '-p', '127.0.0.1::5432',
        POSTGRES_TEST_IMAGE,
      ],
      { env: dockerEnv, stdio: 'ignore' },
    );

    let ready = false;
    for (let attempt = 0; attempt < maxReadyAttempts && !ready; attempt += 1) {
      try {
        run(
          'docker',
          [
            'exec', containerName,
            'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres',
          ],
          { env: dockerEnv, stdio: 'ignore' },
        );
        ready = true;
      } catch {
        sleepMs(readyPollIntervalMs);
      }
    }
    if (!ready) throw new Error('disposable postgres did not become ready');

    const portMapping =
      run('docker', ['port', containerName, '5432/tcp'], { env: dockerEnv })
        .toString()
        .trim()
        .split('\n')[0] ?? '';
    const port = portMapping.slice(portMapping.lastIndexOf(':') + 1);
    if (!/^\d+$/.test(port)) {
      throw new Error(`disposable postgres returned invalid port mapping: ${portMapping}`);
    }
    const databaseUrl = `postgresql://postgres:attribution-test@127.0.0.1:${port}/postgres`;

    try {
      run(prismaBin, ['migrate', 'deploy'], {
        cwd: serverDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8') ?? '';
      throw new Error(`prisma migrate deploy failed: ${stderr || String(error)}`);
    }

    const appRolePassword = `rls-test-${randomUUID().slice(0, 12)}`;
    run(
      'docker',
      [
        'exec', containerName,
        'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
        '-c', `ALTER ROLE gain_saas_app WITH LOGIN PASSWORD '${appRolePassword}';`,
      ],
      { env: dockerEnv, stdio: 'pipe' },
    );
    const appDatabaseUrl = `postgresql://gain_saas_app:${appRolePassword}@127.0.0.1:${port}/postgres`;

    return {
      containerName,
      databaseUrl,
      appDatabaseUrl,
      stop: cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
