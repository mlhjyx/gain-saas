import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * 归因真库测试共用的一次性 PostgreSQL 供应器（M2 步 12-1/12-3）。
 *
 * - 本机用 default docker context（显式注入，不影响宿主其它项目）；
 * - docker 不可用时本机跳过、CI 直接失败（真库验收不允许静默通过）；
 * - 镜像按 digest 钉住（/global/CLAUDE.md「镜像一律按 digest 钉住」）。
 */
const dockerEnv = { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? 'default' };
// vitest 以包目录（apps/server）为 root 运行；不走 import.meta（server 的 tsconfig 是 CJS，
// 本文件不属于 *.test.ts 排除面，编译期不允许 import.meta）。
const serverDir = process.cwd();
const prismaBin = `${serverDir}/node_modules/.bin/prisma`;

export const POSTGRES_TEST_IMAGE =
  'postgres:16-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139';

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
  readonly databaseUrl: string;
  stop(): void;
}

/** 起容器 → 等 TCP 就绪（socket 探针会在 init 阶段假就绪）→ 全量迁移。 */
export function startDisposablePostgres(): DisposablePostgres {
  const containerName = `gain-attribution-${process.pid}-${randomUUID().slice(0, 8)}`;
  execFileSync(
    'docker',
    [
      'run', '-d', '--name', containerName,
      '-e', 'POSTGRES_PASSWORD=attribution-test',
      '-p', '127.0.0.1::5432',
      POSTGRES_TEST_IMAGE,
    ],
    { env: dockerEnv, stdio: 'ignore' },
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 300 && !ready; attempt += 1) {
      try {
        execFileSync(
          'docker',
          [
            'exec', containerName,
            'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres',
          ],
          { env: dockerEnv, stdio: 'ignore' },
        );
        ready = true;
      } catch {
        // 同步等待：供应器只在 beforeAll 内调用，阻塞即预期行为。
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
      }
    }
    if (!ready) throw new Error('disposable postgres did not become ready');

    const portMapping = execFileSync('docker', ['port', containerName, '5432/tcp'], { env: dockerEnv })
      .toString()
      .trim()
      .split('\n')[0]!;
    const port = portMapping.slice(portMapping.lastIndexOf(':') + 1);
    const databaseUrl = `postgresql://postgres:attribution-test@127.0.0.1:${port}/postgres`;

    try {
      execFileSync(prismaBin, ['migrate', 'deploy'], {
        cwd: serverDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8') ?? '';
      throw new Error(`prisma migrate deploy failed: ${stderr || String(error)}`);
    }

    return {
      databaseUrl,
      stop: () => {
        try {
          execFileSync('docker', ['rm', '-f', containerName], { env: dockerEnv, stdio: 'ignore' });
        } catch {
          /* 容器已被移除 */
        }
      },
    };
  } catch (error) {
    try {
      execFileSync('docker', ['rm', '-f', containerName], { env: dockerEnv, stdio: 'ignore' });
    } catch {
      /* 容器已被移除 */
    }
    throw error;
  }
}
