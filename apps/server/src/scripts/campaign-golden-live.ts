/**
 * M2.2 golden 金丝雀 harness（设计 §4：跑批走真实规划链路）。
 *
 * 对 golden briefs 目录逐条：用金丝雀租户建战役 → POST plan-drafts（真实 quote+Grant+引擎
 * 工作流）→ 轮询 job 至终态 → 导出该 revision 的 plan JSON 到 `<out>/<brief-id>.plan.json`。
 * 随后在 backend 仓用闭集断言层评估（两仓职责不串）：
 *
 *   pnpm campaign:golden --replay <out> [--baseline 上次结果.json] [--out 结果.json]
 *
 * 用法：
 *   BASE_URL=http://127.0.0.1:4020 E2E_EMAIL=... E2E_PASSWORD=... \
 *   pnpm --filter @gain-saas/server exec tsx src/scripts/campaign-golden-live.ts \
 *     --briefs /global/backend/evals/golden-campaign-briefs --out /tmp/golden-live
 *
 * 证据：stdout 末行 `GOLDEN_LIVE_RESULT {...}`（每条 brief 的 job/revision/终态）。
 * 至少一个 brief 未 SUCCEEDED 时退出码 1。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:4020';
const EMAIL = process.env.E2E_EMAIL ?? '';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const POLL_INTERVAL_MS = 2000;

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  return fallback;
}

function fail(message: string): never {
  process.stderr.write(`GOLDEN_LIVE_FAIL ${message}\n`);
  process.exit(1);
}

async function readJsonBody(response: Response): Promise<Json> {
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as Json) : {};
  } catch {
    return { raw: text };
  }
}

class Session {
  private cookie = '';

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
    const response = await fetch(new URL(path, BASE_URL), {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';', 1)[0]!;
      if (pair.includes('=')) this.cookie = pair;
    }
    return { status: response.status, body: await readJsonBody(response) };
  }
}

interface BriefAsset {
  id?: unknown;
  brief?: { objective?: unknown; icpSummary?: unknown; budgetCapMicros?: unknown };
}

interface LiveResult {
  briefId: string;
  campaignId: string | null;
  jobId: string | null;
  state: string;
  revisionId: string | null;
  planPath: string | null;
}

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) fail('E2E_EMAIL / E2E_PASSWORD are required (canary tenant)');
  const briefsDir = arg('briefs');
  const outDir = arg('out');
  if (!briefsDir || !outDir) fail('--briefs <dir> and --out <dir> are required');
  const timeoutMs = Number(arg('timeout-ms', '240000'));

  const briefFiles = readdirSync(briefsDir)
    .filter((name) => name.endsWith('.json') && name !== 'README.md')
    .sort();
  if (briefFiles.length === 0) fail(`no brief assets under ${briefsDir}`);

  const session = new Session();
  const login = await session.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200 && login.status !== 204) {
    fail(`login failed (HTTP ${login.status})`);
  }

  mkdirSync(outDir, { recursive: true });
  const results: LiveResult[] = [];
  const runTag = new Date().toISOString().replace(/[:.]/gu, '-');

  for (const file of briefFiles) {
    const asset = JSON.parse(readFileSync(join(briefsDir, file), 'utf8')) as BriefAsset;
    const briefId = typeof asset.id === 'string' ? asset.id : file.replace(/\.json$/u, '');
    const objectiveRaw =
      typeof asset.brief?.objective === 'string' ? asset.brief.objective : `golden ${briefId}`;
    const icpSummary = typeof asset.brief?.icpSummary === 'string' ? asset.brief.icpSummary : '';
    // 引擎入口拒绝控制字符：用空格拼接而非换行。
    const objective = `${objectiveRaw}${icpSummary ? `（ICP：${icpSummary}）` : ''}`.slice(0, 500);
    const budgetCapMicros =
      typeof asset.brief?.budgetCapMicros === 'number' ? asset.brief.budgetCapMicros : undefined;

    const created = await session.call('POST', '/api/campaigns', {
      name: `E2E-M2.2-${runTag}:${briefId}`,
      objective,
    });
    const campaignId =
      created.status === 201 || created.status === 200
        ? String((created.body.data as Json | undefined)?.id ?? created.body.id ?? '')
        : '';
    if (!campaignId) {
      results.push({ briefId, campaignId: null, jobId: null, state: 'CAMPAIGN_CREATE_FAILED', revisionId: null, planPath: null });
      continue;
    }

    const draft = await session.call('POST', `/api/campaigns/${campaignId}/plan-drafts`, {
      objective,
      ...(budgetCapMicros !== undefined ? { budgetCapMicros } : {}),
    });
    const jobId =
      draft.status === 201 || draft.status === 202 || draft.status === 200
        ? String((draft.body.data as Json | undefined)?.id ?? '')
        : '';
    if (!jobId) {
      results.push({ briefId, campaignId, jobId: null, state: `DRAFT_FAILED_HTTP_${draft.status}`, revisionId: null, planPath: null });
      continue;
    }

    let state = 'RUNNING';
    let revisionId: string | null = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await session.call('GET', `/api/campaigns/${campaignId}/plan-drafts/${jobId}`);
      const jobData = (job.body.data as Json | undefined) ?? job.body;
      state = String(jobData.state ?? 'RUNNING');
      if (state === 'SUCCEEDED') {
        revisionId = typeof jobData.revisionId === 'string' ? jobData.revisionId : null;
        break;
      }
      if (state === 'FAILED' || state === 'NEEDS_HUMAN') break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (state === 'RUNNING') state = 'TIMEOUT';

    let planPath: string | null = null;
    if (state === 'SUCCEEDED' && revisionId) {
      const detail = await session.call('GET', `/api/campaigns/${campaignId}`);
      const data = (detail.body.data as Json | undefined) ?? detail.body;
      const revisions = Array.isArray(data.revisions) ? (data.revisions as Json[]) : [];
      const revision = revisions.find((entry) => String(entry.id) === revisionId);
      if (revision && revision.plan !== undefined) {
        planPath = join(outDir, `${briefId}.plan.json`);
        writeFileSync(planPath, `${JSON.stringify(revision.plan, null, 2)}\n`);
      }
    }
    results.push({ briefId, campaignId, jobId, state, revisionId, planPath });
  }

  const failed = results.filter((entry) => entry.state !== 'SUCCEEDED' || entry.planPath === null);
  process.stdout.write(`GOLDEN_LIVE_RESULT ${JSON.stringify({ outDir, results })}\n`);
  if (failed.length > 0) {
    process.stderr.write(`golden live: ${String(failed.length)}/${String(results.length)} brief(s) failed\n`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  fail(String(error));
});
