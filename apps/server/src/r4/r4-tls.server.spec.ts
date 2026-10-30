import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { loadMtlsOptions, loadTlsOptions } from './r4-tls.server.js';

const read = (path: string) => Buffer.from(`content-of-${path}`);

describe('R4 内部 TLS 配置', () => {
  it('未设置端口时返回 null（现状不变）', () => {
    expect(loadTlsOptions({} as AppConfig, read)).toBeNull();
  });

  it('设置端口但缺证书路径时拒绝启动', () => {
    expect(() => loadTlsOptions({ R4_TLS_PORT: 18446 } as unknown as AppConfig, read)).toThrow(/证书/);
  });

  it('默认不做客户端证书校验（引擎取 JWKS 不带证书）', () => {
    const options = loadTlsOptions(
      {
        R4_TLS_PORT: 18447,
        R4_TLS_CERT_FILE: '/c/server.pem',
        R4_TLS_KEY_FILE: '/c/server.key',
      } as unknown as AppConfig,
      read,
    );
    expect(options!.requestCert).toBe(false);
    expect(options!.rejectUnauthorized).toBe(false);
  });

  it('R4_MTLS_PORT 独立于 R4_TLS_PORT，且必须有 CA', () => {
    expect(() =>
      loadMtlsOptions(
        { R4_MTLS_PORT: 18443, R4_TLS_CERT_FILE: '/c/s.pem', R4_TLS_KEY_FILE: '/c/s.key' } as unknown as AppConfig,
        read,
      ),
    ).toThrow(/CA/);
    const options = loadMtlsOptions(
      {
        R4_MTLS_PORT: 18443,
        R4_TLS_CERT_FILE: '/c/s.pem',
        R4_TLS_KEY_FILE: '/c/s.key',
        R4_TLS_CA_FILE: '/c/ca.pem',
      } as unknown as AppConfig,
      read,
    );
    expect(options!.requestCert).toBe(true);
    expect(options!.rejectUnauthorized).toBe(true);
  });

  it('R4_TLS_CLIENT_AUTH=required 时必须提供 CA', () => {
    expect(() =>
      loadTlsOptions(
        {
          R4_TLS_PORT: 18447,
          R4_TLS_CERT_FILE: '/c/server.pem',
          R4_TLS_KEY_FILE: '/c/server.key',
          R4_TLS_CLIENT_AUTH: 'required',
        } as unknown as AppConfig,
        read,
      ),
    ).toThrow(/CA/);
  });

  it('配置齐全时要求客户端证书并拒绝未认证连接', () => {
    const options = loadTlsOptions(
      {
        R4_TLS_PORT: 18446,
        R4_TLS_CERT_FILE: '/certs/server.pem',
        R4_TLS_KEY_FILE: '/certs/server.key',
        R4_TLS_CA_FILE: '/certs/ca.pem',
        R4_TLS_CLIENT_AUTH: 'required',
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
