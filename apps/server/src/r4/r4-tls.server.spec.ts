import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { loadTlsOptions } from './r4-tls.server.js';

const read = (path: string) => Buffer.from(`content-of-${path}`);

describe('R4 内部 TLS 配置', () => {
  it('未设置端口时返回 null（现状不变）', () => {
    expect(loadTlsOptions({} as AppConfig, read)).toBeNull();
  });

  it('设置端口但缺证书路径时拒绝启动', () => {
    expect(() => loadTlsOptions({ R4_TLS_PORT: 18446 } as unknown as AppConfig, read)).toThrow(/证书/);
  });

  it('配置齐全时要求客户端证书并拒绝未认证连接', () => {
    const options = loadTlsOptions(
      {
        R4_TLS_PORT: 18446,
        R4_TLS_CERT_FILE: '/certs/server.pem',
        R4_TLS_KEY_FILE: '/certs/server.key',
        R4_TLS_CA_FILE: '/certs/ca.pem',
      } as unknown as AppConfig,
      read,
    );
    expect(options).not.toBeNull();
    expect(options!.requestCert).toBe(true);
    expect(options!.rejectUnauthorized).toBe(true);
    expect(options!.minVersion).toBe('TLSv1.2');
    expect(String(options!.cert)).toBe('content-of-/certs/server.pem');
    expect(String(options!.ca)).toBe('content-of-/certs/ca.pem');
  });
});
