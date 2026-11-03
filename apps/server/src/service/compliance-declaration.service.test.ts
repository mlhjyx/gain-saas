import { describe, expect, it, vi } from 'vitest';
import { ComplianceDeclarationService } from './compliance-declaration.service.js';

describe('租户声明只读历史（2026-11-04 取消租户声明）', () => {
  it('lists the retained declarations newest-first, read-only', async () => {
    const rows = [
      { id: 'd2', workspaceId: 'w1', version: 2, basis: 'legitimate_interest', declaredAt: new Date('2026-11-03T10:00:00Z') },
      { id: 'd1', workspaceId: 'w1', version: 1, basis: 'consent', declaredAt: new Date('2026-11-02T10:00:00Z') },
    ];
    const findMany = vi.fn(async () => rows);
    const service = new ComplianceDeclarationService({ workspaceComplianceDeclaration: { findMany } } as never);
    await expect(service.history('w1')).resolves.toEqual(rows);
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w1' },
      orderBy: { version: 'desc' },
      take: 20,
    });
  });

  it('returns an empty history for a workspace that never declared', async () => {
    const service = new ComplianceDeclarationService({
      workspaceComplianceDeclaration: { findMany: vi.fn(async () => []) },
    } as never);
    await expect(service.history('w2')).resolves.toEqual([]);
  });
});
