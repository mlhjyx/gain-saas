import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  POSTGRES_TEST_IMAGE,
  POSTGRES_TEST_MEMORY_LIMIT,
  startDisposablePostgres,
  type DisposablePostgresProcessLike,
  type DisposablePostgresSignal,
} from './attribution-test-pg.js';

class FakeProcess extends EventEmitter implements DisposablePostgresProcessLike {
  readonly pid = 424242;
  readonly kill = vi.fn((_pid: number, _signal: DisposablePostgresSignal) => true);
}

function makeFakeExec(overrides: {
  failOn?: 'run' | 'pg_isready' | 'port' | 'migrate' | 'alter_role';
} = {}) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execFileSync = vi.fn((file: string, args: readonly string[]) => {
    calls.push({ file, args });
    if (file === 'docker' && args[0] === 'run') {
      if (overrides.failOn === 'run') throw new Error('docker run failed');
      return Buffer.from('container-id\n');
    }
    if (file === 'docker' && args[0] === 'exec' && args.includes('pg_isready')) {
      if (overrides.failOn === 'pg_isready') throw new Error('not ready');
      return Buffer.from('accepting connections\n');
    }
    if (file === 'docker' && args[0] === 'port') {
      if (overrides.failOn === 'port') return Buffer.from('invalid-port-output');
      return Buffer.from('127.0.0.1:45432\n');
    }
    if (file.endsWith('/prisma') && args[0] === 'migrate') {
      if (overrides.failOn === 'migrate') {
        const err = new Error('migrate failed') as Error & { stderr?: Buffer };
        err.stderr = Buffer.from('P3009 migration failed');
        throw err;
      }
      return Buffer.from('Applied all migrations\n');
    }
    if (file === 'docker' && args[0] === 'exec' && args.includes('psql')) {
      if (overrides.failOn === 'alter_role') throw new Error('alter role failed');
      return Buffer.from('ALTER ROLE\n');
    }
    if (file === 'docker' && args[0] === 'rm') {
      return Buffer.from('removed\n');
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  });
  return { execFileSync, calls };
}

describe('startDisposablePostgres 容器内存上限、失败兜底与进程信号清理', () => {
  it('启动命令强制携带 --rm 与 --memory=512m，正常 stop() 幂等清容器并精确注销全部监听器', () => {
    const proc = new FakeProcess();
    const { execFileSync, calls } = makeFakeExec();

    const pg = startDisposablePostgres({ execFileSync, proc, sleepMs: vi.fn() });

    expect(pg.containerName).toMatch(/^gain-attribution-424242-[0-9a-f]{8}$/);
    expect(pg.databaseUrl).toBe('postgresql://postgres:attribution-test@127.0.0.1:45432/postgres');
    expect(pg.appDatabaseUrl).toMatch(/^postgresql:\/\/gain_saas_app:rls-test-[0-9a-f-]+@127\.0\.0\.1:45432\/postgres$/);

    const runCall = calls.find((c) => c.file === 'docker' && c.args[0] === 'run');
    expect(runCall?.args).toContain('--rm');
    expect(runCall?.args).toContain(`--memory=${POSTGRES_TEST_MEMORY_LIMIT}`);
    expect(runCall?.args).toContain(POSTGRES_TEST_IMAGE);

    expect(proc.listenerCount('exit')).toBe(1);
    expect(proc.listenerCount('SIGINT')).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(1);

    // 首次 stop() 清理容器并注销监听器；重复 stop() 幂等不再重复调 docker rm
    pg.stop();
    pg.stop();

    const rmCalls = calls.filter((c) => c.file === 'docker' && c.args[0] === 'rm');
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0]!.args).toEqual(['rm', '-f', pg.containerName]);
    expect(proc.listenerCount('exit')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  it('连续启动与停止 20 次不累积监听器，不会触发 MaxListenersExceededWarning', () => {
    const proc = new FakeProcess();
    proc.setMaxListeners(10);
    const warnSpy = vi.spyOn(process, 'emitWarning');
    try {
      for (let i = 0; i < 20; i += 1) {
        const { execFileSync } = makeFakeExec();
        const pg = startDisposablePostgres({ execFileSync, proc, sleepMs: vi.fn() });
        pg.stop();
      }
      expect(proc.listenerCount('exit')).toBe(0);
      expect(proc.listenerCount('SIGINT')).toBe(0);
      expect(proc.listenerCount('SIGTERM')).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    ['docker run 失败', 'run', /docker run failed/],
    ['pg_isready 就绪超时', 'pg_isready', /did not become ready/],
    ['docker port 输出非法', 'port', /invalid port mapping/],
    ['prisma migrate deploy 失败', 'migrate', /P3009 migration failed/],
    ['ALTER ROLE 失败', 'alter_role', /alter role failed/],
  ] as const)('启动任意阶段失败（%s）均必清理容器并注销信号钩子后再抛错', (_label, failOn, expectedErr) => {
    const proc = new FakeProcess();
    const { execFileSync, calls } = makeFakeExec({ failOn });
    const sleepMs = vi.fn();

    expect(() =>
      startDisposablePostgres({
        execFileSync,
        proc,
        sleepMs,
        maxReadyAttempts: 3,
        readyPollIntervalMs: 10,
      }),
    ).toThrow(expectedErr);

    const rmCalls = calls.filter((c) => c.file === 'docker' && c.args[0] === 'rm');
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0]!.args[0]).toBe('rm');
    expect(rmCalls[0]!.args[1]).toBe('-f');
    expect(rmCalls[0]!.args[2]).toMatch(/^gain-attribution-424242-/);

    expect(proc.listenerCount('exit')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  it('进程收到 exit / SIGINT / SIGTERM 时幂等清理容器；无其他监听器时重发信号，存在托管监听器时不抢杀', () => {
    // 1. exit 钩子清理容器
    {
      const proc = new FakeProcess();
      const { execFileSync, calls } = makeFakeExec();
      const pg = startDisposablePostgres({ execFileSync, proc, sleepMs: vi.fn() });

      proc.emit('exit', 1);
      pg.stop(); // 幂等不再重复 rm

      const rmCalls = calls.filter((c) => c.file === 'docker' && c.args[0] === 'rm');
      expect(rmCalls).toHaveLength(1);
      expect(rmCalls[0]!.args).toEqual(['rm', '-f', pg.containerName]);
      expect(proc.kill).not.toHaveBeenCalled();
    }

    // 2. 独立进程收到 SIGINT（无其他监听器）：清容器 + 注销钩子 + 重发 SIGINT
    {
      const proc = new FakeProcess();
      const { execFileSync, calls } = makeFakeExec();
      const pg = startDisposablePostgres({ execFileSync, proc, sleepMs: vi.fn() });

      proc.emit('SIGINT');

      const rmCalls = calls.filter((c) => c.file === 'docker' && c.args[0] === 'rm');
      expect(rmCalls).toHaveLength(1);
      expect(rmCalls[0]!.args).toEqual(['rm', '-f', pg.containerName]);
      expect(proc.listenerCount('SIGINT')).toBe(0);
      expect(proc.kill).toHaveBeenCalledWith(proc.pid, 'SIGINT');
    }

    // 3. Vitest 托管进程收到 SIGTERM（已有宿主监听器）：清容器 + 注销自身，不重复 kill
    {
      const proc = new FakeProcess();
      const hostHandler = vi.fn();
      proc.on('SIGTERM', hostHandler);
      const { execFileSync, calls } = makeFakeExec();
      const pg = startDisposablePostgres({ execFileSync, proc, sleepMs: vi.fn() });

      proc.emit('SIGTERM');

      const rmCalls = calls.filter((c) => c.file === 'docker' && c.args[0] === 'rm');
      expect(rmCalls).toHaveLength(1);
      expect(rmCalls[0]!.args).toEqual(['rm', '-f', pg.containerName]);
      expect(hostHandler).toHaveBeenCalledTimes(1);
      expect(proc.kill).not.toHaveBeenCalled();
      expect(proc.listenerCount('SIGTERM')).toBe(1); // 仅剩 hostHandler
    }
  });
});
