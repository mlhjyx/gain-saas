# 预付积分钱包

> 文档 ID：`DOC-TECH-CREDITS-WALLET-001`
> 生命周期：`CURRENT`
> 最后核验：2026-11-27（源码、迁移与主要接线）
> 实际采用与验收见[当前状态](../status/current.md)。

## 账本与可见范围

SaaS 持有账户、积分批次、预占、流水和价目表。迁移使用整数积分，租户持有的数据按工作空间隔离；流水保留追加式记录。租户可查余额、积分批次、预占和流水，运营台处理充值、赠点、冻结、价格和对账。接口分别见 [钱包控制器](../../apps/server/src/wallet/wallet.controller.ts) 与 [运营钱包控制器](../../apps/server/src/wallet/ops-wallet.controller.ts)。

## 执行与结算

- [配置](../../apps/server/src/config/configuration.ts)中 `WALLET_BILLING_ENABLED` 默认关闭。开启时仅 [已登记 BFF 路径](../../apps/server/src/wallet/bff-wallet-billing.ts) 使用预占。建档和画像属于免费路径；寻源及指定联系人操作适用各自计量。
- [BFF](../../apps/server/src/bff/bff.module.ts)在派发前按幂等键预占。派发失败释放本次持有的预占。同步操作按有效产出结算。
- 寻源通过 [事件消费器](../../apps/server/src/service/event-consumer.service.ts) 等待 `DiscoveryRunCompleted`，按状态和有效线索数结算。失败、取消或零合格产出释放积分；剩余积分与流水由[钱包服务](../../apps/server/src/wallet/wallet.service.ts)维护。
- [旧执行预算](workspace-budget-quota.md)控制适用的 quote 与 Grant，后端用量账本记录实际供应商成本。积分扣减依钱包启用、动作和产出，运营对账关联两侧记录。

## 验证

配置、Schema、接线与测试可证明源码行为。运行验收需要核对部署版本、扣点开关、测试租户的合法预占、回退或释放、用户可见余额及历史流水。自助收款、订阅或支付成交各需上线与验收证据，本次没有验证。
