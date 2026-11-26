import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OpsDatabase } from '../ops/ops-database.service.js';
import { OpsGuard, type OpsRequest } from '../ops/ops.guard.js';
import { WalletService } from './wallet.service.js';

/**
 * 平台运营钱包管理与毛利对账接口（/api/ops/wallet/*，独立 OpsGuard 隔离）：
 * - 手动充值 / 赠点入账（幂等）、钱包冻结/解冻
 * - 商业价目表 CRUD（经 audited SECURITY DEFINER RPC）
 * - 商业实收 vs 引擎 usage_ledger 底层成本毛利对账
 */
@Controller('api/ops/wallet')
@UseGuards(OpsGuard)
export class OpsWalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly opsDatabase: OpsDatabase,
  ) {}

  @Get('accounts')
  async listAccounts(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    const data = await this.wallet.opsListAccounts(
      limit ? Number(limit) : 100,
      offset ? Number(offset) : 0,
    );
    return { data };
  }

  @Get('workspaces/:workspaceId')
  async workspaceDetail(@Param('workspaceId') workspaceId: string) {
    const [summary, lots, holds, ledger] = await Promise.all([
      this.wallet.getSummary(workspaceId),
      this.wallet.listLots(workspaceId, 50),
      this.wallet.listHolds(workspaceId, undefined, 30),
      this.wallet.listLedger(workspaceId, { limit: 30 }),
    ]);
    return {
      data: {
        summary,
        lots,
        holds,
        ledger: ledger.items,
      },
    };
  }

  @Post('workspaces/:workspaceId/top-up')
  @HttpCode(201)
  async topUp(
    @Req() req: OpsRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const data = await this.wallet.topUp(workspaceId, body, req.opsUser!.id);
    return { data };
  }

  @Post('workspaces/:workspaceId/grant-bonus')
  @HttpCode(201)
  async grantBonus(
    @Req() req: OpsRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const data = await this.wallet.grantBonus(workspaceId, body, req.opsUser!.id);
    return { data };
  }

  @Patch('workspaces/:workspaceId/status')
  async setStatus(
    @Req() req: OpsRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    const data = await this.wallet.setWalletStatus(workspaceId, body, req.opsUser!.id);
    return { data };
  }

  @Get('price-cards')
  async listPriceCards(@Query('includeInactive') includeInactive?: string) {
    const data = await this.wallet.listPriceCards(includeInactive !== 'false');
    return { data };
  }

  @Post('price-cards')
  @HttpCode(201)
  async createPriceCard(@Req() req: OpsRequest, @Body() body: unknown) {
    const data = await this.wallet.opsCreatePriceCard(body, req.opsUser!.id);
    return { data };
  }

  @Patch('price-cards/:id')
  async updatePriceCard(
    @Req() req: OpsRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = await this.wallet.opsUpdatePriceCard(id, body, req.opsUser!.id);
    return { data };
  }

  @Get('profit-reconciliation')
  async profitReconciliation(
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
    @Query('workspaceId') workspaceId?: string,
  ) {
    const now = new Date();
    const to = toRaw ? new Date(toRaw) : now;
    const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 30 * 86_400_000);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: '对账时间窗口 from/to 非法' },
      });
    }
    const data = await this.wallet.opsProfitReconciliation(
      { from, to, workspaceId: workspaceId?.trim() || undefined },
      this.opsDatabase,
    );
    return { data };
  }

  @Post('sweep-expired-holds')
  @HttpCode(200)
  async sweepExpiredHolds() {
    const data = await this.wallet.sweepExpiredHolds(100);
    return { data };
  }
}
