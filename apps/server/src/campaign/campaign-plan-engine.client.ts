import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  BadGatewayException,
  ConflictException,
} from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { EngineBudgetGrantService, EngineBudgetQuoteError } from '../bff/engine-budget-grant.service.js';
import type { CampaignTenant } from './campaign.service.js';

/**
 * M2.1：BFF → 引擎内部规划入口（引擎 `POST /api/v1/internal/campaign-plans/draft`）。
 *
 * 两步都在服务端完成、前端不接触任何令牌：
 *  1. 先向引擎取 `campaign.plan` 的 workspace 技术 quote，再用本仓已合入的
 *     EngineBudgetGrantSigner 签一次性 Grant（预算账户与引擎账本对齐）；
 *  2. 以 `x-service-token` 服务身份调用引擎内部端点（引擎 fail-closed：未配置 503）。
 *
 * 引擎异步执行：202 只表示工作流已启动；计划经内部回调落 DRAFT revision。
 */

const DRAFT_PATH = '/api/v1/internal/campaign-plans/draft';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface CampaignPlanEngineTriggerInput {
  workspaceId: string;
  campaignId: string;
  jobId: string;
  objective: string;
  icpId?: string;
  audienceSizeCap?: number;
  budgetCapMicros?: number;
}

export class CampaignPlanEngineError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignPlanEngineError';
  }
}

@Injectable()
export class CampaignPlanEngineClient {
  private readonly logger = new Logger(CampaignPlanEngineClient.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly budget: EngineBudgetGrantService,
  ) {}

  async trigger(
    tenant: Pick<CampaignTenant, 'userId' | 'workspaceId' | 'role'>,
    input: CampaignPlanEngineTriggerInput,
  ): Promise<void> {
    if (!this.config.CAMPAIGN_PLAN_JOB_ENABLED) {
      throw new ServiceUnavailableException({
        error: { code: 'CAMPAIGN_PLAN_JOB_DISABLED', message: 'Campaign 规划已停用' },
      });
    }
    const serviceToken = this.config.CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN;
    if (!serviceToken) {
      throw new ServiceUnavailableException({
        error: {
          code: 'CAMPAIGN_PLAN_ENGINE_NOT_CONFIGURED',
          message: 'Campaign 规划引擎通道未配置',
        },
      });
    }

    let grant: string;
    try {
      grant = await this.budget.issue(tenant, {
        operation: 'POST /campaigns/:campaignId/plan-drafts',
        campaignId: input.campaignId,
        body: { jobId: input.jobId },
      });
    } catch (error) {
      if (error instanceof EngineBudgetQuoteError) {
        throw new BadGatewayException({
          error: {
            code: 'CAMPAIGN_PLAN_QUOTE_FAILED',
            message: '执行预算 quote 失败',
            meta: { engineStatus: error.status },
          },
        });
      }
      throw error;
    }

    let response: Response;
    try {
      response = await fetch(new URL(DRAFT_PATH, this.config.ENGINE_ORIGIN), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': serviceToken,
          'X-Execution-Budget-Grant': grant,
        },
        body: JSON.stringify({
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          jobId: input.jobId,
          objective: input.objective,
          ...(input.icpId !== undefined ? { icpId: input.icpId } : {}),
          ...(input.audienceSizeCap !== undefined
            ? { audienceSizeCap: input.audienceSizeCap }
            : {}),
          ...(input.budgetCapMicros !== undefined
            ? { budgetCapMicros: input.budgetCapMicros }
            : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException({
        error: { code: 'CAMPAIGN_PLAN_ENGINE_UNAVAILABLE', message: '引擎不可达' },
      });
    }

    const text = await response.text().catch(() => '');
    const body =
      Buffer.byteLength(text, 'utf8') <= MAX_RESPONSE_BYTES && text.trim() !== ''
        ? (() => {
            try {
              return JSON.parse(text) as Record<string, unknown>;
            } catch {
              return null;
            }
          })()
        : null;

    if (response.status === 200 || response.status === 202) return;

    const engineCode =
      body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      typeof (body.error as Record<string, unknown>).code === 'string'
        ? ((body.error as Record<string, unknown>).code as string)
        : 'UNKNOWN';
    this.logger.warn(
      `campaign plan draft rejected by engine (HTTP ${response.status} ${engineCode})`,
    );
    if (response.status === 409) {
      throw new ConflictException({
        error: {
          code: 'CAMPAIGN_PLAN_ENGINE_CONFLICT',
          message: '规划触发与既有预算授权冲突，请重新发起',
        },
      });
    }
    if (response.status >= 400 && response.status < 500) {
      throw new CampaignPlanEngineError(
        'CAMPAIGN_PLAN_ENGINE_REJECTED',
        response.status,
        '引擎拒绝了规划请求',
      );
    }
    throw new BadGatewayException({
      error: { code: 'CAMPAIGN_PLAN_ENGINE_UNAVAILABLE', message: '引擎不可达' },
    });
  }
}
