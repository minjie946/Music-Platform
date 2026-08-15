#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
source "$ROOT/scripts/dependency_helpers.sh"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

echo "[desktop:bootstrap] 准备 uv..."
ensure_uv_available "desktop:bootstrap"

echo "[desktop:bootstrap] 准备后端 Python 3.12 虚拟环境..."
ensure_backend_venv "$BACKEND" "desktop:bootstrap"

echo "[desktop:bootstrap] 准备前端依赖..."
ensure_npm_dependencies "$FRONTEND" "desktop:bootstrap"

if ! command -v cargo >/dev/null 2>&1; then
  echo "[desktop:bootstrap] 警告：未找到 Rust/Cargo。桌面构建前请安装：https://rustup.rs/" >&2
fi

echo "[desktop:bootstrap] 完成。可继续运行：cd frontend && npm run desktop:dev"
