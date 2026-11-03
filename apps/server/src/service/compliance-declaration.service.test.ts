import { describe, expect, it, vi } from 'vitest';
import { ComplianceDeclarationService } from './compliance-declaration.service.js';

function makeService(latestVersion: number | null, createImpl?: (data: { data: { version: number } }) => unknown) {
  const create = vi.fn(createImpl ?? (async (args: { data: { version: number } }) => ({
    id: 'd1',
    workspaceId: 'w1',
    version: args.data.version,
    basis: 'legitimate_interest',
    declaredBy: 'u1',
    declaredAt: new Date('2026-11-03T10:00:00Z'),
  })));
  const prisma = {
    workspaceComplianceDeclaration: {
      findFirst: vi.fn(async () => (latestVersion === null ? null : { id: 'old', version: latestVersion })),
      create,
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new ComplianceDeclarationService(prisma as never, audit as never);
  return { service, create, audit };
}

describe('D6 per-tenant LIA 声明', () => {
  it('declares the first version when no declaration exists', async () => {
    const { service, create, audit } = makeService(null);
    const created = await service.declare('u1', 'w1', { basis: 'legitimate_interest', ref: 'LIA-1', note: '评估摘要' });
    expect(created.version).toBe(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: 'w1', version: 1, basis: 'legitimate_interest', ref: 'LIA-1', note: '评估摘要', declaredBy: 'u1' }),
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'compliance.declare', detail: { version: 1, basis: 'legitimate_interest' } }));
  });

  it('increments the version on re-declaration (history preserved by unique(workspace,version))', async () => {
    const { service } = makeService(3);
    const created = await service.declare('u1', 'w1', { basis: 'consent' });
    expect(created.version).toBe(4);
  });

  it('rejects an unknown basis and over-long note', async () => {
    const { service } = makeService(null);
    await expect(service.declare('u1', 'w1', { basis: 'because' })).rejects.toMatchObject({ response: { error: { code: 'COMPLIANCE_BASIS_INVALID' } } });
    await expect(service.declare('u1', 'w1', { basis: 'consent', note: 'x'.repeat(4001) })).rejects.toMatchObject({ response: { error: { code: 'COMPLIANCE_NOTE_TOO_LONG' } } });
  });

  it('surfaces a repeated concurrent conflict as 409 COMPLIANCE_DECLARE_CONFLICT', async () => {
    const { service, create } = makeService(1, async () => {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    });
    await expect(service.declare('u1', 'w1', { basis: 'consent' })).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'COMPLIANCE_DECLARE_CONFLICT' } },
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('retries once on a concurrent version conflict (P2002)', async () => {
    let attempt = 0;
    const { service, create } = makeService(1, async (args: { data: { version: number } }) => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('unique'), { code: 'P2002' });
      return { id: 'd2', workspaceId: 'w1', version: args.data.version, basis: 'consent', declaredBy: 'u1', declaredAt: new Date() };
    });
    const created = await service.declare('u1', 'w1', { basis: 'consent' });
    expect(created.version).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
