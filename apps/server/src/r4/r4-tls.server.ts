import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';

/**
 * R4 内部 TLS 监听（P5b）。
 *
 * 两个可选监听，与主 HTTP 监听并存：
 *  - `R4_TLS_PORT`：服务端 TLS（引擎取 JWKS 时不带客户端证书，与现有 18446 的 socat 等价）
 *  - `R4_MTLS_PORT`：要求客户端证书（机器 token 端点，与现有 18443 等价）
 *
 * 证书由 r4-pki 签发，引擎侧信任根不变——替换的是只转发字节的 socat sidecar。
 * 两个端口都不配置时什么都不做，线上行为不变。
 */
export interface R4TlsHandle {
  port: number;
  close(): Promise<void>;
}

const defaultRead = (path: string): Buffer => readFileSync(path);

function readMaterial(config: AppConfig, readFile: (path: string) => Buffer) {
  const { R4_TLS_CERT_FILE: cert, R4_TLS_KEY_FILE: key, R4_TLS_CA_FILE: ca } = config;
  if (!cert || !key) throw new Error('TLS 端口已设置，但缺少证书/私钥路径');
  return { cert: readFile(cert), key: readFile(key), ca: ca ? readFile(ca) : undefined };
}

export function loadTlsOptions(
  config: AppConfig,
  readFile: (path: string) => Buffer = defaultRead,
): ServerOptions | null {
  if (!config.R4_TLS_PORT) return null;
  const material = readMaterial(config, readFile);
  if (config.R4_TLS_CLIENT_AUTH === 'required') {
    if (!material.ca) throw new Error('R4_TLS_CLIENT_AUTH=required 时必须提供 CA');
    return { ...material, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  }
  return { ...material, requestCert: false, rejectUnauthorized: false, minVersion: 'TLSv1.2' };
}

export function loadMtlsOptions(
  config: AppConfig,
  readFile: (path: string) => Buffer = defaultRead,
): ServerOptions | null {
  if (!config.R4_MTLS_PORT) return null;
  const material = readMaterial(config, readFile);
  if (!material.ca) throw new Error('R4_MTLS_PORT 已设置，但缺少 CA 路径');
  return { ...material, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
}

export async function startR4TlsServers(
  app: INestApplication,
  config: AppConfig,
  readFile: (path: string) => Buffer = defaultRead,
): Promise<R4TlsHandle[]> {
  if (config.R4_TLS_PORT && config.R4_MTLS_PORT && config.R4_TLS_PORT === config.R4_MTLS_PORT)
    throw new Error('R4_MTLS_PORT 不能与 R4_TLS_PORT 相同');

  const targets: Array<{ port: number; options: ServerOptions }> = [];
  const tls = loadTlsOptions(config, readFile);
  if (tls) targets.push({ port: config.R4_TLS_PORT!, options: tls });
  const mtls = loadMtlsOptions(config, readFile);
  if (mtls) targets.push({ port: config.R4_MTLS_PORT!, options: mtls });

  const handler = app.getHttpAdapter().getInstance() as (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void;

  const handles: R4TlsHandle[] = [];
  for (const target of targets) {
    const server = createHttpsServer(target.options, handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(target.port, config.R4_TLS_HOST, () => resolve());
    });
    handles.push({
      port: target.port,
      close: () =>
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    });
  }
  return handles;
}
