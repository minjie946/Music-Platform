#!/usr/bin/env python3
"""Build a Windows portable desktop package without NSIS/MSI bundling."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
TAURI_DIR = FRONTEND / "src-tauri"
TARGET_RELEASE = TAURI_DIR / "target" / "release"
BUNDLE_DIR = TARGET_RELEASE / "bundle" / "portable"


def run(args: list[str], cwd: Path) -> None:
    print(f"[windows-portable] {' '.join(args)}", flush=True)
    subprocess.run(args, cwd=str(cwd), check=True)


def copy_item(src: Path, dest: Path) -> None:
    if not src.exists():
        raise SystemExit(f"[windows-portable] resource missing: {src}")
    if dest.exists():
        if dest.is_dir():
            shutil.rmtree(dest)
        else:
            dest.unlink()
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dest)
    else:
        shutil.copy2(src, dest)


def copy_resources(portable_dir: Path) -> None:
    config = json.loads((TAURI_DIR / "tauri.conf.json").read_text("utf-8"))
    resources = config["bundle"]["resources"]
    for src_text, dest_text in resources.items():
        src = (TAURI_DIR / src_text).resolve()
        dest = portable_dir / dest_text
        copy_item(src, dest)


def main() -> int:
    package = json.loads((FRONTEND / "package.json").read_text("utf-8"))
    version = package.get("version", "0.0.0")

    run(["npm", "run", "desktop:preflight"], FRONTEND)
    run(["npm", "run", "desktop:runtime"], FRONTEND)
    run(["node", "../scripts/run_python.mjs", "../scripts/run_tauri.py", "build", "--no-bundle"], FRONTEND)

    exe = TARGET_RELEASE / "music-studio-desktop.exe"
    if not exe.is_file():
        raise SystemExit(f"[windows-portable] built exe not found: {exe}")

    portable_dir = BUNDLE_DIR / "Music Studio"
    if portable_dir.exists():
        shutil.rmtree(portable_dir)
    portable_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exe, portable_dir / "Music Studio.exe")
    copy_resources(portable_dir)

    zip_base = BUNDLE_DIR / f"Music_Studio_{version}_x64_portable"
    archive = shutil.make_archive(str(zip_base), "zip", root_dir=BUNDLE_DIR, base_dir="Music Studio")
    print(f"[windows-portable] done: {archive}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
