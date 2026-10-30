#!/usr/bin/env python3
"""engine-integration-apply —— 按 deploy/engine-integration.md 配置引擎侧对接。

  engine-integration-apply.py [--apply] [--rollback]
      默认 dry-run：只打印将改的键，不写文件、不重启容器。
      --apply    证书/TLS 端点 → 备份 → 改 env → 重建 api/worker/platform-worker → 等 readiness → R4 护栏。
      --rollback 用最近一次归档还原 env 并重建容器。

为什么必须 root：要写 /global/backend/.secrets/*.env、要 docker、要读 r4-pki 的 CA。

为什么不能用 http 回环捷径：
  - 引擎 admission 只接受「JWKS 与 issuer 同为 https」或「同为 http 且都是 loopback」；
  - platform-revocation-trust.runtime.ts 复用 AUTH_JWKS_URI,且要求它 https,否则撤销信任快照为
    null → /api/v1/platform-authority/fence-ack-jwks 503(R4 静默退化)。
  所以这里起一个 127.0.0.1:18446 的 TLS 端点(socat),证书由 r4-pki 的 gain-saas-jwks 叶子提供
  (growthos-server-ca 签发,引擎的 bootstrap-ca.pem 已信任),AUTH_JWKS_URI/issuer 都指向它。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

BACKEND = Path("/global/backend")
SECRETS = BACKEND / ".secrets"
MAIN_ENV = SECRETS / "backend-runtime.env"
PLATFORM_ENV = SECRETS / "backend-platform-worker-runtime.env"
SAAS_ENV = Path("/global/gain-saas/.env")
ARCHIVE_ROOT = Path("/global/_archive")
RUNTIME_SH = Path("/global/local-config/global/runtime.sh")
R4_PKI = Path("/global/local-config/bin/r4-pki")
PKI = Path("/global/local-config/pki")
TLS_DIR = Path("/global/gain-saas/deploy/tls")
TLS_UNIT_SRC = Path("/global/gain-saas/deploy/systemd/gain-saas-jwks-tls.service")
TLS_UNIT_DST = Path("/etc/systemd/system/gain-saas-jwks-tls.service")
TLS_PORT = 18446
AUTH_ORIGIN = f"https://127.0.0.1:{TLS_PORT}"
JWKS_URL = f"{AUTH_ORIGIN}/.well-known/jwks.json"
BUDGET_JWKS_URL = f"{AUTH_ORIGIN}/.well-known/execution-budget-jwks.json"
BUDGET_ISSUER = f"{AUTH_ORIGIN}/execution-budget"
READY_URL = "http://127.0.0.1:3000/api/v1/health/ready"
FENCE_ACK_URL = "http://127.0.0.1:3000/api/v1/platform-authority/fence-ack-jwks"
SAAS_READY_URL = "http://127.0.0.1:4020/health/ready"

AUTH_DESIRED = {
    "AUTH_JWKS_URI": JWKS_URL,
    "AUTH_ISSUER": AUTH_ORIGIN,
    "AUTH_AUDIENCE": "global-backend",
    "AUTH_WORKSPACE_CLAIM": "workspace",
    "AUTH_ROLES_CLAIM": "roles",
}

# 只写 backend-runtime.env(api + customer-worker)。platform-worker 的
# EXECUTION_BUDGET_GRANT_* 仍是 GrowthOS:R4 平台 Grant/撤销走那条信任根,schedules 仍 paused;
# gain-saas 的用户写路径不再经过 GrowthOS。
BUDGET_DESIRED = {
    "EXECUTION_BUDGET_GRANT_JWKS_URI": BUDGET_JWKS_URL,
    "EXECUTION_BUDGET_GRANT_ISSUER": BUDGET_ISSUER,
    "EXECUTION_BUDGET_GRANT_AUDIENCE": "global-backend:execution-budget",
    "EXECUTION_BUDGET_GRANT_ALGORITHMS": "RS256",
}


def desired_for(path: Path) -> dict[str, str]:
    return {**AUTH_DESIRED, **(BUDGET_DESIRED if path == MAIN_ENV else {})}

SAAS_ROLE_MAP = {
    "saas-admin": [
        "acquisition:read", "acquisition:write", "acquisition:review", "acquisition:event:ack",
        "acquisition:label:write", "acquisition:identity:review", "acquisition:export", "compliance:manage",
    ],
    "saas-member": [
        "acquisition:read", "acquisition:write", "acquisition:review", "acquisition:label:write",
    ],
    "saas-event-consumer": [
        "acquisition:read", "personal-data:read", "acquisition:event:ack",
    ],
}


def die(message: str) -> None:
    print(f"engine-integration: {message}", file=sys.stderr)
    sys.exit(2)


def parse_env(path: Path) -> list[tuple[str, str | None]]:
    """按行保留注释与空行；返回 (key, value) 或 (原行, None)。"""
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
    return {k: v for k, v in parse_env(path) if v is not None}


def set_env_value(entries: list[tuple[str, str | None]], key: str, value: str) -> None:
    for index, (existing, current) in enumerate(entries):
        if current is not None and existing == key:
            entries[index] = (key, value)
            return
    entries.append((key, value))


def merge_role_map(raw: str | None) -> tuple[dict[str, list[str]], bool]:
    base: dict[str, list[str]] = {}
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"现有 AUTH_ROLE_SCOPE_MAP_JSON 不是合法 JSON: {exc}")
        if not isinstance(parsed, dict):
            raise SystemExit("现有 AUTH_ROLE_SCOPE_MAP_JSON 不是 JSON 对象")
        base = {str(k): list(v) for k, v in parsed.items()}
    merged = dict(base)
    for role, scopes in SAAS_ROLE_MAP.items():
        merged[role] = list(scopes)
    return merged, base != merged


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def target_files() -> list[Path]:
    files = [MAIN_ENV]
    if PLATFORM_ENV.exists() and "AUTH_JWKS_URI" in env_values(PLATFORM_ENV):
        files.append(PLATFORM_ENV)
    return files


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


def archive_dir() -> Path:
    day = datetime.now().strftime("%Y%m%d")
    candidate = ARCHIVE_ROOT / f"engine-integration-gain-saas-xin-{day}"
    if (candidate / "before").exists():
        candidate = ARCHIVE_ROOT / f"engine-integration-gain-saas-xin-{day}-{datetime.now().strftime('%H%M%S')}"
    return candidate


def render(entries: list[tuple[str, str | None]]) -> str:
    lines = [key if value is None else f"{key}={value}" for key, value in entries]
    return "\n".join(lines) + "\n"


def plan_file(path: Path) -> tuple[list[tuple[str, str | None]], dict[str, str]]:
    desired = desired_for(path)
    entries = parse_env(path)
    current = env_values(path)
    for key, value in desired.items():
        set_env_value(entries, key, value)
    merged, changed_roles = merge_role_map(current.get("AUTH_ROLE_SCOPE_MAP_JSON"))
    if changed_roles:
        set_env_value(entries, "AUTH_ROLE_SCOPE_MAP_JSON",
                      json.dumps(merged, ensure_ascii=False, separators=(",", ":")))

    print(f"\n== {path} ==")
    any_change = False
    for key, value in desired.items():
        old = current.get(key)
        if old != value:
            print(f"  ~ {key}: {old} → {value}")
            any_change = True
    if changed_roles:
        print(f"  ~ AUTH_ROLE_SCOPE_MAP_JSON: 保留 {sorted(json.loads(current.get('AUTH_ROLE_SCOPE_MAP_JSON') or '{}'))},"
              f"追加/覆盖 {sorted(SAAS_ROLE_MAP)}")
        any_change = True
    if not any_change:
        print("  已是目标状态,无需改动。")
    return entries, current


def check_saas_env() -> str:
    values = env_values(SAAS_ENV)
    issuer = values.get("ENGINE_JWT_ISSUER", "")
    if issuer != AUTH_ORIGIN:
        die(
            f"gain-saas/.env 的 ENGINE_JWT_ISSUER={issuer!r} 与引擎 AUTH_ISSUER={AUTH_ORIGIN!r} 不一致;"
            f"先把 .env 改成 {AUTH_ORIGIN} 并重启 gain-saas web,否则所有 token 都会 401。"
        )
    budget_issuer = values.get("ENGINE_BUDGET_GRANT_ISSUER", "")
    if budget_issuer != BUDGET_ISSUER:
        die(
            f"gain-saas/.env 的 ENGINE_BUDGET_GRANT_ISSUER={budget_issuer!r} 与引擎 "
            f"EXECUTION_BUDGET_GRANT_ISSUER={BUDGET_ISSUER!r} 不一致;先改 .env 并重启 gain-saas web。"
        )
    if not values.get("ENGINE_BUDGET_GRANT_PRIVATE_KEY") or not values.get("ENGINE_BUDGET_GRANT_KEY_ID"):
        die("gain-saas/.env 缺少 ENGINE_BUDGET_GRANT_PRIVATE_KEY / ENGINE_BUDGET_GRANT_KEY_ID")
    return issuer


def http_json(url: str, ca_path: Path | None = None, timeout: int = 10) -> tuple[int, dict]:
    context = None
    if url.startswith("https:") and ca_path:
        context = ssl.create_default_context(cafile=str(ca_path))
    with urllib.request.urlopen(url, timeout=timeout, context=context) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def saas_jwks_ok(url: str = JWKS_URL, expected_kid: str | None = None) -> tuple[bool, str]:
    try:
        status, body = http_json(url, TLS_DIR / "ca.pem")
        keys = body.get("keys") or []
        if status != 200 or not keys:
            return False, f"HTTP {status} keys={len(keys)}"
        leaked = [m for m in ("d", "p", "q", "dp", "dq", "qi", "k") if m in keys[0]]
        if leaked:
            return False, f"JWKS 泄露私钥字段 {leaked}"
        kid = keys[0].get("kid")
        if expected_kid and kid != expected_kid:
            return False, f"kid={kid} 期望 {expected_kid}"
        return True, f"kid={kid}"
    except Exception as exc:  # noqa: BLE001 - 启动窗口内任何异常都代表端点未就绪
        return False, str(exc)


def provision_tls() -> None:
    print("\n== TLS 端点(引擎验签用) ==")
    ca_cert = PKI / "growthos-server-ca.pem"
    ca_key = PKI / "growthos-server-ca.key"
    leaf_cert = PKI / "gain-saas-jwks.pem"
    leaf_key = PKI / "gain-saas-jwks.key"
    if not leaf_cert.exists() or not leaf_key.exists():
        if not ca_cert.exists() or not ca_key.exists():
            die("growthos-server-ca 缺失。不要自动 init(会新建 CA 并让引擎信任失效);先恢复 R4 PKI。")
        print("  r4-pki 没有 gain-saas-jwks 叶子,运行 r4-pki init(幂等)")
        subprocess.run([str(R4_PKI), "init"], check=True)
    for path in (leaf_cert, leaf_key, ca_cert):
        if not path.exists():
            die(f"缺少 {path}")

    TLS_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(TLS_DIR, 0o700)
    subprocess.run(["chown", "xin:xin", str(TLS_DIR)], check=False)
    for source, name, mode in ((leaf_cert, "server.pem", 0o600),
                               (leaf_key, "server.key", 0o600),
                               (ca_cert, "ca.pem", 0o600)):
        dest = TLS_DIR / name
        shutil.copyfile(source, dest)
        os.chmod(dest, mode)
        subprocess.run(["chown", "xin:xin", str(dest)], check=False)
        print(f"  {name} ← {source}")

    shutil.copyfile(TLS_UNIT_SRC, TLS_UNIT_DST)
    os.chmod(TLS_UNIT_DST, 0o644)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "gain-saas-jwks-tls.service"], check=True)
    subprocess.run(["systemctl", "restart", "gain-saas-jwks-tls.service"], check=True)
    print("  systemd: gain-saas-jwks-tls.service 已启动")

    deadline = time.time() + 30
    detail = ""
    budget_kid = env_values(SAAS_ENV).get("ENGINE_BUDGET_GRANT_KEY_ID", "")
    while time.time() < deadline:
        identity_ok, identity_detail = saas_jwks_ok(JWKS_URL)
        budget_ok, budget_detail = saas_jwks_ok(BUDGET_JWKS_URL, budget_kid)
        if identity_ok and budget_ok:
            print(f"  https 身份 JWKS 就绪:{JWKS_URL} {identity_detail}")
            print(f"  https 预算 JWKS 就绪:{BUDGET_JWKS_URL} {budget_detail}")
            return
        detail = f"identity={identity_detail}; budget={budget_detail}"
        time.sleep(2)
    die(f"TLS JWKS 端点 30s 内不可用:{detail}(检查 gain-saas web 是否已重建重启、4020 是否在听、socat 日志)")


def backup(files: list[Path]) -> Path:
    target = archive_dir() / "before"
    target.mkdir(parents=True, exist_ok=True)
    os.chmod(target.parent, 0o700)
    os.chmod(target, 0o700)
    sums = []
    for path in files:
        copy = target / path.name
        shutil.copy2(path, copy)
        os.chmod(copy, 0o600)
        sums.append(f"{sha256(copy)}  {path.name}")
    (target / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    subprocess.run(["chown", "-R", "xin:xin", str(target.parent)], check=False)
    return target


def restart_backend() -> None:
    """root 直接跑 runtime.sh:
    - compose 客户端要读 backend/.secrets/*.env(600 root),xin 读不到,不能 runuser 降权;
    - root 读 xin 的 git 仓会触发 dubious ownership,用 GIT_CONFIG_* 放行 safe.directory;
    - DOCKER_CONTEXT=default 固定到原生 dockerd(root 的 currentContext 是 desktop-linux)。
    """
    env = dict(os.environ)
    env.update({
        "DOCKER_CONTEXT": "default",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "safe.directory",
        "GIT_CONFIG_VALUE_0": "*",
    })
    command = [str(RUNTIME_SH), "up", "-d", "--no-deps", "--force-recreate", "api", "worker", "platform-worker"]
    print("\n$ " + " ".join(command))
    subprocess.run(command, check=True, env=env)


def wait_ready(timeout: int = 240) -> dict:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(READY_URL, timeout=5) as response:
                last = json.loads(response.read().decode("utf-8"))
            if last.get("status") == "ready":
                print(f"引擎 readiness: ready(auth_jwks={last.get('components', {}).get('auth_jwks')})")
                return last
            print(f"等待 readiness 中… status={last.get('status')} code={last.get('code')}")
        except Exception as exc:  # noqa: BLE001 - 启动窗口内任何异常都只代表还没起来
            print(f"等待 API 启动:{exc}")
        time.sleep(5)
    die(f"{timeout}s 内引擎没有回到 ready,最后状态:{json.dumps(last, ensure_ascii=False)[:500]}")


def check_r4_fence_ack() -> None:
    try:
        status, body = http_json(FENCE_ACK_URL)
    except Exception as exc:  # noqa: BLE001
        die(f"R4 护栏失败:fence-ack JWKS 不可用({exc});AUTH_JWKS_URI 必须保持 https。")
    if status != 200 or not body.get("keys"):
        die(f"R4 护栏失败:fence-ack JWKS HTTP {status};撤销信任快照可能已退化,按 --rollback 回退。")
    print("R4 护栏:fence-ack JWKS 200(https AUTH_JWKS_URI 未破坏撤销信任)")


def apply() -> None:
    if os.geteuid() != 0:
        die("--apply 需要 root(写 backend/.secrets、r4-pki、docker)")
    issuer = check_saas_env()
    try:
        status, _ = http_json(SAAS_READY_URL)
        if status != 200:
            die(f"gain-saas web 未就绪(HTTP {status});先启动 4020")
    except Exception as exc:  # noqa: BLE001
        die(f"gain-saas web 不可达({exc});先启动 4020")

    files = target_files()
    plans = {path: plan_file(path) for path in files}
    print(f"\nSaaS ENGINE_JWT_ISSUER={issuer}")
    print("注意:引擎只有一个 AUTH_JWKS_URI/issuer,改指向 gain-saas 后,GrowthOS 签发的 token 将不再被接受。")
    print("同时 backend-runtime.env 的 EXECUTION_BUDGET_GRANT_* 改指 gain-saas:api/worker 的 workspace Grant")
    print("改由 gain-saas 签发;platform-worker 的副本仍是 GrowthOS(R4 平台 Grant/撤销,schedules paused)。")

    provision_tls()
    backup_dir = backup(files)
    print(f"\n已归档:{backup_dir}")

    for path, (entries, _current) in plans.items():
        write_atomic(path, render(entries))
        print(f"已写入 {path}")

    restart_backend()
    wait_ready()
    check_r4_fence_ack()
    print("\n引擎侧已生效。下一步(以 xin 身份,非 root):")
    print("  node /global/gain-saas/deploy/verify-engine-integration.mjs")
    print("回退:python3 /global/gain-saas/deploy/engine-integration-apply.py --rollback")


def restart_only() -> None:
    """收尾模式:env 已写入但容器没重建时用。不备份、不改 env、不碰 TLS。"""
    if os.geteuid() != 0:
        die("--restart-only 需要 root(读 .secrets 并重建容器)")
    restart_backend()
    wait_ready()
    check_r4_fence_ack()
    print("\n容器已重建。下一步(以 xin 身份,非 root):")
    print("  node /global/gain-saas/deploy/verify-engine-integration.mjs")


def rollback() -> None:
    if os.geteuid() != 0:
        die("--rollback 需要 root")
    # 过滤掉「已经是目标配置」的归档(部分失败后二次 --apply 会在目标状态上再存一份)
    candidates = []
    for source in sorted(ARCHIVE_ROOT.glob("engine-integration-gain-saas-xin-*/before")):
        snapshot = source / MAIN_ENV.name
        if not snapshot.exists():
            continue
        if env_values(snapshot).get("AUTH_JWKS_URI") != DESIRED["AUTH_JWKS_URI"]:
            candidates.append(source)
    if not candidates:
        die("找不到可回退的归档(需要 AUTH_JWKS_URI 与目标不同的 before 快照)")
    source = candidates[-1]
    print(f"使用归档:{source}")
    for path in [MAIN_ENV, PLATFORM_ENV]:
        copy = source / path.name
        if copy.exists():
            write_atomic(path, copy.read_text(encoding="utf-8"))
            print(f"已还原 {path} ← {copy}")
    restart_backend()
    wait_ready()
    check_r4_fence_ack()
    print("已回退到归档状态并重建容器(TLS 端点保留;它只是回环上的只读代理)。")


def main() -> None:
    parser = argparse.ArgumentParser(description="按 deploy/engine-integration.md 配置引擎侧对接")
    parser.add_argument("--apply", action="store_true", help="真正写入并重建容器(默认只演练)")
    parser.add_argument("--restart-only", action="store_true", help="只重建 api/worker/platform-worker(env 已写入时收尾)")
    parser.add_argument("--rollback", action="store_true", help="用最近的可回退归档还原")
    args = parser.parse_args()
    if args.rollback:
        rollback()
        return
    if args.restart_only:
        restart_only()
        return
    if args.apply:
        apply()
        return
    if os.geteuid() != 0:
        die("dry-run 也要读 root 600 的 backend/.secrets 和 r4-pki;请用 sudo 运行")
    check_saas_env()
    for path in target_files():
        plan_file(path)
    print("\n== TLS 端点(引擎验签用) ==")
    if (PKI / "gain-saas-jwks.pem").exists():
        print("  r4-pki 叶子已存在;--apply 会刷新 deploy/tls 副本并重启 gain-saas-jwks-tls")
    else:
        print("  r4-pki 叶子缺失;--apply 会运行 r4-pki init 生成 gain-saas-jwks(growthos-server-ca 签发)")
    if TLS_DIR.joinpath("server.pem").exists():
        print(f"  当前 https 身份 JWKS:{JWKS_URL} → {saas_jwks_ok(JWKS_URL)}")
        print(f"  当前 https 预算 JWKS:{BUDGET_JWKS_URL} → {saas_jwks_ok(BUDGET_JWKS_URL, env_values(SAAS_ENV).get('ENGINE_BUDGET_GRANT_KEY_ID'))}")
    else:
        print("  deploy/tls 尚未就位")
    print("\n以上为 dry-run。确认后加 --apply。")


if __name__ == "__main__":
    main()
