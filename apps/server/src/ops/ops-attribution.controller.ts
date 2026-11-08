import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { OpsAttributionService } from './ops-attribution.service.js';
import { OpsGuard } from './ops.guard.js';

/**
 * M2 步 12-1：运营台归因闭环（ops 只读）。租户侧不可达；不做对外输出（D-MA-9 k 抑制
 * 口径只约束对外聚合，本页是内部驾驶舱）。
 */
@Controller('api/ops')
@UseGuards(OpsGuard)
export class OpsAttributionController {
  constructor(private readonly attribution: OpsAttributionService) {}

  /** 漏斗 + 逐 campaign 明细 + 台账对账徽标（diff≠0 即红）。 */
  @Get('workspaces/:id/attribution')
  workspaceAttribution(@Param('id') id: string) {
    return this.attribution.attribution(id);
  }
}
