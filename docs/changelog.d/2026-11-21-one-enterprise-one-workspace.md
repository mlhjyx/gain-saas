---
date: 2026-11-21
title: One-enterprise-one-workspace tenant model
---

- 决策:产品拍板「单位是企业,一企一空间」——工作空间=企业组织(与引擎 workspace 语义对齐),同事经邀请链接加入,不再允许重复开通。
- 注册:新增企业查重硬拦截——名称 NFKC 归一化(去空白/小写)后精确相等或包含关系(较短方≥6字,拦"公司名1"式后缀重复;不同城市前缀互不包含不误伤)命中 ACTIVE 工作空间即 409 COMPANY_WORKSPACE_EXISTS,错误体带既有企业名/开通日期,任何写入前 fail-fast。
- web:注册页对 409 渲染专属加入引导面板(企业名+日期+「联系管理员取邀请链接」+去登录),登录页链接文案改「开通企业工作空间」;删除零调用的 createWorkspace API。
- 服务端:POST /workspaces 自助创建退役为 410(空间只在注册新企业时创建);GET/改名/退出保留,switch-workspace 服务端能力保留(membership 驱动,无 UI)。
- 清理:新增 scripts/consolidate-workspaces.ts(dry-run 默认,--apply 写库)——重复组按业务数据量选保留侧,空侧成员先补保留侧 admin 再归档空侧;测试/验收空间与 0 成员回填孤儿归档停轮询;双侧都有数据的组只标 NEEDS_MANUAL(引擎侧 lead/run 以 workspace UUID 为 RLS 锚点,搬移留引擎专项);全程不物理删行。
- PRD:§4 A1/A3 按一企一空间改写,§5.3 多档案注明与一企一空间的关系(集团多品牌=一空间多档案)。
