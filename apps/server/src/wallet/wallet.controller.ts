import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { WalletService } from './wallet.service.js';
import type {
  TenantWalletCreditLotDto,
  TenantWalletLedgerDto,
  WalletCreditLotDto,
  WalletLedgerDto,
} from './wallet.types.js';

/** 租户侧批次 DTO：剥离内部商业单价、外部订单号、运营备注与操作者标识。 */
export function toTenantLotDto(lot: WalletCreditLotDto): TenantWalletCreditLotDto {
  return {
    id: lot.id,
    workspaceId: lot.workspaceId,
    sourceType: lot.sourceType,
    initialCredits: lot.initialCredits,
    remainingCredits: lot.remainingCredits,
    priority: lot.priority,
    expiresAt: lot.expiresAt,
    createdAt: lot.createdAt,
  };
}

/** 租户侧账本流水 DTO：剥离内部折算营收（revenueMicros）、运营备注与内部操作者标识。 */
export function toTenantLedgerDto(item: WalletLedgerDto): TenantWalletLedgerDto {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    idempotencyKey: item.idempotencyKey,
    entryType: item.entryType,
    deltaAvailable: item.deltaAvailable,
    deltaHeld: item.deltaHeld,
    balanceAvailable: item.balanceAvailable,
    balanceHeld: item.balanceHeld,
    holdId: item.holdId,
    lotId: item.lotId,
    actionCode: item.actionCode,
    refType: item.refType,
    refId: item.refId,
    billableUnits: item.billableUnits,
    createdAt: item.createdAt,
  };
}

/**
 * 租户钱包只读接口（/api/wallet/*）：
 * - GET /summary 对工作空间全部成员开放（展示余额与透明价目表）；
 * - GET /lots、/holds、/ledger 仅工作空间管理员可查（AdminGuard），且不回传内部单价与折算营收字段。
 */
@Controller('api/wallet')
@UseGuards(TenantGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('summary')
  async summary(@Req() req: Request) {
    const data = await this.wallet.getSummary(req.tenant!.workspaceId);
    return { data };
  }

  @Get('lots')
  @UseGuards(AdminGuard)
  async lots(@Req() req: Request, @Query('limit') limit?: string) {
    const items = await this.wallet.listLots(req.tenant!.workspaceId, limit ? Number(limit) : 50);
    return { data: items.map(toTenantLotDto) };
  }

  @Get('holds')
  @UseGuards(AdminGuard)
  async holds(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const items = await this.wallet.listHolds(
      req.tenant!.workspaceId,
      status?.trim() || undefined,
      limit ? Number(limit) : 50,
    );
    return { data: items };
  }

  @Get('ledger')
  @UseGuards(AdminGuard)
  async ledger(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('entryType') entryType?: string,
    @Query('cursor') cursor?: string,
  ) {
    const page = await this.wallet.listLedger(req.tenant!.workspaceId, {
      limit: limit ? Number(limit) : 30,
      entryType: entryType?.trim() || undefined,
      cursor: cursor?.trim() || undefined,
    });
    return {
      data: page.items.map(toTenantLedgerDto),
      page: {
        has_more: page.nextCursor !== null,
        next_cursor: page.nextCursor,
      },
    };
  }
}
