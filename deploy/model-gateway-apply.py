#!/usr/bin/env python3
"""model-gateway-apply —— 把引擎模型调用从 new-api 切到 gain-saas 内嵌模型网关。

  model-gateway-apply.py [--apply] [--rollback]
      默认 dry-run：只打印将改的键与网关连通性，不写文件、不重启容器。
      --apply    备份 backend-runtime.env → 写 MODEL_GATEWAY_* → 重建 api/worker → 等 readiness。
      --rollback 用最近一次归档还原 backend-runtime.env 并重建 api/worker。

必须 root：要写 /global/backend/.secrets/backend-runtime.env 并调用 docker。
不是 platform-worker：站点构建使用 new-api settled 结算协议,不在此网关范围内。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

SECRETS = Path("/global/backend/.secrets")
MAIN_ENV = SECRETS / "backend-runtime.env"
SAAS_ENV = Path("/global/gain-saas/.env")
ARCHIVE_ROOT = Path("/global/_archive")
RUNTIME_SH = Path("/global/local-config/global/runtime.sh")
GATEWAY_URL = "http://127.0.0.1:4020/v1"
READY_URL = "http://127.0.0.1:3000/api/v1/health/ready"
MODELS_URL = f"{GATEWAY_URL}/models"


def die(message: str) -> None:
    print(f"model-gateway: {message}", file=sys.stderr)
    sys.exit(2)


def parse_env(path: Path) -> list[tuple[str, str | None]]:
    entries: list[tuple[str, str | None]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or "=" not in raw:
            entries.append((raw, None))
            continue
        key, value = raw.split("=", 1)
        entries.append((key.strip(), value))
    return entries


def env_values(path: Path) -> dict[str, str]:
    return {key: value for key, value in parse_env(path) if value is not None}


def set_env_value(entries: list[tuple[str, str | None]], key: str, value: str) -> None:
    for index, (existing, current) in enumerate(entries):
        if current is not None and existing == key:
            entries[index] = (key, value)
            return
    entries.append((key, value))


def render(entries: list[tuple[str, str | None]]) -> str:
    return "\n".join(key if value is None else f"{key}={value}" for key, value in entries) + "\n"


def write_atomic(target: Path, text: str) -> None:
    stat = target.stat()
    tmp = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.st_mode & 0o777)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(tmp, stat.st_uid, stat.st_gid)
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive_dir() -> Path:
    day = datetime.now().strftime("%Y%m%d")
    candidate = ARCHIVE_ROOT / f"model-gateway-gain-saas-xin-{day}"
    if (candidate / "before").exists():
        candidate = ARCHIVE_ROOT / f"model-gateway-gain-saas-xin-{day}-{datetime.now().strftime('%H%M%S')}"
    return candidate


def archive_before() -> Path:
    target = archive_dir() / "before"
    target.mkdir(parents=True, exist_ok=False)
    os.chmod(target.parent, 0o700)
    os.chmod(target, 0o700)
    copy = target / MAIN_ENV.name
    shutil.copy2(MAIN_ENV, copy)
    os.chmod(copy, 0o600)
    (target / "SHA256SUMS").write_text(f"{sha256(copy)}  {MAIN_ENV.name}\n", encoding="utf-8")
    subprocess.run(["chown", "-R", "xin:xin", str(target.parent)], check=False)
    return target.parent


def check_gateway_prerequisites() -> str:
    values = env_values(SAAS_ENV)
    key = values.get("MODEL_GATEWAY_API_KEY", "")
    if len(key) < 16:
        die("gain-saas/.env 缺少 MODEL_GATEWAY_API_KEY;先生成并重启 gain-saas web")
    try:
        current = env_values(MAIN_ENV)
    except PermissionError:
        current = {}
    if current.get("MODEL_GATEWAY_URL") == GATEWAY_URL and current.get("MODEL_GATEWAY_KEY") == key:
        print("引擎 env 已指向 gain-saas 模型网关。")
    request = urllib.request.Request(MODELS_URL, headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = json.loads(response.read().decode("utf-8"))
        models = [item.get("id") for item in body.get("data", [])]
        print(f"网关可达:{MODELS_URL} HTTP 200,已配置模型别名 {models or '(空)'}")
        if not models:
            print("  警告:还没有任何模型路由;引擎调用会走默认路由,若也未配置则 404。")
    except Exception as exc:  # noqa: BLE001
        die(f"gain-saas 模型网关不可达({exc});先确认 4020 在跑且 Key 一致")

    # 客户 worker 启动时硬性检查 new-api settlement readback;gain-saas 必须提供兼容代理,
    # 否则 worker 会永久停在 STARTING(即使获客模型调用本身正常)。
    settlement_origin = values.get("MODEL_GATEWAY_SETTLEMENT_ORIGIN", "")
    settlement_key = values.get("MODEL_GATEWAY_SETTLEMENT_API_KEY", "")
    if not settlement_origin or not settlement_key:
        die("gain-saas/.env 缺少 MODEL_GATEWAY_SETTLEMENT_ORIGIN / _API_KEY;"
            "客户 worker 需要它代理站点构建的 new-api 读回,否则会停在 STARTING。见 deploy/model-gateway.md §3.3")
    capability_url = "http://127.0.0.1:4020/api/settlement-readback/v1/capability"
    try:
        with urllib.request.urlopen(capability_url, timeout=5) as response:
            status = response.status
            capability = json.loads(response.read().decode("utf-8"))
            contract = response.headers.get("x-new-api-settlement-contract")
        if status != 200 or capability.get("status") != "ready" or contract != "new-api-settlement-readback/v1":
            die(f"settlement readback 兼容代理未就绪(HTTP {status});先修好再切换,否则 worker 不会 READY")
        print("settlement readback 兼容代理:ready")
    except Exception as exc:  # noqa: BLE001
        die(f"settlement readback 兼容代理不可达({exc});先确认 gain-saas 已重启且 /api/settlement-readback 已注册")
    return key


def plan() -> tuple[list[tuple[str, str | None]], str, str]:
    key = check_gateway_prerequisites()
    try:
        entries = parse_env(MAIN_ENV)
        current = env_values(MAIN_ENV)
    except PermissionError:
        print(f"无法读取 {MAIN_ENV}(需要 root);以下只显示目标值。")
        entries = []
        current = {}
    desired = {
        "MODEL_GATEWAY_URL": GATEWAY_URL,
        "MODEL_GATEWAY_KEY": key,
        "MODEL_GATEWAY_STREAM_CHAT_COMPLETIONS": "false",
    }
    print(f"\n== {MAIN_ENV} ==")
    for name, value in desired.items():
        old = current.get(name)
        shown = "<set>" if name.endswith("KEY") else value
        if old != value:
            print(f"  ~ {name}: {'<set>' if old and name.endswith('KEY') else old} → {shown}")
            set_env_value(entries, name, value)
        else:
            print(f"  = {name} 已是目标值")
    return entries, key, current.get("MODEL_GATEWAY_KEY", "")


def restart_backend() -> None:
    env = dict(os.environ)
    env.update({
        "DOCKER_CONTEXT": "default",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "safe.directory",
        "GIT_CONFIG_VALUE_0": "*",
    })
    command = [str(RUNTIME_SH), "up", "-d", "--no-deps", "--force-recreate", "api", "worker"]
    print("\n$ " + " ".join(command))
    subprocess.run(command, check=True, env=env)


def wait_ready(timeout: int = 240) -> None:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(READY_URL, timeout=5) as response:
                last = json.loads(response.read().decode("utf-8"))
            if last.get("status") == "ready":
                print("引擎 readiness:ready")
                return
        except Exception as exc:  # noqa: BLE001
            last = {"error": str(exc)}
        time.sleep(5)
    die(f"{timeout}s 内引擎没有 ready:{json.dumps(last, ensure_ascii=False)[:400]}")


def apply() -> None:
    if os.geteuid() != 0:
        die("--apply 需要 root(写 backend/.secrets 并重建容器)")
    entries, _key, _old = plan()
    before = archive_before()
    print(f"\n已归档: {before}")
    text = render(entries)
    write_atomic(MAIN_ENV, text)
    print(f"已写入 {MAIN_ENV}(sha256={sha256(MAIN_ENV)[:16]}…)")
    restart_backend()
    wait_ready()
    print("\n完成:引擎 api/worker 已指向 gain-saas /v1;platform-worker 未动(new-api settled 协议不在本网关范围)。")
    print("new-api 容器未停止;确认新网关稳定后可另行停用。")


def rollback() -> None:
    if os.geteuid() != 0:
        die("--rollback 需要 root")
    candidates = sorted(ARCHIVE_ROOT.glob("model-gateway-gain-saas-xin-*/before"), reverse=True)
    if not candidates:
        die("没有可用的 model-gateway 归档")
    snapshot = candidates[0] / MAIN_ENV.name
    if not snapshot.exists():
        die(f"归档缺少 {snapshot}")
    shutil.copy2(snapshot, MAIN_ENV)
    print(f"已还原 {MAIN_ENV} ← {snapshot}")
    restart_backend()
    wait_ready()
    print("回退完成:api/worker 已恢复归档中的 env。")


def main() -> None:
    parser = argparse.ArgumentParser(description="把引擎模型调用切到 gain-saas 内嵌模型网关")
    parser.add_argument("--apply", action="store_true", help="写 env 并重建 api/worker")
    parser.add_argument("--rollback", action="store_true", help="还原最近一次备份并重建 api/worker")
    args = parser.parse_args()
    if args.apply and args.rollback:
        die("--apply 与 --rollback 只能二选一")
    if args.rollback:
        rollback()
        return
    if args.apply:
        apply()
        return
    plan()
    print("\n(dry-run)未写文件、未重启。加 --apply 执行。")


if __name__ == "__main__":
    main()
