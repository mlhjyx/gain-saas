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
    expect(config.ENGINE_MANUFACTURER_NETWORK_ENABLED).toBe(false);
    expect(config.SESSION_TTL_MINUTES).toBe(60);
    expect(config.LEGACY_EXECUTION_BUDGET_MODE).toBe('enforce');
    expect(config.PLATFORM_AUTHORITY_MODE).toBe('r4');
  });

  it('only explicitly enables manufacturer evidence on an upgraded engine', () => {
    resetConfigCache();
    expect(loadConfig({ ...baseEnv, ENGINE_MANUFACTURER_NETWORK_ENABLED: 'true' } as NodeJS.ProcessEnv)
      .ENGINE_MANUFACTURER_NETWORK_ENABLED).toBe(true);
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

  it('OPS_SESSION_SECRET: 生产环境必填、至少 32 字符、且任何环境均不能与 SESSION_SECRET 相同', () => {
    resetConfigCache();
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgresql://gain_saas_app:p@127.0.0.1:5433/db',
      } as NodeJS.ProcessEnv),
    ).toThrow(/OPS_SESSION_SECRET/);

    resetConfigCache();
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgresql://gain_saas_app:p@127.0.0.1:5433/db',
        OPS_SESSION_SECRET: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/OPS_SESSION_SECRET/);

    resetConfigCache();
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgresql://gain_saas_app:p@127.0.0.1:5433/db',
        OPS_SESSION_SECRET: 'short',
      } as NodeJS.ProcessEnv),
    ).toThrow(/OPS_SESSION_SECRET/);

    resetConfigCache();
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        APP_DATABASE_URL: 'postgresql://gain_saas_app:p@127.0.0.1:5433/db',
        OPS_SESSION_SECRET: baseEnv.SESSION_SECRET,
      } as NodeJS.ProcessEnv),
    ).toThrow(/OPS_SESSION_SECRET/);

    resetConfigCache();
    expect(() =>
      loadConfig({ ...baseEnv, NODE_ENV: 'development', OPS_SESSION_SECRET: baseEnv.SESSION_SECRET } as NodeJS.ProcessEnv),
    ).toThrow(/OPS_SESSION_SECRET/);

    resetConfigCache();
    const prodConfig = loadConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      APP_DATABASE_URL: 'postgresql://gain_saas_app:p@127.0.0.1:5433/db',
      OPS_SESSION_SECRET: 'y'.repeat(32),
    } as NodeJS.ProcessEnv);
    expect(prodConfig.OPS_SESSION_SECRET).toBe('y'.repeat(32));
    expect(prodConfig.APP_DATABASE_URL).toBe('postgresql://gain_saas_app:p@127.0.0.1:5433/db');

    resetConfigCache();
    const devConfig = loadConfig({ ...baseEnv, OPS_SESSION_SECRET: '' } as NodeJS.ProcessEnv);
    expect(devConfig.OPS_SESSION_SECRET).toBeUndefined();
    expect(devConfig.APP_DATABASE_URL).toBeUndefined();
  });

  it('APP_DATABASE_URL: 生产环境必填且空白串视为未配置', () => {
    resetConfigCache();
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        OPS_SESSION_SECRET: 'y'.repeat(32),
      } as NodeJS.ProcessEnv),
    ).toThrow(/APP_DATABASE_URL/);

    resetConfigCache();
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        APP_DATABASE_URL: '   ',
        OPS_SESSION_SECRET: 'y'.repeat(32),
      } as NodeJS.ProcessEnv),
    ).toThrow(/APP_DATABASE_URL/);
  });

  it('已下线的 MODEL_GATEWAY_* 遗留环境变量会被静默忽略且不影响启动', () => {
    resetConfigCache();
    const config = loadConfig({
      ...baseEnv,
      MODEL_GATEWAY_API_KEY: 'a'.repeat(24),
      MODEL_GATEWAY_ENC_KEY: '0'.repeat(64),
      MODEL_GATEWAY_TIMEOUT_MS: '60000',
      MODEL_GATEWAY_SETTLEMENT_ORIGIN: 'http://127.0.0.1:3001',
      MODEL_GATEWAY_SETTLEMENT_API_KEY: 'b'.repeat(24),
    } as NodeJS.ProcessEnv) as Record<string, unknown>;
    expect(config.MODEL_GATEWAY_API_KEY).toBeUndefined();
    expect(config.MODEL_GATEWAY_ENC_KEY).toBeUndefined();
    expect(config.MODEL_GATEWAY_TIMEOUT_MS).toBeUndefined();
    expect(config.MODEL_GATEWAY_SETTLEMENT_ORIGIN).toBeUndefined();
    expect(config.MODEL_GATEWAY_SETTLEMENT_API_KEY).toBeUndefined();
  });

  it('LEGACY_EXECUTION_BUDGET_MODE: enforce 默认强制校验旧 Grant 密钥；bypass 允许全部省略（含生产环境）', () => {
    const {
      ENGINE_BUDGET_GRANT_PRIVATE_KEY: _pk,
      ENGINE_BUDGET_GRANT_KEY_ID: _kid,
      ENGINE_BUDGET_GRANT_ISSUER: _iss,
      ...withoutGrantKeys
    } = baseEnv;

    resetConfigCache();
    expect(() => loadConfig(withoutGrantKeys as NodeJS.ProcessEnv)).toThrow(/ENGINE_BUDGET_GRANT_PRIVATE_KEY/);

    resetConfigCache();
    expect(() =>
      loadConfig({
        ...withoutGrantKeys,
        LEGACY_EXECUTION_BUDGET_MODE: 'enforce',
        ENGINE_BUDGET_GRANT_PRIVATE_KEY: '   ',
      } as NodeJS.ProcessEnv),
    ).toThrow(/ENGINE_BUDGET_GRANT_PRIVATE_KEY/);

    resetConfigCache();
    const bypassProd = loadConfig({
      ...withoutGrantKeys,
      NODE_ENV: 'production',
      APP_DATABASE_URL: 'postgresql://gain_saas_app:p@127.0.0.1:5433/db',
      OPS_SESSION_SECRET: 'y'.repeat(32),
      LEGACY_EXECUTION_BUDGET_MODE: 'bypass',
      PLATFORM_AUTHORITY_MODE: 'internal_db',
    } as NodeJS.ProcessEnv);
    expect(bypassProd.LEGACY_EXECUTION_BUDGET_MODE).toBe('bypass');
    expect(bypassProd.PLATFORM_AUTHORITY_MODE).toBe('internal_db');
    expect(bypassProd.ENGINE_BUDGET_GRANT_PRIVATE_KEY).toBeUndefined();
    expect(bypassProd.ENGINE_BUDGET_GRANT_KEY_ID).toBeUndefined();
    expect(bypassProd.ENGINE_BUDGET_GRANT_ISSUER).toBeUndefined();
  });

  it('LEGACY_EXECUTION_BUDGET_MODE 与 PLATFORM_AUTHORITY_MODE 非法取值拒绝启动', () => {
    resetConfigCache();
    expect(() =>
      loadConfig({ ...baseEnv, LEGACY_EXECUTION_BUDGET_MODE: 'disabled' } as NodeJS.ProcessEnv),
    ).toThrow(/LEGACY_EXECUTION_BUDGET_MODE/);

    resetConfigCache();
    expect(() =>
      loadConfig({ ...baseEnv, PLATFORM_AUTHORITY_MODE: 'none' } as NodeJS.ProcessEnv),
    ).toThrow(/PLATFORM_AUTHORITY_MODE/);
  });
});
