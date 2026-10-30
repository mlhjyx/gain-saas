import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from './configuration.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db',
  SESSION_SECRET: 'x'.repeat(32),
  ENGINE_JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
  ENGINE_JWT_KEY_ID: 'kid-1',
  ENGINE_JWT_ISSUER: 'http://127.0.0.1:4020',
  ENGINE_BUDGET_GRANT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
  ENGINE_BUDGET_GRANT_KEY_ID: 'budget-kid-1',
  ENGINE_BUDGET_GRANT_ISSUER: 'https://127.0.0.1:18446/execution-budget',
};

describe('loadConfig', () => {
  it('缺关键配置拒绝启动', () => {
    resetConfigCache();
    expect(() => loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toThrow(/配置无效/);
  });

  it('合法配置取默认值', () => {
    resetConfigCache();
    const config = loadConfig(baseEnv as NodeJS.ProcessEnv);
    expect(config.PORT).toBe(4020);
    expect(config.ENGINE_ORIGIN).toBe('http://127.0.0.1:3000');
    expect(config.EVENT_CONSUMER_ENABLED).toBe(false);
    expect(config.SESSION_TTL_MINUTES).toBe(60);
  });

  it('ENGINE_JWT_ISSUER 缺失拒绝启动(不能与引擎 AUTH_ISSUER 静默漂移)', () => {
    resetConfigCache();
    const { ENGINE_JWT_ISSUER: _issuer, ...env } = baseEnv;
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/ENGINE_JWT_ISSUER/);
  });

  it('EVENT_CONSUMER_ENABLED=true 才开启', () => {
    resetConfigCache();
    const config = loadConfig({ ...baseEnv, EVENT_CONSUMER_ENABLED: 'true' } as NodeJS.ProcessEnv);
    expect(config.EVENT_CONSUMER_ENABLED).toBe(true);
  });
});
