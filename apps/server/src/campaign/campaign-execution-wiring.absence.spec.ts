import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M2.1 影子期「无调用路径」结构证明（设计 2026-11-08-campaign-planner-m2-1 §8-1，D-M2.1-c）。
 *
 * v0 不交付任何执行接线：审批通过只签发 ExecutionAuthorization（业务动作边界凭据），
 * 但系统内**不存在**消费该授权去执行动作的代码路径——没有执行器、没有调度器、
 * 没有对外动作调用。`CAMPAIGN_EXECUTION_SHADOW` 闸门因此在本阶段是空真的；
 * M2.2 接执行方时**必须**同时实现该闸门（默认 on）并由本组断言改为闸门行为测试。
 *
 * 本 spec 用源码扫描把「无调用路径」钉成可回归的事实，而不是文档里的一句话。
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

describe('campaign execution wiring is absent (shadow period structural proof)', () => {
  it('only campaign issuance and the ops revocation hook touch the authorization model', () => {
    const referencing = sources
      .filter((source) => source.text.includes('campaignExecutionAuthorization'))
      .map((source) => source.rel)
      .sort();
    // campaign 服务负责签发/撤销/校验；ops 只在 workspace 停用时联动撤销（M2.0 设计），
    // 两处都不是执行路径。
    expect(referencing).toEqual(['campaign/campaign.service.ts', 'ops/ops.service.ts']);
    // ops 侧的这一次出现必须是「置 REVOKED」的联动撤销，而不是任何消费/执行。
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

  it('no module outside campaign/ imports the campaign service (no execution coordinator exists)', () => {
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
    // 该客户端只允许调用引擎的 draft 入口（外加本仓收据查询不在此文件），不含任何动作执行路径。
    const client = campaignSources.find(
      (source) => source.rel === 'campaign/campaign-plan-engine.client.ts',
    )!;
    const enginePaths = [...client.text.matchAll(/'(\/api\/[^']+)'/g)].map((match) => match[1]);
    expect(enginePaths).toEqual(['/api/v1/internal/campaign-plans/draft']);
  });

  it('does not claim a CAMPAIGN_EXECUTION_SHADOW gate before any executor exists', () => {
    // 空真的开关是假安全：M2.2 接执行方时再实现该闸门，并在此处替换为闸门行为测试。
    const references = sources
      .filter((source) => source.text.includes('CAMPAIGN_EXECUTION_SHADOW'))
      .map((source) => source.rel);
    expect(references).toEqual([]);
  });
});
