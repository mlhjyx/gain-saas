import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';

/**
 * D6：per-tenant 合法依据声明（数据处理声明）。
 *
 * - 每 workspace 每次（重新）声明新增一版（version 自增），历史保留用于审计（D6-3）；
 * - BFF 在联系人发现/猜测/验证三路由把当前版本注入请求（D6-4 立即生效）；
 * - 未声明时 BFF 不注入 → 引擎按合同返回 403，前端引导到声明页（D6-2）。
 */
export const LAWFUL_BASIS_KINDS = [
  'legitimate_interest',
  'consent',
  'contract',
  'legal_obligation',
] as const;
export type LawfulBasisKind = (typeof LAWFUL_BASIS_KINDS)[number];

export interface ComplianceDeclarationInput {
  basis?: unknown;
  ref?: unknown;
  note?: unknown;
}

const MAX_REF = 500;
const MAX_NOTE = 4000;

@Injectable()
export class ComplianceDeclarationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 当前生效的声明（最新版本）；未声明返回 null。 */
  async current(workspaceId: string) {
    return this.prisma.workspaceComplianceDeclaration.findFirst({
      where: { workspaceId },
      orderBy: { version: 'desc' },
    });
  }

  async declare(actorId: string, workspaceId: string, input: ComplianceDeclarationInput) {
    const basis = typeof input.basis === 'string' ? input.basis.trim() : '';
    if (!(LAWFUL_BASIS_KINDS as readonly string[]).includes(basis)) {
      throw new BadRequestException({
        error: { code: 'COMPLIANCE_BASIS_INVALID', message: `basis must be one of: ${LAWFUL_BASIS_KINDS.join(', ')}` },
      });
    }
    const ref = typeof input.ref === 'string' ? input.ref.trim() : undefined;
    const note = typeof input.note === 'string' ? input.note.trim() : undefined;
    if (ref !== undefined && ref.length > MAX_REF) {
      throw new BadRequestException({ error: { code: 'COMPLIANCE_REF_TOO_LONG', message: `ref must be ≤ ${MAX_REF} chars` } });
    }
    if (note !== undefined && note.length > MAX_NOTE) {
      throw new BadRequestException({ error: { code: 'COMPLIANCE_NOTE_TOO_LONG', message: `note must be ≤ ${MAX_NOTE} chars` } });
    }

    // version 自增；并发声明撞唯一约束时先回读再重试一次（D6-3 保持历史）。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const latest = await this.current(workspaceId);
      try {
        const created = await this.prisma.workspaceComplianceDeclaration.create({
          data: {
            workspaceId,
            version: (latest?.version ?? 0) + 1,
            basis,
            ...(ref ? { ref } : {}),
            ...(note ? { note } : {}),
            declaredBy: actorId,
          },
        });
        await this.audit.record({
          realm: 'tenant',
          actorId,
          action: 'compliance.declare',
          target: workspaceId,
          detail: { version: created.version, basis },
        });
        return created;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'P2002' && attempt === 0) continue; // 并发声明：回读后重试一次
        throw error;
      }
    }
    throw new ConflictException({ error: { code: 'COMPLIANCE_DECLARE_CONFLICT', message: 'concurrent declaration, retry' } });
  }
}
