import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../shared/audit.service.js';
import { OpsEngineClient, type OpsEngineResult } from './ops-engine.client.js';

/**
 * 平台渠道数据源（P3 数据源归属）：平台渠道的注册/治理/启停/试跑只属于运营台。
 * 所有动作经 saas-ops 引擎身份落到引擎的 `source_channel`；本服务只做形状校验、
 * 错误透传与 ops 审计（actor=运营账号，落 gain-saas AuditLog）。
 */

const CHANNEL_MODES = ['api', 'crawl', 'import'] as const;
const CHANNEL_STATUSES = ['DISABLED', 'ENABLED', 'AUTO_DISABLED'] as const;
const ROBOTS_POLICIES = ['A', 'B', 'C'] as const;

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mode: z.enum(CHANNEL_MODES),
  category: z.string().trim().min(1).max(100),
  config: z.record(z.string(), z.unknown()).default({}),
  license: z.string().trim().max(200).optional(),
  tosUrl: z.string().trim().max(2048).optional(),
  robotsPolicy: z.enum(ROBOTS_POLICIES).optional(),
  owner: z.string().trim().max(200).optional(),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    mode: z.enum(CHANNEL_MODES).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(CHANNEL_STATUSES).optional(),
    license: z.string().trim().max(200).nullable().optional(),
    tosUrl: z.string().trim().max(2048).nullable().optional(),
    robotsPolicy: z.enum(ROBOTS_POLICIES).nullable().optional(),
    owner: z.string().trim().max(200).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有可更新字段' });

function validationError(error: z.ZodError): BadRequestException {
  return new BadRequestException({
    error: {
      code: 'VALIDATION',
      message: error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; '),
    },
  });
}

function engineError(result: OpsEngineResult): HttpException {
  const err = (result.body as { error?: { code?: string; message?: string } } | null)?.error;
  return new HttpException(
    {
      error: {
        code: err?.code ?? 'ENGINE_ERROR',
        message: err?.message ?? `engine responded ${result.status}`,
      },
    },
    result.status >= 400 ? result.status : 502,
  );
}

function engineData(result: OpsEngineResult): unknown {
  const body = result.body as { data?: unknown } | null;
  return body && typeof body === 'object' && 'data' in body ? body.data : body;
}

@Injectable()
export class OpsChannelsService {
  constructor(
    private readonly engine: OpsEngineClient,
    private readonly audit: AuditService,
  ) {}

  async list(actorId: string): Promise<unknown> {
    const result = await this.engine.call(actorId, 'GET', '/source-channels');
    if (result.status >= 300) throw engineError(result);
    return engineData(result);
  }

  async create(actorId: string, body: unknown): Promise<unknown> {
    const parsed = createSchema.safeParse(body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    const result = await this.engine.call(actorId, 'POST', '/source-channels', { body: parsed.data });
    if (result.status >= 300) throw engineError(result);
    const channel = engineData(result) as { id?: string; name?: string } | null;
    await this.audit.record({
      realm: 'ops',
      actorId,
      action: 'channel.create',
      target: channel?.id,
      detail: { name: parsed.data.name, mode: parsed.data.mode, category: parsed.data.category },
    });
    return channel;
  }

  async patch(actorId: string, channelId: string, body: unknown): Promise<unknown> {
    const parsed = patchSchema.safeParse(body ?? {});
    if (!parsed.success) throw validationError(parsed.error);
    const result = await this.engine.call(actorId, 'PATCH', `/source-channels/${channelId}`, { body: parsed.data });
    if (result.status >= 300) throw engineError(result);
    await this.audit.record({
      realm: 'ops',
      actorId,
      action: 'channel.patch',
      target: channelId,
      detail: { fields: Object.keys(parsed.data), status: parsed.data.status },
    });
    return engineData(result);
  }

  async preview(actorId: string, channelId: string): Promise<unknown> {
    return this.crawl(`/source-channels/${channelId}/preview`, 'channel.preview', actorId, channelId);
  }

  async run(actorId: string, channelId: string): Promise<unknown> {
    return this.crawl(`/source-channels/${channelId}/run`, 'channel.run', actorId, channelId);
  }

  /** 抓取意图无论引擎接受还是 fail-closed 都留审计（平台出网意图必须可回溯）。 */
  private async crawl(path: string, action: string, actorId: string, channelId: string): Promise<unknown> {
    const result = await this.engine.call(actorId, 'POST', path, {});
    const engineCode =
      (result.body as { error?: { code?: string } } | null)?.error?.code ?? null;
    await this.audit.record({
      realm: 'ops',
      actorId,
      action,
      target: channelId,
      detail: { engineStatus: result.status, engineCode },
    });
    if (result.status >= 300) throw engineError(result);
    return engineData(result);
  }
}
