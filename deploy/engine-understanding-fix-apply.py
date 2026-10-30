#!/usr/bin/env python3
"""engine-understanding-fix-apply —— 构建带 persistOfferings 修复的引擎镜像并部署。

  engine-understanding-fix-apply.py              # dry-run:检查补丁/镜像/命令
  engine-understanding-fix-apply.py --build-only # 只构建本地镜像
  engine-understanding-fix-apply.py --local      # 构建本地镜像并用它重建 api/worker(不发布)
  engine-understanding-fix-apply.py --apply      # 构建→push ghcr→把 digest 写入 runtime.compose.env→重建
  engine-understanding-fix-apply.py --rollback   # 还原最近一次 env 备份并重建 api/worker

为什么需要 root:要 docker build/push、写 /global/local-config/global/runtime.compose.env、重建容器。
--local 只用于本机验证:容器改用本地 tag,之后跑 runtime.sh 会回到 runtime.compose.env 里钉住的 digest。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path("/global/backend")
ACTIVITIES = BACKEND / "apps/api/src/temporal/understanding.activities.ts"
PATCH = Path("/global/gain-saas/deploy/patches/engine-understanding-offerings-ack.patch")
RUNTIME_ENV = Path("/global/local-config/global/runtime.compose.env")
LOCAL_ENV = Path("/global/local-config/global/local.env")
RUNTIME_SH = Path("/global/local-config/global/runtime.sh")
INFRA_LOCAL = Path("/global/local-config/global/infra.local.yaml")
ARCHIVE_ROOT = Path("/global/_archive")
READY_URL = "http://127.0.0.1:3000/api/v1/health/ready"
REMOTE_REPO = "ghcr.io/mlhjyx/global-backend"
PATCH_MARKER = "爬取回执已在 persistClaims"


def die(message: str) -> None:
    print(f"engine-understanding-fix: {message}", file=sys.stderr)
    sys.exit(2)


def run(cmd: list[str], *, check: bool = True, env: dict[str, str] | None = None, capture: bool = False) -> str:
    print("$ " + " ".join(cmd))
    result = subprocess.run(
        cmd,
        check=check,
        env=env,
        text=True,
        capture_output=True if capture else False,
    )
    if capture:
        return (result.stdout or "").strip()
    return ""


def docker_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update({
        "DOCKER_CONTEXT": "default",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "safe.directory",
        "GIT_CONFIG_VALUE_0": "*",
    })
    return env


def sha() -> str:
    return run(["git", "-C", str(BACKEND), "rev-parse", "HEAD"], capture=True)


def source_state() -> tuple[str, str]:
    if not ACTIVITIES.exists():
        die(f"找不到 {ACTIVITIES}")
    text = ACTIVITIES.read_text(encoding="utf-8")
    if PATCH_MARKER not in text:
        die(
            "引擎源码未包含 persistOfferings 修复;先在 /global/backend 应用并提交补丁:\n"
            f"  git -C /global/backend apply {PATCH}\n"
            "  git -C /global/backend add apps/api/src/temporal/understanding.activities.ts\n"
            "  git -C /global/backend commit -m 'fix(understanding): stop re-acking crawl receipts'"
        )
    dirty = run(["git", "-C", str(BACKEND), "status", "--porcelain", "--", str(ACTIVITIES.relative_to(BACKEND))], capture=True)
    if dirty:
        die("活动文件还有未提交改动;先提交修复,否则镜像 revision 标签与源码不一致")
    rev = sha()
    return rev, rev[:8]


def env_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value
    return values


def image_exists(image: str) -> bool:
    return subprocess.run(
        ["docker", "image", "inspect", image],
        env=docker_env(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def build(rev: str, short: str, *, allow_cn_fallback: bool = False, force_cn: bool = False) -> str:
    tag = f"global-backend:understanding-ack-{short}"
    built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    print(f"\n构建 {tag}(revision={rev})")
    command = [
        "docker", "build",
        "--build-arg", f"BUILD_SHA={rev}",
        "--build-arg", f"BUILT_AT={built_at}",
        "-t", tag,
    ]
    if force_cn:
        build_cn(rev, built_at, tag)
        return verify_label(tag, rev)
    try:
        run([*command, str(BACKEND)], env=docker_env())
    except subprocess.CalledProcessError:
        if not allow_cn_fallback:
            die(
                "标准 Dockerfile 构建失败。构建需要 snapshot.debian.org(Chromium 151);"
                "网络不可达时用 --local 触发国内镜像 fallback,正式发布请走引擎 CI。"
            )
        print("\n标准构建失败(通常是 snapshot.debian.org 不可达),用临时 Dockerfile 走国内镜像重试。")
        build_cn(rev, built_at, tag)
    return verify_label(tag, rev)


def verify_label(tag: str, rev: str) -> str:
    label = run(
        ["docker", "image", "inspect", tag, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}'],
        env=docker_env(),
        capture=True,
    )
    if label != rev:
        die(f"镜像 revision 标签不正确: {label!r} != {rev!r}")
    return tag


def build_cn(rev: str, built_at: str, tag: str) -> None:
    """仅本地验证:snapshot.debian.org 不可达时,用清华镜像 + 可用的 chromium 150。"""
    dockerfile = BACKEND / "Dockerfile"
    text = dockerfile.read_text(encoding="utf-8")
    replacements = [
        ("https://snapshot.debian.org/archive/debian-security/20260826T000000Z",
         "https://mirrors.tuna.tsinghua.edu.cn/debian-security"),
        ("https://snapshot.debian.org/archive/debian/20260826T000000Z",
         "https://mirrors.tuna.tsinghua.edu.cn/debian"),
        ("chromium=151.0.7922.173-1~deb12u1", "chromium"),
    ]
    for before, after in replacements:
        if before not in text:
            die(f"临时构建: Dockerfile 缺少预期片段 {before}")
        text = text.replace(before, after)
    # 构建容器没有宿主机的 pnpm 配置;默认 npmjs.org 在当前网络会 TLS EOF。
    if "NPM_CONFIG_REGISTRY" not in text:
        marker = "WORKDIR /workspace\n"
        if marker not in text:
            die("临时构建: Dockerfile 缺少 WORKDIR /workspace")
        text = text.replace(
            marker,
            marker + "ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com\n",
            1,
        )
    fd, dockerfile_path = tempfile.mkstemp(prefix="Dockerfile.cn-", suffix=".local")
    os.close(fd)
    try:
        Path(dockerfile_path).write_text(text, encoding="utf-8")
        print("注意: 这是本地验证镜像,复现性与发布镜像不同(chromium 150 + 清华 Debian 镜像)。")
        run(
            [
                "docker", "build",
                "-f", dockerfile_path,
                "--build-arg", f"BUILD_SHA={rev}",
                "--build-arg", f"BUILT_AT={built_at}",
                "-t", tag,
                str(BACKEND),
            ],
            env=docker_env(),
        )
    finally:
        Path(dockerfile_path).unlink(missing_ok=True)


def push(local_tag: str, short: str) -> str:
    remote = f"{REMOTE_REPO}:understanding-ack-{short}"
    run(["docker", "tag", local_tag, remote], env=docker_env())
    try:
        run(["docker", "push", remote], env=docker_env())
    except subprocess.CalledProcessError:
        die(
            "推送 GHCR 失败。先恢复网络/代理,或改用 --local 在本机验证。"
            "不要修改 runtime.compose.env 为未推送的 tag。"
        )
    digests = run(
        ["docker", "image", "inspect", remote, "--format", "{{json .RepoDigests}}"],
        env=docker_env(),
        capture=True,
    )
    try:
        refs = json.loads(digests)
    except json.JSONDecodeError:
        die(f"无法读取镜像 digest: {digests}")
    match = next((ref for ref in refs if ref.startswith(REMOTE_REPO + "@sha256:")), None)
    if not match:
        die(f"镜像没有 GHCR repo digest: {refs}")
    print(f"已推送: {match}")
    return match


def archive_env() -> Path:
    target = ARCHIVE_ROOT / f"engine-understanding-ack-xin-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    (target / "before").mkdir(parents=True, exist_ok=False)
    shutil.copy2(RUNTIME_ENV, target / "before" / RUNTIME_ENV.name)
    subprocess.run(["chown", "-R", "xin:xin", str(target)], check=False)
    return target


def update_runtime_image(image: str) -> Path:
    snapshot = archive_env()
    text = RUNTIME_ENV.read_text(encoding="utf-8")
    replacement = re.sub(
        r"^GLOBAL_BACKEND_IMAGE=.*$",
        f"GLOBAL_BACKEND_IMAGE={image}",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if replacement == text:
        die("runtime.compose.env 没有 GLOBAL_BACKEND_IMAGE 行")
    stat = RUNTIME_ENV.stat()
    tmp = RUNTIME_ENV.with_name(f"{RUNTIME_ENV.name}.tmp-{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, stat.st_mode & 0o777)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(replacement)
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(tmp, stat.st_uid, stat.st_gid)
        os.replace(tmp, RUNTIME_ENV)
    finally:
        if tmp.exists():
            tmp.unlink()
    print(f"已更新 {RUNTIME_ENV}: {image}")
    print(f"env 备份: {snapshot}")
    return snapshot


def restart_api_worker() -> None:
    run(
        [str(RUNTIME_SH), "up", "-d", "--no-deps", "--force-recreate", "api", "worker", "platform-worker"],
        env=docker_env(),
    )



def local_digest(tag: str) -> str:
    refs = run(
        ["docker", "image", "inspect", tag, "--format", "{{json .RepoDigests}}"],
        env=docker_env(),
        capture=True,
    )
    try:
        candidates = json.loads(refs)
    except json.JSONDecodeError:
        die(f"无法读取本地镜像 digest: {refs}")
    match = next((ref for ref in candidates if "@sha256:" in ref), None)
    if match:
        return match
    image_id = run(["docker", "image", "inspect", tag, "--format", "{{.Id}}"], env=docker_env(), capture=True)
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        die(f"本地镜像没有可用 digest: {refs}")
    return f"global-backend@{image_id}"

def restart_local(image_ref: str, rev: str) -> None:
    fd, compose_path = tempfile.mkstemp(prefix="backend-runtime.compose.", suffix=".yml")
    os.close(fd)
    try:
        compose = subprocess.run(
            ["git", "-C", str(BACKEND), "show", f"{rev}:infra/backend-runtime.compose.yml"],
            check=True, text=True, capture_output=True,
        ).stdout
        Path(compose_path).write_text(compose, encoding="utf-8")
        env = docker_env()
        env["GLOBAL_BACKEND_IMAGE"] = image_ref
        run(
            [
                "docker", "compose", "-p", "global",
                "--env-file", str(LOCAL_ENV),
                "--env-file", str(RUNTIME_ENV),
                "-f", str(BACKEND / "docker-compose.yml"),
                "-f", compose_path,
                "-f", str(INFRA_LOCAL),
                "--profile", "managed-runtime",
                "up", "-d", "--no-deps", "--force-recreate", "api", "worker", "platform-worker",
            ],
            env=env,
        )
    finally:
        Path(compose_path).unlink(missing_ok=True)


def wait_ready(timeout: int = 300) -> None:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(READY_URL, timeout=5) as response:
                last = json.loads(response.read().decode("utf-8"))
            if last.get("status") == "ready":
                print("引擎 readiness:ready")
                return
            print(f"等待 readiness… {last.get('status')}")
        except Exception as exc:  # noqa: BLE001
            last = {"error": str(exc)}
        time.sleep(5)
    die(f"{timeout}s 内引擎没有 ready,最后状态:{json.dumps(last, ensure_ascii=False)[:400]}")


def plan() -> tuple[str, str]:
    rev, short = source_state()
    values = env_values(RUNTIME_ENV)
    current = values.get("GLOBAL_BACKEND_IMAGE", "(missing)")
    print(f"引擎 HEAD: {rev}")
    print(f"当前运行时镜像: {current}")
    print(f"本地构建 tag: global-backend:understanding-ack-{short}")
    print(f"远端 tag: {REMOTE_REPO}:understanding-ack-{short}")
    if PATCH.exists():
        print(f"补丁文件: {PATCH}")
    print("镜像构建需要的 build args: BUILD_SHA / BUILT_AT(脚本自动传入)")
    return rev, short


def apply() -> None:
    if os.geteuid() != 0:
        die("--apply 需要 root(docker/push/写 runtime.compose.env)")
    rev, short = plan()
    tag = build(rev, short)
    digest = push(tag, short)
    update_runtime_image(digest)
    restart_api_worker()
    wait_ready()


def local() -> None:
    die(
        "引擎启动会校验镜像文件和 GrowthOS 已登记镜像;本地构建的 digest 无法通过 release identity/platform authority,"
        "部署后 platform-worker 会停在 PLATFORM_BUDGET_AUTHORITY_NOT_READY。"
        "请用 --build-only 产出本地镜像做构建验证,正式部署走引擎 CI/发布流程(新镜像需登记到平台)。"
    )


def rollback() -> None:
    if os.geteuid() != 0:
        die("--rollback 需要 root")
    candidates = sorted(ARCHIVE_ROOT.glob("engine-understanding-ack-xin-*/before/runtime.compose.env"), reverse=True)
    if not candidates:
        print("没有 apply 备份;将直接按当前 runtime.compose.env 重建 api/worker(可用于撤销 --local)。")
        restart_api_worker()
        wait_ready()
        return
    snapshot = candidates[0]
    shutil.copy2(snapshot, RUNTIME_ENV)
    print(f"已还原 {RUNTIME_ENV} ← {snapshot}")
    restart_api_worker()
    wait_ready()


def main() -> None:
    parser = argparse.ArgumentParser(description="构建/部署引擎理解 persistOfferings 修复")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true", help="构建→push→更新 digest→重建 api/worker")
    group.add_argument("--local", action="store_true", help="构建本地镜像并直接重建 api/worker(不发布)")
    group.add_argument("--build-only", action="store_true", help="只构建本地镜像")
    group.add_argument("--rollback", action="store_true", help="还原最近一次 env 备份并重建 api/worker")
    args = parser.parse_args()

    if args.rollback:
        rollback()
        return
    rev, short = plan()
    if args.build_only:
        if os.geteuid() != 0:
            die("--build-only 需要 root(docker)")
        build(rev, short, allow_cn_fallback=True)
        print("\n本地镜像已构建;未部署。")
        return
    if args.local:
        try:
            local()
        except subprocess.CalledProcessError as error:
            die(f"命令失败(exit {error.returncode}): {error.args[:1]}")
        return
    if args.apply:
        try:
            apply()
        except subprocess.CalledProcessError as error:
            die(f"命令失败(exit {error.returncode}): {error.args[:1]}")
        return
    print("\n(dry-run)未构建、未改 env、未重启。")
    print("本机验证: sudo ... --local")
    print("正式发布: sudo ... --apply (需要能访问 ghcr.io)")


if __name__ == "__main__":
    main()
