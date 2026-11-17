# 官网合作意向 API（给官网前端调用）

> 文档 ID：`DOC-SAAS-API-COOPERATION-INTENTS-001`
> 生命周期：`CURRENT`
> 面向：官网（营销站）前端开发者
> 服务：gain-saas（NestJS）`/api/public/cooperation-intents`

官网「提交合作意向」表单直接把用户填写的内容 POST 到 SaaS。该端点**不需要登录、不携带 cookie**；
收到的线索落在 gain-saas 自有库，运营在运营台 `/ops` → 「合作意向」查看与跟进。

## 1. 端点

| 项 | 值 |
| --- | --- |
| 方法 / 路径 | `POST /api/public/cooperation-intents` |
| 生产地址 | `https://<gain-saas 域名>/api/public/cooperation-intents`（本机部署为 `http://100.68.31.20:4020`） |
| 请求体 | `application/json; charset=utf-8`（也接受 `application/x-www-form-urlencoded`） |
| body 上限 | 16 KB |
| 认证 | 无（公开端点） |
| 幂等 | 不要求 `Idempotency-Key`；重复提交会各生成一条记录（请在前端提交成功后禁用按钮） |

### CORS

服务端按环境变量 `PUBLIC_COOPERATION_ALLOWED_ORIGINS` 决定允许的来源（逗号分隔；`*` 或留空 = 任意来源，默认 `*`）。
生产建议配置为官网域名，例如：

```bash
PUBLIC_COOPERATION_ALLOWED_ORIGINS=https://www.example.com,https://example.com
```

预检 `OPTIONS` 返回 `204`；不在白名单的 Origin 预检返回 `403 ORIGIN_NOT_ALLOWED`。

## 2. 请求字段

| 字段 | 类型 | 必填 | 长度上限（Unicode 码点） | 说明 |
| --- | --- | --- | --- | --- |
| `name` | string | 是 | 100 | 姓名 |
| `email` | string | 是 | 254 | 邮箱；服务端转小写存储 |
| `company` | string | 否 | 200 | 公司 / 机构 |
| `contact` | string | 否 | 300 | 网站、微信或 LinkedIn 等自由联系方式 |
| `industry` | string | 否 | 100 | 行业选择 |
| `region` | string | 否 | 100 | 覆盖区域 |
| `message` | string | 否 | 500 | 合作意向（允许多行） |

未列出的字段会被忽略。`name` 与 `email` 缺失或为空返回 `400`。

### 示例

```ts
await fetch('https://<gain-saas 域名>/api/public/cooperation-intents', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: '张三',
    email: 'zhang@example.com',
    company: '上海某某贸易有限公司',
    contact: 'https://example.com 或微信 zhang-san',
    industry: '工业制造',
    region: '欧洲',
    message: '我们在德国有渠道，希望代理贵司产品。',
  }),
});
```

```bash
curl -X POST http://100.68.31.20:4020/api/public/cooperation-intents \
  -H 'Content-Type: application/json' \
  -d '{"name":"张三","email":"zhang@example.com","message":"希望合作"}'
```

## 3. 成功响应

`201 Created`

```json
{
  "data": {
    "ok": true,
    "reference": "0f0a1e3c-6c2c-4a51-9d1c-3f0f0d6a2b11",
    "receivedAt": "2026-11-17T07:30:00.000Z"
  }
}
```

`reference` 是这条意向的编号，可在与运营沟通时引用；响应**不回显**用户输入。

## 4. 失败响应

所有错误都是统一结构：

```json
{ "error": { "code": "RATE_LIMITED", "message": "尝试过多，请稍后再试" } }
```

| HTTP | `error.code` | 触发条件 | 前端处理建议 |
| --- | --- | --- | --- |
| `400` | `INVALID_CONTENT` | 字段为空、超长、含 HTML/脚本/危险协议 | 在对应字段提示（`error.details[].field`） |
| `400` | `VALIDATION_FAILED` | 请求体不是 JSON 对象 | 修请求体 |
| `403` | `ORIGIN_NOT_ALLOWED` | 预检来源不在白名单 | 检查部署来源配置 |
| `413` | `PAYLOAD_TOO_LARGE` | 请求体超过 16 KB | 截断输入 |
| `429` | `RATE_LIMITED` | 触发限流 | 提示稍后重试；响应带 `Retry-After`（秒） |
| `5xx` | `INTERNAL` | 服务端异常 | 通用失败提示，可重试 |

## 5. 限流规则

按客户端 IP 与邮箱分别计数（持久化在数据库，重启不丢、多实例共享），键为 HMAC-SHA256 摘要，
**不存明文 IP 或邮箱**：

| 维度 | 限制 |
| --- | --- |
| 同一 IP | 10 分钟内 5 次 |
| 同一 IP | 24 小时内 30 次 |
| 同一邮箱 | 24 小时内 3 次 |

- 计数在解析/校验**之前**执行：畸形或恶意请求同样消耗配额；
- 成功与失败都计数（本端点不做「成功后清零」）；
- 命中后返回 `429 RATE_LIMITED`，`Retry-After: 600`。

## 6. XSS 校验（服务端强制执行）

提交内容在写库前统一清洗，任一字段不通过则整条请求 `400 INVALID_CONTENT`，**不会落库**：

1. Unicode NFKC 归一化；去掉零宽字符与除 `\n`/`\t` 外的控制字符；
2. 单行字段把换行/制表折叠为空格并 `trim`；`message` 保留换行；
3. 拒绝以下载荷：
   - HTML 标签（`<script>`、`<img>`、`<svg>`、闭合标签等任何 `<tag` / `</tag` 形态）；
   - `javascript:`、`vbscript:`、`data:text/html`、`data:image/svg` 协议；
   - 事件处理器（`onerror=`、`onload=` 等 `on<xxx>=`）；
   - CSS `expression(`；
   - HTML 实体编码形式的尖括号/引号（`&lt;`、`&gt;`、`&#60;`、`&#x3c;` 等）；
4. 邮箱额外校验格式（`local@domain.tld`）并转小写。

普通文本中的裸 `<`（如「营收 < 500 万」）允许；只有构成标签/协议的形态才会被拒绝。
运营台展示同样是 Vue 文本插值（自动转义），存储层不保留 HTML。

## 7. 运营侧接口（登录后）

仅供运营台使用，需运营域会话（`OpsGuard`）：

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /api/ops/cooperation-intents?status=NEW&limit=50&offset=0` | 列表；返回 `intents`、`total`、`counts`（NEW/CONTACTED/CLOSED） |
| `PATCH /api/ops/cooperation-intents/:id` | body `{ "status": "CONTACTED", "note": "已电话联系" }`；`status` 变更会记录处理人与时间，备注同样做 XSS 清洗 |

运营台页面：`/ops` → 左侧「合作意向」。
