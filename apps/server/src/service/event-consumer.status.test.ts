import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import type { EngineTokenSigner } from './engine-token.signer.js';

function makeService() {
  const findMany = vi.fn(async () => []);
  const prisma = {
    workspaceRegistry: { findMany },
  } as unknown as PrismaService;
  const config = { EVENT_CONSUMER_ENABLED: true, EVENT_CONSUMER_PAGE_LIMIT: 100 } as AppConfig;
  const signer = { mint: vi.fn(async () => 'token') } as unknown as EngineTokenSigner;
  const service = new EventConsumerService(config, signer, prisma);
  return { service, findMany };
}

describe('EventConsumerService workspace status filter', () => {
  it('只轮询 ACTIVE 工作空间的注册表行', async () => {
    const { service, findMany } = makeService();
    await service.consumeOnce();
    expect(findMany).toHaveBeenCalledWith({
      where: { enabled: true, workspace: { status: 'ACTIVE' } },
    });
  });
});
