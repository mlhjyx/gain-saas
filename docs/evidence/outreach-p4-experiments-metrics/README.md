# P4 第四波：实验（holdout）与成本报表（P4-09，2026-11-10）

分支：`claude/p4-09`。发送总开关默认关、影子默认开、周快照 worker 默认关；不部署、不发真实邮件。

> **本波为何是 P4-09 而非 P4-05**：P4-05（序列引擎）的每一步都需要「已批准的分步内容」——
> 即 `outreach_template_version` + `legal_review` 版本化与律师书面意见（ch05 D5-11 发布门）。
> 该内容/法务素材当前不可得，先做无外部依赖的 P4-09；P4-05 等模板版本化素材就绪后开工。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 实验与确定性分配 | `outreach_experiment`（创建时冻结 64 位分配盐/口径/策略）+ `outreach_experiment_assignment`；`bucket = first8bits(sha256(salt\|experimentId\|subjectRef))`，`bucket < floor(ratio×256)` 判 holdout，任何人可复算 | `outreach-experiments.service.spec.ts` 6 例（bucket 稳定/边界、创建校验、状态机、分配幂等、holdout 查询） |
| Holdout 发送排除 | 发送路径对「campaign 下 RUNNING 实验的 contact 级 holdout」逐封 `OUTREACH_HOLDOUT` 跳过（含手工发送端点；无 campaign 的批次不排除） | `outreach-send.service.spec.ts` +2 例 |
| 成本报表 | `GET /api/outreach/cost-report?windowDays=`：退信率（硬拒+DSN）/投诉率/回复率/退订率（均带 Wilson 95% 区间）、成本=SENT×单价、每会议成本=成本/MEETING_BOOKED（无会议为 null），附口径限制说明 | `outreach-metrics.service.spec.ts`（Wilson 数学 + 窗口口径 + 报表） |
| 指标快照 | `outreach_metric_snapshot`（渠道×指标×窗口，定义版本 `outreach-metrics/v1`）+ 手动快照端点 + 周快照 worker（`OUTREACH_METRICS_SNAPSHOT_ENABLED` 默认 false） | 同上（7 行快照与重复写入） |
| 错误文案 | `OUTREACH_HOLDOUT`、`OUTREACH_EXPERIMENT_NOT_FOUND/_NOT_DRAFT/_NOT_RUNNING/_ARCHIVED` 登记中英三层 | `errors.test.ts` |

## 本机验证

```
apps/server outreach：22 files / 194 tests 绿；tsc --noEmit 绿
packages/shared：39 tests 绿
迁移：一次性库 prisma migrate deploy 全链通过（20261110150000_outreach_experiments_metrics，additive）
```

## 口径与限制（写死，防止「各说各话」）

- 回复率 = 原始 REPLY / SENT（分类前的保守口径）；opt-out 率 = UNSUBSCRIBE / SENT；两者都附 Wilson 95%。
- 会议数 = 窗口内 `MEETING_BOOKED` outcome（工作空间级）；campaign/账户级归因需要 QGO.campaignId 链 + 触点时间窗，
  属后续卡片；报表在 `limitations` 中显式列出。
- holdout 的统计口径：v1 按 **contact 级** 排除（草稿尚无账户引用）；ch05 要求账户级随机化以避免同公司串扰，
  `subjectType=account` 的分配已支持存储与复算，待草稿携带账户引用后切到账户级排除（evidence 与 PR 均标注）。
- 成本为发送全载摊销（`OUTREACH_COST_PER_EMAIL_MICROS`），labor 工时未计（laborHours=null）。

## 不能证明什么

- 无真实实验数据：bucket 分布与 ratio 边界的正确性由确定性函数单测证明；真实 lift 需要生产样本（≥500/arm 才能谈显著性）。
- 每会议成本的会议室归因未做 campaign 级拆分；当前数字用于渠道复盘，不用于单 campaign 结算。
