#!/usr/bin/env node
/**
 * 引擎侧对接验签(engine-integration.md §4 的自动化部分)。
 * 以 xin 身份运行:node /global/gain-saas/deploy/verify-engine-integration.mjs
 *
 * 覆盖:JWKS(经 https 回环端点)不含私钥 → SaaS 铸造三种角色的 token → 引擎接受
 * (JWKS 验签 + iss/aud + workspace claim + role→scope 映射)→ R4 fence-ack 仍可用。
 * 不覆盖:浏览器 cookie 会话与完整 UI 链路(§4 仍需人工点一次)。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const require = createRequire('/global/gain-saas/apps/server/package.json');
const { SignJWT, importPKCS8 } = await import(pathToFileURL(require.resolve('jose')).href);

const URL_BASE = process.env.GAIN_SAAS_URL ?? 'http://127.0.0.1:4020';
const ENGINE = process.env.ENGINE_ORIGIN ?? 'http://127.0.0.1:3000';
const CA_PATH = process.env.GAIN_SAAS_JWKS_CA ?? '/global/gain-saas/deploy/tls/ca.pem';

require('dotenv').config({ path: '/global/gain-saas/.env', quiet: true });
const privateKey = await importPKCS8(process.env.ENGINE_JWT_PRIVATE_KEY, 'RS256');
const issuer = process.env.ENGINE_JWT_ISSUER ?? 'https://127.0.0.1:18446';
const audience = process.env.ENGINE_JWT_AUDIENCE ?? 'global-backend';
const kid = process.env.ENGINE_JWT_KEY_ID ?? '';
const budgetIssuer = process.env.ENGINE_BUDGET_GRANT_ISSUER ?? 'https://127.0.0.1:18446/execution-budget';
const budgetKid = process.env.ENGINE_BUDGET_GRANT_KEY_ID ?? '';
const budgetJwksUrl = new URL('/.well-known/execution-budget-jwks.json', budgetIssuer).href;
const jwksUrl = new URL('/.well-known/jwks.json', issuer).href;

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function getJson(url, caPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const options = { timeout: 10_000 };
    if (parsed.protocol === 'https:' && caPath && fs.existsSync(caPath)) {
      options.ca = fs.readFileSync(caPath);
    }
    const request = client.get(url, options, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        } catch {
          reject(new Error(`HTTP ${response.statusCode} 非 JSON`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

async function mint(role, workspaceId) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ workspace: workspaceId, roles: [role] })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(role)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(privateKey);
}

async function call(role, path, workspaceId) {
  const token = await mint(role, workspaceId);
  const response = await fetch(`${ENGINE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: response.status, body };
}

const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];

// 1a. SaaS 本地 JWKS:密钥内容(与引擎最终看到的同一份)
try {
  const local = await getJson(`${URL_BASE}/.well-known/jwks.json`);
  const key = local.body?.keys?.[0] ?? {};
  const leaked = PRIVATE_JWK_MEMBERS.filter((member) => member in key);
  report('SaaS JWKS 不含私钥成分', leaked.length === 0, leaked.length ? `泄露字段: ${leaked.join(',')}` : `kid=${key.kid}`);
  report('签发合同与 JWKS 对齐', key.kid === kid, `iss=${issuer} aud=${audience} kid=${kid}`);
} catch (error) {
  report('SaaS 本地 JWKS', false, String(error.message ?? error));
}

// 1b. 引擎视角:https 回环端点(需 root 按文档 §1 配置)
try {
  const jwks = await getJson(jwksUrl, CA_PATH);
  const key = jwks.body?.keys?.[0] ?? {};
  report('引擎视角 JWKS 可达', jwks.status === 200 && key.kid === kid, `${jwksUrl} HTTP ${jwks.status} kid=${key.kid}`);
} catch (error) {
  report('引擎视角 JWKS 可达', false, `${jwksUrl} ${error.message}`);
}

// 1c. 预算 Grant JWKS(引擎 EXECUTION_BUDGET_GRANT_JWKS_URI)
try {
  const budget = await getJson(budgetJwksUrl, CA_PATH);
  const key = budget.body?.keys?.[0] ?? {};
  const leaked = PRIVATE_JWK_MEMBERS.filter((member) => member in key);
  report('预算 JWKS 可达(引擎视角)', budget.status === 200 && key.kid === budgetKid,
    `${budgetJwksUrl} HTTP ${budget.status} kid=${key.kid}`);
  report('预算 JWKS 不含私钥成分', leaked.length === 0, leaked.length ? `泄露字段: ${leaked.join(',')}` : `kid=${key.kid}`);
} catch (error) {
  report('预算 JWKS 可达(引擎视角)', false, `${budgetJwksUrl} ${error.message}`);
}

// 2. 取一个已登记、启用的 workspace(事件消费凭据按 workspace 签发)
let workspaceId = process.env.WORKSPACE_ID;
if (!workspaceId) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const row = await client.query('SELECT workspace_id::text FROM workspace_registry WHERE enabled ORDER BY updated_at DESC LIMIT 1');
    workspaceId = row.rows[0]?.workspace_id;
  } finally {
    await client.end();
  }
}
report('找到已登记的 workspace', Boolean(workspaceId), workspaceId ?? '先跑 pnpm bootstrap:backfill');

if (workspaceId) {
  // 3. 三种角色的引擎调用(200 即同时证明 JWKS/iss/aud/workspace claim/scope 映射全通)
  const consumer = await call('saas-event-consumer', '/api/v1/events?limit=1', workspaceId);
  report('saas-event-consumer 拉取事件', consumer.status === 200,
    `HTTP ${consumer.status}${consumer.body?.error ? ` ${consumer.body.error.code}` : ''}`);

  const admin = await call('saas-admin', '/api/v1/leads?limit=1', workspaceId);
  report('saas-admin 读取线索列表', admin.status === 200,
    `HTTP ${admin.status}${admin.body?.error ? ` ${admin.body.error.code}` : ''}`);

  const member = await call('saas-member', '/api/v1/companies?limit=1', workspaceId);
  report('saas-member 读取公司列表', member.status === 200,
    `HTTP ${member.status}${member.body?.error ? ` ${member.body.error.code}` : ''}`);

  const memberAck = await call('saas-member', '/api/v1/events?limit=1', workspaceId);
  report('saas-member 无 personal-data:read(应被拒)', memberAck.status === 403,
    `HTTP ${memberAck.status} ${memberAck.body?.error?.code ?? ''}`);
}

// 4. R4 回归护栏:AUTH_JWKS_URI 必须保持 https,否则撤销信任快照为 null,fence-ack 503
try {
  const fence = await fetch(`${ENGINE}/api/v1/platform-authority/fence-ack-jwks`, {
    signal: AbortSignal.timeout(10_000),
  });
  report('R4 fence-ack JWKS 仍可用', fence.status === 200, `HTTP ${fence.status}`);
} catch (error) {
  report('R4 fence-ack JWKS 仍可用', false, error.message);
}

// 4b. 引擎 readiness:auth_jwks 与 execution_budget_jwks 都必须是 ok
try {
  const ready = await fetch(`${ENGINE}/api/v1/health/ready`, { signal: AbortSignal.timeout(10_000) });
  const body = await ready.json().catch(() => ({}));
  const components = body.components ?? {};
  const budgetStatus = body.capabilities?.execution_budget_jwks?.status ?? components.execution_budget_jwks?.status;
  report('引擎 readiness', ready.ok && body.status === 'ready' && budgetStatus === 'ok',
    `auth_jwks=${components.auth_jwks?.status} execution_budget_jwks=${budgetStatus}`);
} catch (error) {
  report('引擎 readiness', false, error.message);
}

// 5. SaaS 侧健康与事件消费开关
const health = await fetch(`${URL_BASE}/health/ready`, { signal: AbortSignal.timeout(10_000) });
const healthBody = await health.json().catch(() => ({}));
report('SaaS /health/ready', health.ok, `engine=${healthBody?.checks?.engine?.ok}`);
console.log(`${healthBody?.capabilities?.event_consumer ? 'ℹ' : 'ℹ'} EVENT_CONSUMER_ENABLED=${
  healthBody?.capabilities?.event_consumer === true ? 'true(worker 正在消费)' : 'false(引擎配置生效后再开,见文档 §3)'
}`);

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
