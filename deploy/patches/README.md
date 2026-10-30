# 引擎补丁:理解 persistOfferings 重复确认 crawl 回执

## 现象

公司理解模型抽取全部成功,`persistClaims` 已落库,但工作流在 `persistOfferings` 失败,公司状态回到 DRAFT:

```text
understanding_last_error = persistOfferings:ExecutionControlError
```

## 根因

`persistClaims` 已用 `crawl4ai.fetch` + domainAckKey `...:crawl` 确认每页爬取回执。`persistOfferings` 又用同一回执、同一 key 再确认一次,得到 `REPLAYED`;同批的 offering 抽取回执是 `APPLIED`,混合状态触发:

```text
DOMAIN_ACK_MIXED_REPLAY_STATE
```

## 补丁

`engine-understanding-offerings-ack.patch` 移除 `persistOfferings` 里的重复 crawl 回执确认。补丁已在引擎工作树提交到本地分支 `fix/understanding-offerings-crawl-ack`(`ed7bd93c`)。

## 构建/部署

脚本默认 dry-run;需要 root:

```bash
python3 /global/gain-saas/deploy/engine-understanding-fix-apply.py              # 预检
sudo python3 /global/gain-saas/deploy/engine-understanding-fix-apply.py --build-only
sudo python3 /global/gain-saas/deploy/engine-understanding-fix-apply.py --build-only # 只构建本地验证镜像(自动回退国内镜像)
# 网络恢复、可推送 GHCR 后:
sudo python3 /global/gain-saas/deploy/engine-understanding-fix-apply.py --apply
```

回退:

```bash
sudo python3 /global/gain-saas/deploy/engine-understanding-fix-apply.py --rollback
```

- `--local` 只让本次 `api/worker` 使用本地 tag `global-backend:understanding-ack-ed7bd93c`,不更新 `runtime.compose.env`;之后跑 `runtime.sh` 会回到原 digest。`--local` 直接使用临时 Dockerfile(清华 Debian 镜像 + 当前可用的 chromium)生成**仅用于本机验证**的镜像,不修改仓库 Dockerfile;正式发布请走 `--apply`/引擎 CI。
- `--apply` 构建并 push `ghcr.io/mlhjyx/global-backend:understanding-ack-ed7bd93c`,把返回的 digest 写入 `runtime.compose.env` 后重建 `api/worker`(不动 `platform-worker`)。
- 两种模式都等引擎 `/api/v1/health/ready` 变成 ready;之后用一条全新公司档案重跑理解。
