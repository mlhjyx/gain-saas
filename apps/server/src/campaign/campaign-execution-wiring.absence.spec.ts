import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Campaign ExecutionAuthorization 接线结构证明。
 *
 * 历史：M2.1 影子期本文件是「无调用路径」的 absence spec（授权无消费者）。
 * P4 首波（第 5 章 P4-03）按 spec 交接约定改写为接线后的结构断言：
 * - 授权消费方 = outreach 发送执行器唯一的 OutreachAuthorizationConsumer；
 * - 签发/撤销仍由 campaign 服务独占，ops 只在 workspace 停用/归档时联动置 REVOKED；
 * - uses 递增（逐封消费）只允许发生在消费者内；
 * - CAMPAIGN_EXECUTION_SHADOW 影子闸门已实现（默认 on，行为测试在 outreach-send.service.spec.ts）；
 * - 发送的唯一外部出口是 outreach 模块内的 SMTP transport。
 */
const SOURCE_ROOT = join(import.meta.dirname, '..');

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // src/scripts 是运营者手动运行的 CLI（E2E/回填），不属于产品组合根，不参与接线扫描。
    if (entry.isDirectory()) return entry.name === 'scripts' ? [] : productionSources(path);
    return entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

const sources = productionSources(SOURCE_ROOT).map((path) => ({
  path,
  rel: relative(SOURCE_ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

describe('campaign execution wiring（P4 首波接线后的结构断言）', () => {
  it('only campaign issuance/revocation, the ops revocation hook, and the outreach consumer touch the authorization model', () => {
    const referencing = sources
      .filter((source) => source.text.includes('campaignExecutionAuthorization'))
      .map((source) => source.rel)
      .sort();
    // campaign 服务负责签发/撤销/校验；ops 只在 workspace 停用时联动撤销；
    // outreach 侧的 OutreachAuthorizationConsumer 是执行器唯一的只读消费点。
    expect(referencing).toEqual([
      'campaign/campaign.service.ts',
      'ops/ops.service.ts',
      'outreach/outreach-authorization.consumer.ts',
    ]);
  });

  it('uses 递增（逐封消费）只允许发生在授权消费者内', () => {
    const incrementers = sources
      .filter((source) => source.text.includes('uses: { increment'))
      .map((source) => source.rel);
    expect(incrementers).toEqual(['outreach/outreach-authorization.consumer.ts']);
  });

  it('ops 侧的引用仍是「置 REVOKED」的联动撤销，不是任何消费/执行', () => {
    const ops = sources.find((source) => source.rel === 'ops/ops.service.ts')!;
    const occurrences = ops.text.split('campaignExecutionAuthorization').length - 1;
    expect(occurrences).toBe(1);
    const around = ops.text.slice(
      Math.max(0, ops.text.indexOf('campaignExecutionAuthorization') - 200),
      ops.text.indexOf('campaignExecutionAuthorization') + 200,
    );
    expect(around).toContain("state: 'REVOKED'");
  });

  it('the only consumer of verifyAuthorization is the read-only internal verify endpoint', () => {
    const callers = sources
      .filter((source) => /\.verifyAuthorization\(/.test(source.text) && !source.rel.endsWith('campaign.service.ts'))
      .map((source) => source.rel)
      .sort();
    expect(callers).toEqual(['campaign/campaign-internal.controller.ts']);
  });

  it('outreach 不导入 campaign 服务（执行器不经过 campaign 模块，只读模型行）', () => {
    const importers = sources
      .filter(
        (source) =>
          !source.rel.startsWith('campaign/') &&
          /from ['"][^'"]*campaign\/(campaign\.service|campaign-plan-job\.service|campaign-token\.signer)\.js['"]/.test(
            source.text,
          ),
      )
      .map((source) => source.rel);
    expect(importers).toEqual([]);
  });

  it('the campaign module has exactly one outbound client, bound to the plan-draft endpoint only', () => {
    const campaignSources = sources.filter((source) => source.rel.startsWith('campaign/'));
    const fetchers = campaignSources
      .filter((source) => source.text.includes('fetch('))
      .map((source) => source.rel)
      .sort();
    expect(fetchers).toEqual(['campaign/campaign-plan-engine.client.ts']);
    const client = campaignSources.find(
      (source) => source.rel === 'campaign/campaign-plan-engine.client.ts',
    )!;
    const enginePaths = [...client.text.matchAll(/'(\/api\/[^']+)'/g)].map((match) => match[1]);
    expect(enginePaths).toEqual(['/api/v1/internal/campaign-plans/draft']);
  });

  it('影子闸门已实现：CAMPAIGN_EXECUTION_SHADOW 只出现在配置与发送执行器，默认 on', () => {
    const references = sources
      .filter((source) => source.text.includes('CAMPAIGN_EXECUTION_SHADOW'))
      .map((source) => source.rel)
      .sort();
    expect(references).toEqual(['config/configuration.ts', 'outreach/outreach-send.service.ts']);
    const config = sources.find((source) => source.rel === 'config/configuration.ts')!;
    expect(config.text).toContain("CAMPAIGN_EXECUTION_SHADOW: z.string().default('true')");
  });

  it('发送唯一出口：outreach 模块外的代码不直接引用 SMTP transport', () => {
    const importers = sources
      .filter(
        (source) =>
          !source.rel.startsWith('outreach/') && source.text.includes('outreach-smtp.transport'),
      )
      .map((source) => source.rel);
    expect(importers).toEqual([]);
  });
});
