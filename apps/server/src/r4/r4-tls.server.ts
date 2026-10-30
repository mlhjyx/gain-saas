import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';

/**
 * R4 内部 TLS 监听（P5b）。
 *
 * 与现有 HTTP 监听并存：同一个 Express 实例再挂一个 HTTPS 服务端，
 * 要求客户端证书（mTLS），默认只绑回环。引擎侧信任根不变——证书仍由
 * 同一套 r4-pki CA 签发，替换的是 3443 上那个只转发字节的 socat。
 *
 * 未配置 R4_TLS_PORT 时什么都不做（开发态与现状不变）。
 */
export interface R4TlsHandle {
  port: number;
  close(): Promise<void>;
}

const defaultRead = (path: string): Buffer => readFileSync(path);

export function loadTlsOptions(
  config: AppConfig,
  readFile: (path: string) => Buffer = defaultRead,
): ServerOptions | null {
  const { R4_TLS_CERT_FILE: cert, R4_TLS_KEY_FILE: key, R4_TLS_CA_FILE: ca } = config;
  if (!config.R4_TLS_PORT) return null;
  if (!cert || !key || !ca) throw new Error('R4_TLS_PORT 已设置，但缺少证书/私钥/CA 路径');
  return {
    cert: readFile(cert),
    key: readFile(key),
    ca: readFile(ca),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  };
}

export async function startR4TlsServer(
  app: INestApplication,
  config: AppConfig,
  readFile: (path: string) => Buffer = defaultRead,
): Promise<R4TlsHandle | null> {
  const options = loadTlsOptions(config, readFile);
  if (!options) return null;
  const handler = app.getHttpAdapter().getInstance() as (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void;
  const server = createHttpsServer(options, handler);
  const port = config.R4_TLS_PORT!;
  const host = config.R4_TLS_HOST;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
