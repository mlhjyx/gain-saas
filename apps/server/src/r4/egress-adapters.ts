import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { OpsDatabase } from '../ops/ops-database.service.js';
import type { ExpectedPolicy, FenceRow, FenceStore, InstallParams, QuoteSource } from './egress-policy.service.js';

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * egress 期望值来自「在引擎容器内跑既有推导」生成的 JSONL
 * （2026-10-01 用的同一支脚本，见 _archive/platform-egress-policy-install-xin-20261001）。
 *
 * 为什么不直接调 technical-quote 端点：那个端点要求 scheduleRequestSha256、固定
 * workflowRunId 等契约输入，只有引擎内部有；在外部重算等于复制引擎的计价逻辑。
 * 因此期望值以推导产物为准，引擎仍是唯一算法来源。
 */
@Injectable()
export class FileQuoteSource implements QuoteSource {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async expected(): Promise<Map<string, ExpectedPolicy>> {
    const file = this.config.R4_EGRESS_EXPECTED_FILE;
    if (!file) throw new Error('未配置 R4_EGRESS_EXPECTED_FILE');
    const text = readFileSync(file, 'utf8');
    const map = new Map<string, ExpectedPolicy>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.schedule !== 'string') throw new Error('期望值缺少 schedule');
      if (row.error) continue; // 推导失败的行不参与比较，安装时按「报价缺失」处理
      if (typeof row.policy !== 'string' || !HEX64.test(row.policy)) throw new Error(`${row.schedule}: policy 摘要非法`);
      if (typeof row.envelope !== 'string' || !HEX64.test(row.envelope)) throw new Error(`${row.schedule}: envelope 摘要非法`);
      if (typeof row.capMicrousd !== 'string' || !DECIMAL.test(row.capMicrousd)) throw new Error(`${row.schedule}: cap 非法`);
      map.set(row.schedule, {
        policyRevision: typeof row.policyRevision === 'string' ? row.policyRevision : row.policy,
        policyArtifactSha256: row.policy,
        executionEnvelopeSha256: row.envelope,
        requiredCapMicrousd: row.capMicrousd,
      });
    }
    return map;
  }
}

/** 引擎库的围栏表：只允许读全表与调用安装函数两条语句（owner 池）。 */
@Injectable()
export class PgFenceStore implements FenceStore {
  constructor(private readonly ops: OpsDatabase) {}

  private pool() {
    const pool = this.ops.db.ownerPool;
    if (!pool) throw new Error('未配置 OPS_OWNER_DATABASE_URL，无法读写围栏表');
    return pool;
  }

  async readAll(): Promise<FenceRow[]> {
    const { rows } = await this.pool().query(
      `SELECT schedule_id, generation::text AS generation, state,
              policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd::text AS required_cap_microusd
         FROM platform_egress_schedule_fence ORDER BY schedule_id`,
    );
    return rows.map((row) => ({
      scheduleId: String(row.schedule_id),
      generation: Number(row.generation),
      state: String(row.state),
      policyArtifactSha256: String(row.policy_artifact_sha256),
      executionEnvelopeSha256: String(row.execution_envelope_sha256),
      requiredCapMicrousd: String(row.required_cap_microusd),
    }));
  }

  async install(params: InstallParams): Promise<{ generation: number; replay: boolean }> {
    const { rows } = await this.pool().query(
      `SELECT * FROM install_platform_egress_policy_v2($1,$2,$3,$4,$5::bigint)`,
      [
        params.scheduleId,
        params.expectedGeneration,
        params.policyArtifactSha256,
        params.executionEnvelopeSha256,
        params.requiredCapMicrousd,
      ],
    );
    const row = rows[0] ?? {};
    const generation = Number(row.generation ?? row.new_generation ?? params.expectedGeneration + 1);
    const replay = Boolean(row.replay ?? false);
    return { generation, replay };
  }
}
