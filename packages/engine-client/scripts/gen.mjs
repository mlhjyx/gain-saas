#!/usr/bin/env node
/**
 * 从运行中的引擎拉取 code-first OpenAPI 合同,落盘为 openapi.json。
 * SD7 铁律:引擎 OpenAPI 是唯一合同真值——本文件是合同进入 SaaS 的唯一入口。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_OPENAPI_URL =
  process.env.ENGINE_OPENAPI_URL ?? 'http://127.0.0.1:3000/api/docs-json';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'src', 'openapi.json');

const res = await fetch(ENGINE_OPENAPI_URL);
if (!res.ok) {
  console.error(`拉取引擎 OpenAPI 失败: ${res.status} ${ENGINE_OPENAPI_URL}`);
  console.error('确认引擎(gain-api)已启动,或用 ENGINE_OPENAPI_URL 指定地址。');
  process.exit(1);
}
const spec = await res.json();
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(spec, null, 2) + '\n');
console.log(
  `已生成 ${outPath}(openapi ${spec.openapi ?? '?'},${Object.keys(spec.paths ?? {}).length} 条路径,来源 ${ENGINE_OPENAPI_URL})`,
);
