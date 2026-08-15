#!/usr/bin/env python3
"""Cross-platform desktop build preflight checks."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
BACKEND = ROOT / "backend"


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def log(message: str) -> None:
    print(f"[desktop:preflight] {message}")


def fail(message: str) -> None:
    print(f"[desktop:preflight] {message}", file=sys.stderr)
    raise SystemExit(1)


def add_common_paths() -> None:
    home = Path.home()
    candidates = [
        home / ".cargo" / "bin",
        home / ".local" / "bin",
    ]
    os.environ["PATH"] = os.pathsep.join(
        [str(path) for path in candidates if path.exists()] + [os.environ.get("PATH", "")]
    )


def require_command(name: str, hint: str) -> str:
    found = shutil.which(name)
    if not found and os.name == "nt":
        found = shutil.which(f"{name}.cmd") or shutil.which(f"{name}.exe")
    if not found:
        fail(hint)
    return found


def ensure_cargo_mirror() -> None:
    """Auto-configure cargo USTC mirror for China mainland users if not already set."""
    cargo_config_dir = Path.home() / ".cargo"
    cargo_config = cargo_config_dir / "config.toml"
    if cargo_config.exists():
        content = cargo_config.read_text(encoding="utf-8")
        if "[source.crates-io]" in content and "replace-with" in content:
            return  # already configured
    log("配置 cargo 镜像源（USTC）以加速 Rust 依赖下载...")
    cargo_config_dir.mkdir(parents=True, exist_ok=True)
    cargo_config.write_text(
        "[source.crates-io]\n"
        'replace-with = "ustc"\n'
        "[source.ustc]\n"
        'registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"\n',
        encoding="utf-8",
    )
    log("cargo 镜像源已配置")


def run(args: list[str], cwd: Path = ROOT) -> None:
    subprocess.run(args, cwd=str(cwd), check=True)


def ensure_backend_python_version() -> None:
    project_python = (
        BACKEND / ".venv" / "Scripts" / "python.exe"
        if os.name == "nt"
        else BACKEND / ".venv" / "bin" / "python"
    )
    if not project_python.is_file():
        return
    version = subprocess.check_output(
        [
            str(project_python),
            "-c",
            "import sys; print('.'.join(map(str, sys.version_info[:3])))",
        ],
        text=True,
    ).strip()
    if not version.startswith("3.12."):
        fail(
            f"backend/.venv 必须是 Python 3.12，当前是 {version}。"
            "请运行：rm -rf backend/.venv && ./start-desktop.sh"
        )


def main() -> int:
    configure_stdio()
    add_common_paths()

    log("检查 Node/Tauri 依赖...")
    require_command("npm", "未找到 npm，请先安装 Node 22。")
    if not (FRONTEND / "node_modules").is_dir():
        fail("未找到 frontend/node_modules，请先运行：cd frontend && npm install")
    npx = require_command("npx", "未找到 npx，请先安装 Node 22。")
    run([npx, "tauri", "--version"], FRONTEND)

    log("检查 Rust/Cargo...")
    require_command("cargo", "未找到 cargo。请先安装 Rust：https://rustup.rs/")
    require_command("rustc", "未找到 rustc。请先安装 Rust：https://rustup.rs/")
    ensure_cargo_mirror()

    log("检查 Python/uv 构建工具...")
    require_command("uv", "未找到 uv。请先安装 uv：https://docs.astral.sh/uv/getting-started/installation/")
    if sys.version_info < (3, 10):
        fail(f"构建脚本需要 Python >= 3.10，当前是 {sys.version.split()[0]}")
    ensure_backend_python_version()
    run([sys.executable, "-m", "py_compile", str(BACKEND / "desktop_launcher.py")], ROOT)
    run([sys.executable, "-m", "py_compile", str(ROOT / "scripts" / "build_desktop_runtime.py")], ROOT)

    log("通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
