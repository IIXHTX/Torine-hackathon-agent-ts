#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ARC-Bench Python entrypoint for the Torine TypeScript agent (offline-first).

官方契约（参赛须知 / runner）：提交包入口必须是 main.py；main.py 可以调用
Node / Shell 等运行时。本脚本是一个纯标准库"启动壳"：

  启动顺序（离线优先 + 联网兜底）：
    1. 若 AGENT_ROOT/node_modules/.bin/tsx 已存在 → 直接使用 vendored 依赖，
       绝不联网 npm install（离线路径，打印 "using vendored node_modules (offline)"）。
    2. 若不存在 → 才尝试 `npm install --no-audit --no-fund`（超时约 900s）；
       失败再退一步 `npm install --legacy-peer-deps`；仍失败则打印明确错误并以
       非 0 退出（联网兜底路径，打印 "npm install (online fallback)"）。
    3. 用本地 tsx 二进制以 cwd=AGENT_ROOT 启动 `index.ts`，把子进程退出码
       原样透传（成功必须 exit 0）。

  用法（官方契约，位置参数原样透传给 index.ts）：
    python3 main.py <需求目录> --output-dir <out> [--type web] ...
"""

import shutil
import subprocess
import sys
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parent
INSTALL_TIMEOUT_S = 900  # 约 900s，联网兜底一次装全量依赖


def log(msg: str) -> None:
    print("[torine] " + msg, flush=True)


def run(cmd, cwd=None, timeout=None):
    log("$ " + " ".join(str(c) for c in cmd))
    try:
        return subprocess.run(
            [str(c) for c in cmd],
            cwd=str(cwd) if cwd else None,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        log(f"[warn] command timed out after {timeout}s: {' '.join(str(c) for c in cmd)}")
        return None
    except FileNotFoundError as e:
        log(f"[error] command not found: {e}")
        return None


def ensure_node_deps() -> bool:
    """Return True when a local tsx binary is ready to run (offline or installed)."""
    tsx_bin = AGENT_ROOT / "node_modules" / ".bin" / "tsx"
    if tsx_bin.exists():
        # 离线优先：vendored 依赖齐全，绝不联网。
        log("using vendored node_modules (offline): node_modules/.bin/tsx present, skipping npm install")
        return True

    # 联网兜底：仅在 vendored 依赖缺失时才联网。
    npm = shutil.which("npm")
    if not npm:
        log("[error] node_modules/.bin/tsx missing AND npm not found on PATH; cannot bootstrap offline")
        return False

    log("npm install (online fallback): vendored node_modules absent, installing dependencies")
    first = run([npm, "install", "--no-audit", "--no-fund"], cwd=AGENT_ROOT, timeout=INSTALL_TIMEOUT_S)
    if first is not None and first.returncode == 0 and tsx_bin.exists():
        log("npm install completed (online fallback)")
        return True

    log("[warn] npm install --no-audit --no-fund failed; retrying with --legacy-peer-deps")
    second = run(
        [npm, "install", "--legacy-peer-deps", "--no-audit", "--no-fund"],
        cwd=AGENT_ROOT,
        timeout=INSTALL_TIMEOUT_S,
    )
    if second is not None and second.returncode == 0 and tsx_bin.exists():
        log("npm install --legacy-peer-deps completed (online fallback)")
        return True

    log("[error] npm install failed even with --legacy-peer-deps; cannot start the agent")
    return False


def main() -> int:
    forwarded = sys.argv[1:]  # <需求目录> --output-dir <out> [--type web] ... 原样透传

    if not ensure_node_deps():
        return 1

    tsx_bin = AGENT_ROOT / "node_modules" / ".bin" / "tsx"
    index_ts = AGENT_ROOT / "index.ts"
    cmd = [tsx_bin, index_ts, *forwarded]
    log(f"launching agent: cwd={AGENT_ROOT}")
    result = run(cmd, cwd=AGENT_ROOT)
    # 原样透传子进程退出码：成功必须 exit 0，失败如实非 0。
    if result is None:
        log("[error] agent process did not return a status (killed/timeout)")
        return 1
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
