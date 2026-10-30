# 内嵌模型网关(替代 new-api 的获客模型入口)

> 文档 ID:`DOC-SAAS-MODEL-GATEWAY-001`
> 生命周期:`CURRENT`
> 最后更新:2026-10-29

## 1. 为什么

引擎把**所有模型调用**收口到一个 OpenAI 兼容聚合网关,只需要 `MODEL_GATEWAY_URL` + `MODEL_GATEWAY_KEY` + 默认模型。此前这层由 new-api 承担,运营要另开 new-api 后台配渠道、令牌、额度。现在 gain-saas 内嵌这层网关,运营在 `/ops` → **模型网关** 里直接配置上游厂商和模型别名,不再依赖 new-api。

```text
引擎 api / worker ──POST /v1/chat/completions──▶ gain-saas 内嵌网关
                                                    │  按 model 别名选路由
                                                    ├─▶ DeepSeek / OpenAI / 火山 / Ollama …(各自 Key)
                                                    └─▶ model_call_log(只记元数据)
运营 /ops ──/api/ops/model-gateway──▶ 厂商 / 路由 / 测试 / 调用日志
```

## 2. 能力与边界

| 支持 | 说明 |
| --- | --- |
| OpenAI `POST /v1/chat/completions` | 非流式;转发 `messages/max_tokens/temperature/response_format/reasoning_effort` |
| `GET /v1/models` | 返回已配置的模型别名 |
| 别名路由 | 引擎请求名(如 `deepseek-v4-pro`)→ 厂商 + 上游真实模型;响应 `model` 回写为别名 |
| 默认路由 | 未命中别名时使用;运营可一键切换 |
| 多厂商回退 | 同一别名可配多个厂商,按厂商优先级依次尝试;上游 4xx/5xx 会尝试下一家,**超时不回退**(可能已计费/仍在生成) |
| 运营测试 | 单厂商发送最小 chat 请求,返回延迟/内容/上游错误 |
| 调用日志 | 时间、别名、上游模型、厂商、状态、延迟、token、错误;不存 prompt/补全 |

| 边界 | 说明 |
| --- | --- |
| 流式 SSE | 引擎设 `MODEL_GATEWAY_STREAM_CHAT_COMPLETIONS=false`(获客任务本来非流式) |
| 站点构建 settlement | 带 `X-New-API-Settlement-Request-Id/Nonce` 的调用与 `/responses`、`/messages`、`/embeddings` 透明转发给本机 new-api;`/api/settlement-readback/v1/capability` 由 gain-saas 本地应答,其余读回请求代理到 new-api。获客调用不经过 new-api |
| 配额/计费 | 本页只做模型路由与调用元数据;执行预算仍由引擎 Grant/预算体系控制 |

## 3. 配置步骤

### 3.1 gain-saas 侧

`.env` 已有(缺失时生成):

```bash
openssl rand -hex 32   # MODEL_GATEWAY_API_KEY:引擎调用 /v1 的 Bearer Key
openssl rand -hex 32   # MODEL_GATEWAY_ENC_KEY:上游 Key 落库加密材料
```

重启 gain-saas web 使 Key 生效。打开 `/ops` → **模型网关**:

1. 在预设卡片里选服务商(DeepSeek / OpenAI / 火山方舟 / 通义千问 / Kimi / 智谱 / Ollama / 自定义)。接口地址已预填,通常只需要粘贴 API Key。
2. 点**测试连接并获取模型**:系统会先读上游 `/models`,再用其中一个模型发一次最小请求;成功后直接列出可用模型。
3. 选一个**默认模型**,点**保存并启用**。所有引擎任务会先走这个默认模型,不需要理解模型别名。
4. 需要给不同任务指定不同模型时,再展开**高级:按模型别名路由**;日常配置不需要进入。

> Key 只以 AES-256-GCM 密文落库,界面不回显。轮换 `MODEL_GATEWAY_ENC_KEY` 后需要重新录入所有上游 Key。

### 3.1.1 推理模型的输出预算

DeepSeek V4 / 部分新模型把 reasoning token 也计入输出上限。引擎理解任务默认给 8192,复杂抽取会被截断,表现为 `STRUCTURED_OUTPUT_TRUNCATED`。在厂商「高级设置」里设置**最小输出预算**(例如 32768),网关会把 `max_tokens` 抬到该值;OpenAI 新推理模型可同时把字段名切为 `max_completion_tokens`。

> 这只解决截断;理解工作流若在 `persistOfferings` 报 `ExecutionControlError`,是引擎重复确认 crawl 回执导致的 `DOMAIN_ACK_MIXED_REPLAY_STATE`,不是模型网关。修复补丁见 `deploy/patches/engine-understanding-offerings-ack.patch`,需重新发布引擎 worker。

BFF 对 ICP、查询计划、接触草稿三个同步模型生成路由使用 240 秒超时(默认路由 30 秒),避免模型还在生成时前端收到 502。

### 3.2 站点构建 settlement 兼容(必须)

客户 worker 启动/心跳硬性检查 new-api 的 settlement readback;如果网关只实现了 `/v1`,worker 会永久停在 `STARTING`,`/health/ready` 返回 503(`worker: MATCHING_WORKER_NOT_READY`)。gain-saas 已内置兼容层:

- `GET /api/settlement-readback/v1/capability` 本地返回 `new-api-settlement-readback/v1` 契约;
- 其他 `/api/settlement-readback/*` 原样代理到 `MODEL_GATEWAY_SETTLEMENT_ORIGIN`(默认本机 new-api `:3001`);
- 带 settlement 头的模型调用和 `/v1/responses`、`/v1/messages`、`/v1/embeddings` 透传给 new-api(使用 `MODEL_GATEWAY_SETTLEMENT_API_KEY`,即切换前的 new-api 调度 Key)。

`.env` 需要:

```dotenv
MODEL_GATEWAY_SETTLEMENT_ORIGIN=http://127.0.0.1:3001
MODEL_GATEWAY_SETTLEMENT_API_KEY=<切换前引擎的 MODEL_GATEWAY_KEY>
```

> 这一层只保证站点构建/客户 worker 的结算链路不被网关切换打断。获客主链路的模型调用仍然走运营台配置的厂商,不经过 new-api。若将来彻底下线 new-api,站点构建需要另做等价结算实现。

### 3.3 引擎侧切换

先 dry-run,再 root 执行:

```bash
python3 /global/gain-saas/deploy/model-gateway-apply.py          # dry-run
sudo python3 /global/gain-saas/deploy/model-gateway-apply.py --apply
```

脚本做的事:

- 读 gain-saas `.env` 的 `MODEL_GATEWAY_API_KEY` 并检查 `/v1/models` 可达;
- 检查 `/api/settlement-readback/v1/capability` 为 ready(缺失会直接报错,避免 worker 卡 STARTING);
- 备份 `/global/backend/.secrets/backend-runtime.env` 到 `/global/_archive/model-gateway-gain-saas-xin-*`;
- 写入:
  ```dotenv
  MODEL_GATEWAY_URL=http://127.0.0.1:4020/v1
  MODEL_GATEWAY_KEY=<同 gain-saas MODEL_GATEWAY_API_KEY>
  MODEL_GATEWAY_STREAM_CHAT_COMPLETIONS=false
  ```
- 只重建 `api` / `worker`,不动 `platform-worker`;
- 等引擎 readiness。

回退:

```bash
sudo python3 /global/gain-saas/deploy/model-gateway-apply.py --rollback
```

### 3.4 验证

```bash
curl -s -H "Authorization: Bearer $MODEL_GATEWAY_API_KEY" http://127.0.0.1:4020/v1/models
```

在 `/ops` 看「最近调用」是否出现引擎请求。模型网关的 4xx/5xx 会原样体现上游失败原因,不再需要登录 new-api 排查。

## 4. 安全

- 管理面 `/api/ops/model-gateway/**` 只接受运营会话(`saas_ops_session`),与租户域隔离;
- 运行面 `/v1/**` 只接受 `MODEL_GATEWAY_API_KEY` Bearer,与运营/租户会话无关;
- 上游 Key 密文落库,接口只返回 `••••••••`;
- 调用日志不含 prompt/补全,避免个人数据进入运营库;
- 厂商 Base URL 仅允许 http(s),禁止 URL 内嵌账号密码;
- 所有厂商/路由变更写运营审计。

## 5. 常见问题

| 现象 | 处理 |
| --- | --- |
| 引擎 404 `model_not_found` | 没有该别名的路由,也没有默认路由;在运营台补一条 |
| 上游 401/403 | 该厂商 Key 或模型权限不对;用「测试」确认 |
| 上游 400 `response_format`/`reasoning_effort` 不支持 | 换支持 JSON 模式的模型,或换厂商 |
| 引擎仍然报 new-api 错误 | `model-gateway-apply.py --apply` 未执行或 api/worker 未重建;看 `backend-runtime.env` 的 `MODEL_GATEWAY_URL` |
| 引擎 `/health/ready` 503,`worker: MATCHING_WORKER_NOT_READY` | settlement readback 兼容代理没配/不可达;按 §3.2 配好并确认 `/api/settlement-readback/v1/capability` 返回 ready,再重建 worker |
| 站点构建报 settlement 错误 | new-api 的 `MODEL_GATEWAY_SETTLEMENT_ORIGIN/_API_KEY` 不可用;该链路仍依赖 new-api(见 §3.2) |
