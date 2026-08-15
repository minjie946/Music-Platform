#!/usr/bin/env python3
"""Run the Tauri CLI with cross-platform environment normalization."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"


def main() -> int:
    env = os.environ.copy()
    home = Path.home()
    extra_paths = [
        home / ".cargo" / "bin",
        home / ".local" / "bin",
    ]
    env["PATH"] = os.pathsep.join(
        [str(path) for path in extra_paths if path.exists()] + [env.get("PATH", "")]
    )
    # Tauri v2 expects boolean strings; some sandboxes expose CI=1.
    env["CI"] = "false"

    npx = shutil.which("npx", path=env["PATH"])
    if not npx and os.name == "nt":
        npx = shutil.which("npx.cmd", path=env["PATH"])
    if not npx:
        print("[desktop:tauri] 未找到 npx，请先安装 Node 22。", file=sys.stderr)
        return 1

    return subprocess.run([npx, "tauri", *sys.argv[1:]], cwd=str(FRONTEND), env=env).returncode


if __name__ == "__main__":
    raise SystemExit(main())
