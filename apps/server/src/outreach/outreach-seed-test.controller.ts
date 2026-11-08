import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachSeedTestService } from './outreach-seed-test.service.js';

const seedTestBody = z.object({
  domain: z.string().trim().min(3).max(253),
  provider: z.enum(['glockapps', 'inboxally', 'mailtester', 'manual']),
  testedAt: z.string().datetime().optional(),
  inboxPct: z.coerce.number().min(0).max(100).optional(),
  spamPct: z.coerce.number().min(0).max(100).optional(),
  missingPct: z.coerce.number().min(0).max(100).optional(),
  gmailInboxPct: z.coerce.number().min(0).max(100).optional(),
  outlookInboxPct: z.coerce.number().min(0).max(100).optional(),
  reportRef: z.string().trim().min(1).max(256),
  contentHash: z.string().trim().regex(/^[0-9a-fA-F]{64}$/),
  raw: z.unknown().optional(),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** 种子放置测试记录（P4-12 warmup/seed 周清单的后端支撑）。 */
@Controller('api/outreach/seed-tests')
@UseGuards(TenantGuard)
export class OutreachSeedTestController {
  constructor(private readonly seedTests: OutreachSeedTestService) {}

  @Get()
  async list(@Req() req: Request, @Query('domain') domain?: string) {
    return { data: await this.seedTests.list(req.tenant!, domain) };
  }

  @Post()
  @UseGuards(AdminGuard)
  async record(@Req() req: Request, @Body() body: unknown) {
    const parsed = seedTestBody.safeParse(body);
    if (!parsed.success) invalid('种子测试字段不合法');
    return { data: await this.seedTests.record(req.tenant!, parsed.data) };
  }
}
