import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CampaignService } from './campaign.service.js';

const createCampaignBody = z.object({
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().max(500).optional(),
});

const decideBody = z.object({
  decision: z.enum(['approve', 'decline']),
  reason: z.string().max(500).optional(),
});

const revokeBody = z.object({
  reason: z.string().max(200).optional(),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** M2.0 Campaign 控制面（docs/technical/campaign-control-plane-m2-0.md §6.1）。 */
@Controller('api/campaigns')
@UseGuards(TenantGuard)
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  @Get()
  async list(@Req() req: Request) {
    const data = await this.campaigns.listCampaigns(req.tenant!);
    return { data };
  }

  @Get(':campaignId')
  async detail(@Req() req: Request, @Param('campaignId') campaignId: string) {
    const data = await this.campaigns.getCampaignDetail(req.tenant!, campaignId);
    return { data };
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Req() req: Request, @Body() body: unknown) {
    const parsed = createCampaignBody.safeParse(body);
    if (!parsed.success) invalid('name 必填且不超过 200 字');
    const data = await this.campaigns.createCampaign(req.tenant!, parsed.data);
    return { data };
  }

  @Post(':campaignId/revisions')
  @UseGuards(AdminGuard)
  async createRevision(
    @Req() req: Request,
    @Param('campaignId') campaignId: string,
    @Body() body: unknown,
  ) {
    const data = await this.campaigns.createRevision(req.tenant!, campaignId, body);
    return {
      data: {
        id: data.id,
        revisionNo: data.revisionNo,
        state: data.state,
        planHash: data.planHash,
        createdAt: data.createdAt,
      },
    };
  }

  @Post(':campaignId/revisions/:revisionId/submit')
  @UseGuards(AdminGuard)
  async submit(
    @Req() req: Request,
    @Param('campaignId') campaignId: string,
    @Param('revisionId') revisionId: string,
  ) {
    const data = await this.campaigns.submitRevision(req.tenant!, campaignId, revisionId);
    return {
      data: {
        revision: {
          id: data.revision.id,
          revisionNo: data.revision.revisionNo,
          state: data.revision.state,
        },
        approval: {
          id: data.approval.id,
          state: data.approval.state,
          expiresAt: data.approval.expiresAt,
        },
      },
    };
  }

  @Post(':campaignId/approvals/:approvalId/decide')
  @UseGuards(AdminGuard)
  async decide(
    @Req() req: Request,
    @Param('campaignId') campaignId: string,
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
  ) {
    const parsed = decideBody.safeParse(body);
    if (!parsed.success) invalid('decision 必须是 approve 或 decline');
    const data = await this.campaigns.decideApproval(req.tenant!, campaignId, approvalId, parsed.data);
    return {
      data: {
        approval: {
          id: data.approval.id,
          state: data.approval.state,
          decidedBy: data.approval.decidedBy,
          decidedAt: data.approval.decidedAt,
        },
        authorization: data.authorization
          ? {
              id: data.authorization.id,
              state: data.authorization.state,
              expiresAt: data.authorization.expiresAt,
              maxUses: data.authorization.maxUses,
            }
          : null,
      },
    };
  }

  @Post(':campaignId/authorizations/:authorizationId/revoke')
  @UseGuards(AdminGuard)
  async revoke(
    @Req() req: Request,
    @Param('campaignId') campaignId: string,
    @Param('authorizationId') authorizationId: string,
    @Body() body: unknown,
  ) {
    const parsed = revokeBody.safeParse(body ?? {});
    const data = await this.campaigns.revokeAuthorization(
      req.tenant!,
      campaignId,
      authorizationId,
      parsed.success ? parsed.data.reason : undefined,
    );
    return { data: { id: data.id, state: data.state, revokedAt: data.revokedAt } };
  }

  @Get(':campaignId/trace')
  async trace(
    @Req() req: Request,
    @Param('campaignId') campaignId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = Number.parseInt(limit ?? '50', 10);
    const data = await this.campaigns.listTrace(
      req.tenant!,
      campaignId,
      cursor,
      Number.isFinite(parsedLimit) ? parsedLimit : 50,
    );
    return { data };
  }
}
