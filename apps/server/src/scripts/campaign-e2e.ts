/**
 * E2E-M2.1：Campaign 规划草稿 → 审批 → 授权（影子期不执行）全链（纯 HTTP + 真实库）。
 *
 * 两种引擎模式：
 *  - `--stub-engine`（默认）：本地起一个实现两个引擎端点的 stub（workspace 技术 quote +
 *    内部 draft 入口），并由它回调本仓 `/api/internal/v1/campaign-revisions`。
 *    用于没有部署引擎 M2.1-1 镜像时验证控制面状态机、幂等与审批链；
 *  - `--live`：走真实引擎（需引擎 M2.1-1 已发车，且本进程所在服务配置了
 *    ENGINE_ORIGIN / CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN）。
 *
 * 用法（stub 模式需要服务端用 ENGINE_ORIGIN 指向 stub 端口启动）：
 *   BASE_URL=http://127.0.0.1:14020 E2E_EMAIL=... E2E_PASSWORD=... \
 *   CAMPAIGN_INTERNAL_SERVICE_TOKEN=... CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN=... \
 *   pnpm --filter @gain-saas/server exec tsx src/scripts/campaign-e2e.ts --stub-engine --stub-port 13999
 *
 * 证据输出：stdout 末行 `E2E_RESULT {...}`（job/revision/approval/authorization/trace 计数）。
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

type Json = Record<string, unknown>;

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:14020';
const EMAIL = process.env.E2E_EMAIL ?? '';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const SERVICE_TOKEN = process.env.CAMPAIGN_INTERNAL_SERVICE_TOKEN ?? '';
const ENGINE_TOKEN = process.env.CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN ?? '';
const LIVE = process.argv.includes('--live');

function fail(message: string): never {
  process.stderr.write(`E2E_FAIL ${message}\n`);
  process.exit(1);
}

async function readJson(response: Response): Promise<Json> {
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as Json) : {};
  } catch {
    return { raw: text };
  }
}

class Session {
  private cookie = '';

  async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Json }> {
    const response = await fetch(new URL(path, BASE_URL), {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) {
      const pair = entry.split(';', 1)[0]!;
      if (pair.includes('=')) this.cookie = pair;
    }
    return { status: response.status, body: await readJson(response) };
  }
}

function planFor(icpId: string, objective: string): Json {
  return {
    schemaVersion: 'campaign-plan/v0',
    goal: { objective },
    audience: { icpIds: [icpId], sizeCap: 50 },
    motions: [{ type: 'discovery', icpIds: [icpId] }],
    budget: { currency: 'USD' },
    approvalPolicy: { required: true },
    decisionPolicy: { maxReplans: 0 },
  };
}

/** 引擎 stub：quote + 内部 draft 入口；交付时回调本仓（服务令牌与真实引擎同形）。 */
function startStubEngine(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Json) : {};
      const url = request.url ?? '';
      const json = (status: number, payload: Json): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (url === '/api/v1/execution-budget/workspace-technical-quote' && request.method === 'POST') {
        // 真实引擎从租户 JWT 取 workspaceId；stub 只解码 claim（不验签，stub 无需信任根）。
        const authorization = String(request.headers.authorization ?? '');
        const claims = (() => {
          try {
            const payload = authorization.replace(/^Bearer\s+/i, '').split('.')[1] ?? '';
            return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Json;
          } catch {
            return {} as Json;
          }
        })();
        const operation = String(body.operation ?? '');
        if (operation !== 'POST /campaigns/:campaignId/plan-drafts') {
          return json(400, { error: { code: 'UNEXPECTED_OPERATION' } });
        }
        const campaignId = String(body.campaignId ?? '');
        const inner = (body.body ?? {}) as Json;
        const requestSha256 = createHash('sha256')
          .update(JSON.stringify({ operation, campaignId, body: inner }))
          .digest('hex');
        return json(200, {
          data: {
            schemaVersion: 'execution-budget-technical-quote/v1',
            authorityKind: 'WORKSPACE_GRANT',
            operation,
            workspaceId: String(claims.workspace ?? ''),
            purpose: 'campaign.plan',
            subjectType: 'campaign',
            subjectId: campaignId,
            requestSha256,
            currency: 'USD',
            unit: 'microusd',
            requiredCapMicrousd: '600000',
            policyRevision: 'e2e-stub',
            expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
          },
        });
      }

      if (url === '/api/v1/internal/campaign-plans/draft' && request.method === 'POST') {
        if (request.headers['x-service-token'] !== ENGINE_TOKEN) {
          return json(401, { error: { code: 'SERVICE_TOKEN_INVALID' } });
        }
        if (typeof request.headers['x-execution-budget-grant'] !== 'string') {
          return json(400, { error: { code: 'EXECUTION_BUDGET_GRANT_REQUIRED' } });
        }
        const draft = body as {
          workspaceId: string;
          campaignId: string;
          jobId: string;
          objective: string;
        };
        json(202, { data: { jobId: draft.jobId } });
        // 模拟引擎工作流异步回调（幂等：真实引擎与 stub 一样可能重试）。
        const plan = planFor(randomUUID(), draft.objective);
        setTimeout(() => {
          const callbackUrl = new URL('/api/internal/v1/campaign-revisions', BASE_URL);
          void fetch(callbackUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-service-token': SERVICE_TOKEN,
            },
            body: JSON.stringify({
              jobId: draft.jobId,
              workspaceId: draft.workspaceId,
              campaignId: draft.campaignId,
              plan,
            }),
          }).catch(() => undefined);
        }, 200);
        return;
      }

      json(404, { error: { code: 'NOT_FOUND' } });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) fail('需要 E2E_EMAIL / E2E_PASSWORD（租户 admin 账号）');
  if (!SERVICE_TOKEN) fail('需要 CAMPAIGN_INTERNAL_SERVICE_TOKEN（回调服务令牌）');
  let stub: Server | null = null;
  if (!LIVE) {
    if (!ENGINE_TOKEN) fail('stub 模式需要 CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN');
    const port = Number(process.env.E2E_STUB_PORT ?? 13999);
    stub = await startStubEngine(port);
    process.stderr.write(`E2E stub engine on 127.0.0.1:${port}\n`);
  }

  const session = new Session();
  const login = await session.call('POST', '/api/auth/login', {
    email: EMAIL,
    password: PASSWORD,
  });
  if (login.status !== 200) fail(`login HTTP ${login.status}`);
  if ((login.body.data as Json)?.role !== undefined && (login.body.data as Json).role !== 'admin') {
    fail('需要 admin 账号');
  }

  const name = `E2E M2.1 ${new Date().toISOString()}`;
  const created = await session.call('POST', '/api/campaigns', {
    name,
    objective: '在德国找 30 家泵类分销商（E2E）',
  });
  if (created.status !== 201 && created.status !== 200) fail(`create campaign HTTP ${created.status}`);
  const campaignId = String((created.body.data as Json).id);
  process.stderr.write(`campaign ${campaignId}\n`);

  const draftResponse = await session.call(
    'POST',
    `/api/campaigns/${campaignId}/plan-drafts`,
    {},
  );
  if (draftResponse.status !== 202) {
    fail(`plan-drafts HTTP ${draftResponse.status}: ${JSON.stringify(draftResponse.body)}`);
  }
  const jobId = String((draftResponse.body.data as Json).id);

  const deadline = Date.now() + 120_000;
  let jobState = '';
  while (Date.now() < deadline) {
    const poll = await session.call('GET', `/api/campaigns/${campaignId}/plan-drafts/${jobId}`);
    if (poll.status !== 200) fail(`poll HTTP ${poll.status}`);
    jobState = String((poll.body.data as Json).state);
    if (jobState === 'SUCCEEDED' || jobState === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (jobState !== 'SUCCEEDED') fail(`job ended ${jobState}`);

  const detail = await session.call('GET', `/api/campaigns/${campaignId}`);
  if (detail.status !== 200) fail(`detail HTTP ${detail.status}`);
  const revisions = (detail.body.data as Json).revisions as Json[];
  const revision = revisions[0]!;
  if (revision.state !== 'DRAFT') fail(`revision state ${String(revision.state)}`);

  const submit = await session.call(
    'POST',
    `/api/campaigns/${campaignId}/revisions/${String(revision.id)}/submit`,
    {},
  );
  if (submit.status !== 201 && submit.status !== 200) fail(`submit HTTP ${submit.status}`);
  const approvalId = String(((submit.body.data as Json).approval as Json).id);

  const decide = await session.call(
    'POST',
    `/api/campaigns/${campaignId}/approvals/${approvalId}/decide`,
    { decision: 'approve' },
  );
  if (decide.status !== 201 && decide.status !== 200) fail(`approve HTTP ${decide.status}`);
  const authorization = ((decide.body.data as Json).authorization ?? null) as Json | null;
  if (!authorization || authorization.state !== 'ISSUED') {
    fail(`authorization not issued: ${JSON.stringify(authorization)}`);
  }

  const trace = await session.call('GET', `/api/campaigns/${campaignId}/trace`);
  if (trace.status !== 200) fail(`trace HTTP ${trace.status}`);

  // 影子期口径：**结构证明**——授权已签发，但本仓不存在任何消费授权去执行动作的接线
  // （无执行器/无调用方；由 campaign-execution-wiring.absence.spec.ts 钉住源码层面
  // 「无调用路径」）。脚本只断言授权已签发，不输出任何自证的 shadow 字段；
  // 执行接通与 CAMPAIGN_EXECUTION_SHADOW 闸门只能在 M2.2 出现（设计 D-M2.1-c）。
  const traceItems = ((trace.body.data as Json)?.items as unknown[]) ?? [];
  const evidence = {
    campaignId,
    jobId,
    jobState,
    revisionId: String(revision.id),
    planHash: String(revision.planHash),
    approvalId,
    authorizationId: String(authorization.id),
    authorizationState: String(authorization.state),
    traceEntries: traceItems.length,
  };
  process.stdout.write(`E2E_RESULT ${JSON.stringify(evidence)}\n`);
  stub?.close();
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
