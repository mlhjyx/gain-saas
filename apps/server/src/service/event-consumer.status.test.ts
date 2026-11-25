import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import type { EngineTokenSigner } from './engine-token.signer.js';

function makeService() {
  const queryRaw = vi.fn(async () => []);
  const prisma = {
    $queryRaw: queryRaw,
  } as unknown as PrismaService;
  const config = { EVENT_CONSUMER_ENABLED: true, EVENT_CONSUMER_PAGE_LIMIT: 100 } as AppConfig;
  const signer = { mint: vi.fn(async () => 'token') } as unknown as EngineTokenSigner;
  const service = new EventConsumerService(config, signer, prisma);
  return { service, queryRaw };
}

describe('EventConsumerService workspace status filter', () => {
  it('只通过 app_list_enabled_workspaces() 轮询 ACTIVE 工作空间', async () => {
    const { service, queryRaw } = makeService();
    await service.consumeOnce();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray];
    expect(strings.join(' ')).toContain('app_list_enabled_workspaces');
  });
});
