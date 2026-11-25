import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { OutreachBatchController } from './outreach-batch.controller.js';
import type { OutreachBatchService } from './outreach-batch.service.js';
import type { OutreachAuthorizationIssuer } from '../campaign/outreach-authorization.issuer.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const POINT = '44444444-4444-4444-8444-444444444444';

function fakeReq(): Request {
  return {
    tenant: { userId: 'user-a', workspaceId: WS, role: 'admin' },
  } as unknown as Request;
}

describe('OutreachBatchController（draftBody 透传 contactPointId 与 countryCode）', () => {
  it('新增与编辑草稿时保留 contactPointId（不被 Zod 剥离）', async () => {
    const batches = {
      addDraft: vi.fn(async (_t, _b, data) => ({ id: DRAFT, ...data })),
      updateDraft: vi.fn(async (_t, _b, _d, data) => ({ id: DRAFT, ...data })),
    };
    const controller = new OutreachBatchController(
      batches as unknown as OutreachBatchService,
      {} as unknown as OutreachAuthorizationIssuer,
    );

    const payload = {
      contactRef: CONTACT,
      contactPointId: POINT,
      recipientEmail: 'buyer@refeel.it',
      companyName: 'Refeel Solar S.r.l.',
      countryCode: 'it',
      subject: 'HJT 700W Modules',
      body: 'Hello team',
    };

    await controller.addDraft(fakeReq(), BATCH, payload);
    expect(batches.addDraft).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
      BATCH,
      expect.objectContaining({
        contactRef: CONTACT,
        contactPointId: POINT,
        countryCode: 'IT',
      }),
    );

    await controller.updateDraft(fakeReq(), BATCH, DRAFT, {
      ...payload,
      subject: 'Updated subject',
    });
    expect(batches.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
      BATCH,
      DRAFT,
      expect.objectContaining({
        contactPointId: POINT,
        countryCode: 'IT',
      }),
    );
  });
});
