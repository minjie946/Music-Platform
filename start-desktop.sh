#!/usr/bin/env bash
#
# 一键启动「音乐工作台」桌面端（开发模式）。
#
#   ./start-desktop.sh
#
# 启动流程：
#   1. 确保 Python 3.12 虚拟环境就绪
#   2. 安装/检查前端依赖
#   3. 检查 Tauri 资源目录
#   4. 启动 Tauri dev（主进程，自动拉起 Vite 与桌面后端）
#
# 仅想用「音轨分离」、不启动 SVC 时：
#   SKIP_SVC=1 ./start-desktop.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
source "$ROOT/scripts/dependency_helpers.sh"
export MUSIC_STUDIO_RUNTIME_MODE="${MUSIC_STUDIO_RUNTIME_MODE:-desktop-dev}"
LOGS_DIR="$ROOT/logs"
mkdir -p "$LOGS_DIR"
export APP_RUN_LOG_DIR="$LOGS_DIR/runs/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$APP_RUN_LOG_DIR"
for name in launcher api worker acestep svc; do
  : > "$APP_RUN_LOG_DIR/${name}.log"
done

API_PORT="${LOCAL_API_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

SVC_DIR="${SVC_DIR:-$ROOT/svc_service}"
SVC_API_HOST="${SVC_API_HOST:-127.0.0.1}"
SVC_API_PORT="${SVC_API_PORT:-8002}"

PIDS=()

check_port() {
  local port="$1"
  local name="$2"
  if command -v lsof >/dev/null 2>&1; then
    local pid
    pid="$(lsof -ti ":$port" 2>/dev/null | head -1)"
    if [ -n "$pid" ]; then
      local cmd
      cmd="$(ps -p "$pid" -o command= 2>/dev/null | head -c 50)"
      echo "[desktop] ⚠️  端口 $port ($name) 已被占用 (PID: $pid, 进程: ${cmd:-unknown})"
      echo "[desktop]    清理命令: lsof -ti:$port | xargs -r kill -9"
      return 1
    fi
  elif command -v ss >/dev/null 2>&1; then
    local pid
    pid="$(ss -tlnp | grep ":$port" | awk '{print $7}' | sed 's/,.*//;s/.*=//' | head -1)"
    if [ -n "$pid" ]; then
      echo "[desktop] ⚠️  端口 $port ($name) 已被占用 (PID: $pid)"
      echo "[desktop]    清理命令: kill -9 $pid"
      return 1
    fi
  fi
  return 0
}

check_ports() {
  echo "[desktop] 检查端口占用..."
  local has_conflict=0
  check_port "$FRONTEND_PORT" "前端服务" || has_conflict=1
  
  if [ "$has_conflict" -eq 1 ]; then
    echo ""
    echo "[desktop] ❌ 检测到端口占用，请先清理后重试："
    echo "[desktop]    清理前端端口: lsof -ti:$FRONTEND_PORT | xargs -r kill -9"
    echo "[desktop]    或单独清理:  kill -9 <PID>"
    echo ""
    exit 1
  fi
}

cleanup() {
  echo ""
  echo "[desktop] 正在停止全部服务..."
  for pid in "${PIDS[@]:-}"; do
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill -INT "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && wait "$pid" 2>/dev/null || true
  done
  echo "[desktop] 已退出。"
}
trap cleanup INT TERM EXIT

ensure_uv() {
  ensure_uv_available "desktop"
}

ensure_uv
check_ports

echo "[desktop] 音乐生成服务 (ACE-Step) 将在打开「音乐生成」页后按需启动。"
echo "[desktop] 桌面后端与 SVC 将由 Tauri 应用内部按动态端口启动。"

echo "[desktop] 检查后端 Python 环境..."
cd "$BACKEND"

ensure_backend_venv "$BACKEND" "desktop"
export MUSIC_STUDIO_PYTHON="$(backend_python_path "$BACKEND")"
export ACESTEP_DIR="${ACESTEP_DIR:-$ROOT/external/ACE-Step-1.5}"
export APP_ACESTEP_DIR="${APP_ACESTEP_DIR:-$ACESTEP_DIR}"
# ACESTEP_SOURCE_ZIP 交由 launch_acestep.sh 按 settings.resources_dir / <workspace>/resources /
# 项目内 resources 解析；此处不写死默认值，避免被误判为“显式指定”而无法响应用户配置。

unset VIRTUAL_ENV

echo "[desktop] 检查前端依赖..."
cd "$FRONTEND"

ensure_npm_dependencies "$FRONTEND" "desktop"

# Tauri dev 也会校验 tauri.conf.json 中声明的 bundle resources。
# 完整构建会通过 npm run desktop:runtime 生成内容；开发模式只需要目录存在。
mkdir -p "$FRONTEND/src-tauri/desktop-runtime"

echo ""
echo "============================================================"
echo "  准备启动桌面端"
echo "============================================================"
echo "  后端 API  : 由桌面端动态端口启动"
echo "  前端服务  : http://localhost:${FRONTEND_PORT} (由 Tauri 启动)"
echo "  SVC 音源  : 由桌面端动态端口启动"
echo "------------------------------------------------------------"
echo "  日志目录  : ${APP_RUN_LOG_DIR}"
echo "------------------------------------------------------------"

echo "[desktop] 启动 Tauri dev..."
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
exec npm run desktop:dev
