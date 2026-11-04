import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { EngineTokenSigner, OPS_ENGINE_WORKSPACE } from '../service/engine-token.signer.js';

export interface OpsEngineResult {
  status: number;
  body: unknown;
}

/**
 * 运营身份（saas-ops）到引擎的平台级调用。
 *
 * 与租户 BFF（EngineHttp）刻意分开：ops 动作不携带租户工作空间（哨兵值见
 * OPS_ENGINE_WORKSPACE），错误原样透传给运营台（不做租户侧三层文案折算）——
 * 运营看到的是真实引擎码，便于排障。scope 由引擎按 AUTH_ROLE_SCOPE_MAP_JSON 授予。
 */
@Injectable()
export class OpsEngineClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly signer: EngineTokenSigner,
  ) {}

  async call(
    actorUserId: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    enginePath: string,
    options: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<OpsEngineResult> {
    const token = await this.signer.mint({
      subjectId: actorUserId,
      workspaceId: OPS_ENGINE_WORKSPACE,
      roles: ['saas-ops'],
    });
    const url = new URL(`/api/v1${enginePath}`, this.config.ENGINE_ORIGIN);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await response.json().catch(() => ({}))
      : await response.text().catch(() => '');
    return { status: response.status, body };
  }
}
