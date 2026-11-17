import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OpsGuard, type OpsRequest } from '../ops/ops.guard.js';
import { CooperationIntentService } from './cooperation.service.js';

/** 运营台「合作意向」：只读列表 + 跟进状态/备注；独立于租户域。 */
@Controller('api/ops/cooperation-intents')
@UseGuards(OpsGuard)
export class CooperationIntentOpsController {
  constructor(private readonly intents: CooperationIntentService) {}

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const limit = typeof query.limit === 'string' ? Number(query.limit) : undefined;
    const offset = typeof query.offset === 'string' ? Number(query.offset) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new BadRequestException({ error: { code: 'VALIDATION_FAILED', message: 'limit 必须是正整数' } });
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      throw new BadRequestException({ error: { code: 'VALIDATION_FAILED', message: 'offset 必须是非负整数' } });
    }
    return this.intents.list({
      status: typeof query.status === 'string' ? query.status : undefined,
      limit,
      offset,
    });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: OpsRequest) {
    return {
      data: await this.intents.update({
        id,
        status: body.status,
        note: body.note,
        actorId: req.opsUser!.id,
      }),
    };
  }
}
