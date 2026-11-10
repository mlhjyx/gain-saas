#!/usr/bin/env node
/**
 * 离线校验固定的引擎 OpenAPI 合同与 engine-contract.lock.json 一致。
 *
 * CI 不需要运行中的引擎：合同是显式 pin（允许落后于引擎 head，升级单独走 PR），
 * 本脚本证明「仓库里的合同字节没有在锁文件之外被改动」；schema.d.ts 是否与合同
 * 一致由 CI 的 gen:types + git diff 检查。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_SCHEMA = 'engine-contract-pin/v1';

const here = dirname(fileURLToPath(import.meta.url));
const contractPath = join(here, '..', 'src', 'openapi.json');
const lockPath = join(here, '..', 'engine-contract.lock.json');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (lock.schemaVersion !== SUPPORTED_SCHEMA) {
  console.error(
    `engine-contract.lock.json: unsupported schemaVersion ${JSON.stringify(lock.schemaVersion)}`,
  );
  process.exit(1);
}
// 摘要按 16 位十六进制分段存储（连字符分隔），避免被密钥扫描器当成高熵
// 凭据而要求维护 suppression；比较前去掉分隔符。
const pinned = String(lock.specDigest ?? '')
  .replaceAll('-', '')
  .toLowerCase();
if (!/^[0-9a-f]{64}$/.test(pinned)) {
  console.error(
    `engine-contract.lock.json: specDigest must be 64 hex digits (dashes allowed as separators), got ${JSON.stringify(lock.specDigest)}`,
  );
  process.exit(1);
}
const actual = createHash('sha256')
  .update(readFileSync(contractPath))
  .digest('hex');
if (actual !== pinned) {
  console.error('engine OpenAPI contract does not match engine-contract.lock.json');
  console.error(`  pinned: ${lock.specDigest}`);
  console.error(`  actual: ${actual}`);
  console.error(
    "Regenerate with 'pnpm gen:engine' and update engine-contract.lock.json in the same PR.",
  );
  process.exit(1);
}
console.log(`engine contract pin OK (sha256 ${actual})`);
