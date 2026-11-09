# 注册即建档：理解预览与反向填充 onboarding

> 文档 ID：`PLAN-ONBOARDING-UNDERSTANDING-PREVIEW-20261110`
> 生命周期：`APPROVED`（产品负责人 2026-11-10 批准四阶段路线；第 1 步实施中）
> 最后核验：2026-11-10

## 1. 目标与非目标

**目标（第 1 步，1–2 周）**：把 onboarding 从「让客户手填六项事实」反转为「先给官网 → 系统给出理解预览 → 客户勾选确认完成建档」。行业从自由文本改为受控词表（ISIC Rev.4 / NACE 方向），商务邮箱做域名一致性提示（不阻断）。

**非目标（留给第 2–4 步）**：无官网的注册库建档（GLEIF / Companies House / INPI）、逐页理解进度与预计时间、公司档案 v2 的证据徽章与批量审批、卖方画像 → ICP 关键词自动建议。第 1 步只为它们留好数据与埋点。

## 2. 现状事实（2026-11-10 核验）

- 注册（用户 + 工作空间）在 onboarding 之前完成；onboarding 只是强制向导，提交 `POST /api/onboarding/company` → BFF 取 quote/Grant → 引擎 `POST /companies`（202 异步理解）→ 回写 `workspace.onboardingCompletedAt/onboardingCompanyId`。
- 引擎 `POST /companies` 支持仅 `website` 建档：创建 DRAFT + 写 outbox `CompanyProfileCreated`（v2）→ Temporal `understandingWorkflow` 抓官网子页、抽 claims/offerings、回填 industry/summary，完成置 REVIEW。理解任务、抓取工具、预算 operation `POST /companies` 均已存在。
- 行业：`extractAndPersistProfile` 只回填自由文本；受控词表在 `canonical_taxonomy`（kind=industry，ISIC 15 个制造相关节点，带 NACE/NAICS 对照与中英德标签），确定性归一靠 `term_alias`。
- 无官网时建档不触发理解也不消费 Grant（D17）。
- 无理解进度表：只有 `status`（DRAFT/ENRICHING/REVIEW/ACTIVE）与失败标签 `understandingLastError`（`stage:code`）；已抓页可从 `knowledge_source` 计数。

## 3. 第 1 步设计

### 3.1 用户流程（两屏 + 一个进度态）

1. **官网优先屏**：企业名称（注册名预填）+ 官网 URL + 商务邮箱（可选，域名与官网不一致或公共邮箱域名时给非阻断提示）。主按钮「开始理解」；次链接「没有官网，手动填写」（进入今天的手填流程，行业同样用受控下拉）。
2. **理解进度态**：进入即展示「正在阅读官网…」与已分析页数（轮询预览端点，4s）；失败时用人话说明阶段原因，给「重试」「手动填写」两个出口。
3. **预览确认屏**：三组候选，默认勾选，客户可取消/改选——
   - 行业：受控下拉（默认选中系统建议的 ISIC 节点；无建议时要求选择或允许「暂不确定」= 不填）；
   - 产品：官网抽取的 offerings（带来源页），可勾选 1–5 个，也可补自定义项；
   - 目标市场：从 claims/summary 里确定性识别出的国家（带原文证据），可增删（ISO 3166-1 alpha-2 多选）。
   主按钮「完成建档」→ `POST /api/onboarding/company` 提交勾选结果。

### 3.2 架构决策

- **不新增 AI Task / 工具 / 预算 purpose**。预览复用一次真正的 `POST /companies`（官网建档 + 既有 understanding 任务与抓取工具），预览端点只读已落库的理解结果；完成路径只写卖家事实，零模型调用。因此不触 `scripts/execution-authority-policy.*`、`builtin-tools.ts`、quote envelope。
- **草稿公司即档案**（注册即建档）：点「开始理解」时创建 DRAFT 并把 id 记到 `workspace.onboardingCompanyId`（不改 completedAt）。客户确认后把事实写回同一档案，不重复理解、不产生废弃副本。放弃的用户留下的 DRAFT 可被现有 DELETE 清理（后续可加定时清理，不属本步）。
- **行业建议在读取时归一**：预览端点把 `profile.industry`（自由文本）先按 `term_alias` 精确匹配、再做别名子串匹配到 `canonical_taxonomy` 节点；匹配不到就只展示原文并让客户从受控词表选择。受控选择以 `industryCode` 持久化（新增可空列），`industry` 继续存标签文本供下游 NACE 映射与旧界面使用。
- **市场建议只给证据**：扫描 claims 陈述/摘要中的国家名（中英德别名），命中才建议并附原句；不按「总部国家 + 邻国」编造候选。
- **理解未完成不写事实**：完成端点只接受 DRAFT（无官网/失败后手填）或 REVIEW（预览就绪）；ENRICHING 与「DRAFT + 官网 + 无失败标记」（已排队/刚接受重试）都返回 409，避免 `extract_profile` 稍后覆盖客户选择。引擎接受重试时立即清空失败标记，预览从 failed 变为 queued，重复点击命中「已排队」守卫。

### 3.3 接口契约

引擎（`/global/backend`，新 PR）：

- `GET /api/v1/companies/:companyId/understanding-preview`（acquisition:read）
  - `state`: `not_started | queued | running | ready | failed`；`failure: {stage, code}`；`pagesAnalyzed`（按 URI 去重、只算当前官网同站）；`industry.options[]`（受控词表：code/labelEn/labels/parentCode/nace）、`industry.suggested`（code/label/raw/matched）；`products[]`（name/sourceUrl/evidence，只收当前官网同站）；`markets[]`（code/name/labelEn/labels/evidence；国家名只认词边界，罗马尼亚不会顺带命中阿曼/尼日尔/马里）。
- `POST /api/v1/companies/:companyId/onboarding-facts`（acquisition:write，无 Grant）
  - body `{name?, industry?, industryCode?, targetMarkets?, products?, businessEmail?}`；DRAFT/REVIEW 可写；校验 industryCode 存在；产品 upsert 为 Offering（source=onboarding，名称不在列表中的 onboarding 来源行删除）；同事务补注册引导 Claim 草稿（复用 `synthesizeProfileClaimDrafts`）。返回 CompanyDto。
- `CreateCompanyDto` 增加可选 `industryCode`（无官网手填路径直接落库）。
- Prisma：`company_profile.industry_code TEXT NULL` 迁移。

SaaS（本仓）：

- BFF `POST /api/onboarding/preview`：body `{website?, name?, businessEmail?}`。有 `onboardingCompanyId` 时复用：状态 ready 直接返回；失败且官网未变则 quote→Grant→retry 理解；官网变了先 PATCH 再 retry；无档案则 quote→Grant→`POST /companies`（仅 website/name）并记录 id。审计 `onboarding.preview_started`。
- BFF `GET /api/onboarding/preview`：无档案返回 `not_started` + 行业词表（词表随预览响应下发，不单开 taxonomy 端点）；档案被删则清 id 后同上。
- BFF `POST /api/onboarding/company`（改造）：有草稿档案 → 引擎 `onboarding-facts`；无 → 旧建档案路径（手填无官网）。成功标记完成；审计 `onboarding.complete` 携带预览 vs 选择的差异（行业/产品/市场接受情况、pagesAnalyzed、理解状态）。
- Web：重写 `views/onboarding/index.vue` 为上述两屏 + 进度态；行业改下拉；邮箱域名提示；文案中英同步；e2e mock 增加 preview 路由并改造主链路用例。

### 3.4 指标（先埋点、离线计算，不造数）

| 指标 | 口径 | 来源 |
| --- | --- | --- |
| 注册完成率 | 有 `onboardingCompletedAt` 的工作空间 / 注册工作空间 | SaaS `workspace` |
| 理解成功率 | `onboarding.preview_started` 后档案最终 REVIEW/ACTIVE 的比例 | SaaS 审计 × 引擎 company status（按 companyId 关联） |
| 平均覆盖页数 | 完成时审计里的 `pagesAnalyzed` | SaaS 审计 |
| 建议修正率 | 行业/产品/市场：选择与建议不一致的项 / 建议项 | `onboarding.complete` 审计 detail |
| 首个有效 ICP 时长 | 工作空间创建 → 第一条 ACTIVE ICP | 引擎 `icp_definition` × SaaS `workspace` |

报告随第 1 步 PR 给出查询 SQL 与当时真实数据量；本地库无客户数据时如实写「样本不足」，不填演示数。已落地：`docs/evidence/onboarding-understanding-preview-20261110/README.md`。

## 4. 第 2–4 步路线（交付形式：PR 列表 + 本文档更新）

- **第 2 步（2–4 周）：无官网路径**。公司名 + 国家 → GLEIF/Companies House/INPI（均已 ENABLED）查询 → 候选档案 → 客户确认；理解进度可视化补逐页状态（需在 understanding activities 落 run 事件投影，单独设计）与预计时间。
- **第 3 步（4–8 周）：公司档案 v2**。证据徽章（T1 注册 / T2 展会新闻 / T3 官网，含抓取时间，Evidence 已有 sourceUrl/fetchedAt）、跨源佐证、批量审批；客户修正触发重理解并打标回流金标。
- **第 4 步（持续）：卖方画像 → ICP 关键词建议**。以 `industryCode` + offerings + targetMarkets 生成获客画像与排除项，作为 ICP 草稿给客户审批。

每步的验收指标在第 1 步埋点基础上增加：第 2 步「无官网建档成功率、注册库命中率」；第 3 步「证据覆盖率、批量审批耗时、修正回流条数」；第 4 步「ICP 建议采纳率、首个有效 ICP 时长」。

### 4.1 交付拆分（每项一个 worktree + 一个 PR，后端与 SaaS 分开）

| 阶段 | 仓 | PR 内容 | 验收 |
| --- | --- | --- | --- |
| 2a | backend | 注册库候选查询：公司名 + 国家 → GLEIF / Companies House / INPI（均已 ENABLED）候选（带注册号、地址、状态、来源），只读、无模型调用 | 候选命中率；端点单测；registry 单测；OpenAPI/治理门 |
| 2b | backend | 理解进度投影：understanding run 的逐页抓取/失败事件落库（新表或 run stats JSON），预览端点补 `pages[]` 与 ETA 建议 | 事件与 Temporal 历史一致；失败页可解释；迁移与 RLS 基线 |
| 2c | SaaS | 无官网分支：公司名 + 国家 → 候选选择 → 预填档案 → 完成建档；进度页展示逐页状态与预计时间 | e2e 主链路（mock）+ 真引擎冒烟；无官网建档成功率埋点 |
| 3a | backend | 证据徽章读模型：T1 注册 / T2 展会新闻 / T3 官网，含抓取时间与跨源佐证（Evidence 已有 sourceUrl/fetchedAt，补 provider 分类与聚合端点）；「触发信号」块直接消费 signal-ingest 的 `GET /api/v1/companies/{id}/signals`（sourceUrl/title/excerpt/providerKey/observedAt），端点未合时 feature-detect 空数组 | 证据覆盖率；跨源冲突不静默覆盖；单测 |
| 3b | SaaS | 公司档案 v2：证据徽章、跨源佐证、批量审批、触发信号展示位；修正触发重理解并打标回流 | 批量审批耗时；修正回流条数；e2e |
| 4a | backend | 卖方画像 → ICP 草稿建议（industryCode + offerings + targetMarkets → 画像/排除项），人工审批后激活；画像与证据结构直接消费 evidence-graph 的 `evidenceBundle`，不自造第二套结构 | 建议采纳率；无审批不激活；预算与审计 |
| 4b | SaaS | ICP 建议卡与采纳/修改交互；首个有效 ICP 时长看板 | 采纳率与时长；e2e |

发布顺序：每阶段后端先升级，SaaS 后上线；新增端点一律先补 operation-descriptions/OpenAPI 与治理门。

## 5. 风险与待决

- **草稿清理**：放弃的 DRAFT 会留在引擎；现有 DELETE 可清，定时清理另立卡。
- **受控词表覆盖窄**（15 个制造节点）：先满足出海制造场景；扩词表走 seed-taxonomy + 迁移，不改本步接口。
- **市场建议召回低**：只认官网明确提到的国家；召回低是诚实的结果，第 3 步用注册库/展会数据补。
- **旧引擎镜像兼容**：BFF 调新端点前不探测版本；发布顺序必须是引擎先升级、SaaS 后上线（与既有 scope 上线顺序同向）。本地 mock 与 e2e 用假 BFF 覆盖。
- **跨会话边界（2026-11-10 晚）**：档案 v2 的「触发信号」消费 signal-ingest 的 `GET /companies/{id}/signals`（字段 sourceUrl/title/excerpt/providerKey/observedAt，未合时 feature-detect 空数组）；第 3/4 步的证据与画像数据直接消费 evidence-graph 的 `evidenceBundle`/画像建议，不另造结构。
