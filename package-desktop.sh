#!/usr/bin/env bash
#
# One-click desktop packaging for the current machine.
#
#   ./package-desktop.sh
#   ./package-desktop.sh --force-ace-runtime
#   ./package-desktop.sh --force-runtime
#
# The script prepares the local build environment, installs project
# dependencies, rebuilds desktop runtimes, and creates the desktop package that
# matches the current OS. On macOS it creates an unsigned .app, .zip and .dmg.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
source "$ROOT/scripts/dependency_helpers.sh"

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
FFMPEG_INSTALL_TIMEOUT="${FFMPEG_INSTALL_TIMEOUT:-7200}"

log() {
  echo "[package] $*"
}

fail() {
  echo "[package] 错误：$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./package-desktop.sh [options]

Options:
  --force-runtime          强制重建全部 desktop runtime
  --force-backend-runtime  只强制重建 backend runtime
  --force-svc-runtime      只强制重建 SVC runtime
  --force-ace-runtime      只强制重建 ACE-Step runtime
  -h, --help               显示帮助

默认会根据 marker/hash 复用未变更的 runtime archive。
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --force-runtime)
        export FORCE_DESKTOP_RUNTIME=1
        ;;
      --force-backend-runtime)
        export FORCE_BACKEND_RUNTIME=1
        ;;
      --force-svc-runtime)
        export FORCE_SVC_RUNTIME=1
        ;;
      --force-ace-runtime)
        export FORCE_ACESTEP_RUNTIME=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "未知参数：$1。使用 ./package-desktop.sh --help 查看支持的参数。"
        ;;
    esac
    shift
  done
}

log_runtime_policy() {
  log "runtime 打包策略：默认复用 marker/hash 未变化的 archive。"
  [ "${FORCE_DESKTOP_RUNTIME:-0}" = "1" ] && log "已启用：强制重建全部 runtime。"
  [ "${FORCE_BACKEND_RUNTIME:-0}" = "1" ] && log "已启用：只强制重建 backend runtime。"
  [ "${FORCE_SVC_RUNTIME:-0}" = "1" ] && log "已启用：只强制重建 SVC runtime。"
  [ "${FORCE_ACESTEP_RUNTIME:-0}" = "1" ] && log "已启用：只强制重建 ACE-Step runtime。"
  return 0
}

ensure_macos_command_line_tools() {
  if [ "$(uname -s)" != "Darwin" ]; then
    return 0
  fi
  if xcode-select -p >/dev/null 2>&1; then
    log "Xcode Command Line Tools 已就绪。"
    return 0
  fi
  log "未发现 Xcode Command Line Tools，正在打开安装器..."
  xcode-select --install >/dev/null 2>&1 || true
  fail "请先完成 Xcode Command Line Tools 安装，然后重新运行 ./package-desktop.sh"
}

node_major() {
  node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0
}

log_node_ready() {
  log "Node/npm 已就绪：node $(node -v), npm $(npm -v) ($(command -v node))"
}

load_nvm() {
  if command -v nvm >/dev/null 2>&1; then
    return 0
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    return 0
  fi
  if [ -s "/opt/homebrew/opt/nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "/opt/homebrew/opt/nvm/nvm.sh"
    return 0
  fi
  if [ -s "/usr/local/opt/nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "/usr/local/opt/nvm/nvm.sh"
    return 0
  fi
  return 1
}

try_nvm_node_22() {
  load_nvm || return 1
  log "检测到 nvm，尝试使用已安装的 Node 22..."
  if nvm use 22 >/dev/null 2>&1 || nvm use 22 --silent >/dev/null 2>&1; then
    return 0
  fi
  if [ "${PACKAGE_INSTALL_NODE_WITH_NVM:-0}" = "1" ]; then
    log "nvm 未安装 Node 22，正在通过 nvm install 22 安装..."
    nvm install 22
    nvm use 22
    return 0
  fi
  log "nvm 可用但未找到 Node 22；如需脚本自动安装，可设置 PACKAGE_INSTALL_NODE_WITH_NVM=1。"
  return 1
}

ensure_node_22() {
  # 自动加载 nvm（兼容非交互式 shell），优先使用 nvm 管理的 node 版本
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh" --no-use
    nvm use default 2>/dev/null || true
  fi

  local major
  major="$(node_major)"

  # 只要 node >= 22 就直接认定就绪
  # 兼容 fnm/nvm/volta 等版本管理工具在非交互式 shell 下 PATH 未导出的情况
  if [ "$major" -ge 22 ]; then
    log "Node 已就绪：node $(node -v)"
    # npm 可能不在 PATH 中（如 fnm），尝试从 node 同级目录加载
    if ! command -v npm >/dev/null 2>&1; then
      local node_dir
      node_dir="$(dirname "$(command -v node)")"
      if [ -x "$node_dir/npm" ]; then
        export PATH="$node_dir:$PATH"
      fi
    fi
    if command -v npm >/dev/null 2>&1; then
      log "npm 已就绪：npm $(npm -v)"
    else
      log "警告：npm 不可用，后续 npm install 可能失败。"
    fi
    return 0
  fi

  if command -v npm >/dev/null 2>&1; then
    log "当前 Node 版本是 $(node -v 2>/dev/null || echo unknown)，项目建议 Node >= 22。"
  else
    log "未发现 Node/npm。"
  fi

  if try_nvm_node_22 && command -v npm >/dev/null 2>&1 && [ "$(node_major)" -ge 22 ]; then
    log_node_ready
    return 0
  fi

  if command -v brew >/dev/null 2>&1; then
    log "使用 Homebrew 安装/升级 node@22..."
    retry_command "brew install node@22" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" brew install node@22 || true
    export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:$PATH"
    if ! command -v npm >/dev/null 2>&1 || [ "$(node_major)" -lt 22 ]; then
      retry_command "brew link node@22" "$SHORT_NETWORK_TIMEOUT" "$NETWORK_RETRIES" brew link --overwrite --force node@22 || true
      export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:$PATH"
    fi
  fi

  if ! command -v npm >/dev/null 2>&1 || [ "$(node_major)" -lt 22 ]; then
    fail "未能自动准备 Node 22。请先切换到 Node >=22（例如 nvm use 22），或安装 Node 22（nvm install 22 / brew install node@22）后重试。"
  fi

  log_node_ready
}

ensure_rust() {
  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    log "Rust/Cargo 已就绪：$(rustc --version)"
    return 0
  fi

  log "未发现 Rust/Cargo，正在通过 rustup 安装..."
  retry_command "安装 Rust/Cargo" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
    bash -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y'
  export PATH="$HOME/.cargo/bin:$PATH"

  command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1 \
    || fail "Rust/Cargo 安装后仍不可用，请检查 rustup 安装日志。"
  log "Rust/Cargo 已就绪：$(rustc --version)"
}

ensure_git() {
  command -v git >/dev/null 2>&1 || fail "未找到 git，请先安装 git。"
  log "Git 已就绪：$(git --version)"
}

ensure_ffmpeg() {
  if [ -n "${APP_FFMPEG_EXE:-}" ] && [ -n "${APP_FFPROBE_EXE:-}" ]; then
    if [ -x "$APP_FFMPEG_EXE" ] && [ -x "$APP_FFPROBE_EXE" ]; then
      log "ffmpeg/ffprobe 已就绪：$APP_FFMPEG_EXE"
      return 0
    fi
    fail "APP_FFMPEG_EXE 或 APP_FFPROBE_EXE 不可执行，请检查路径。"
  fi

  if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    export APP_FFMPEG_EXE="${APP_FFMPEG_EXE:-$(command -v ffmpeg)}"
    export APP_FFPROBE_EXE="${APP_FFPROBE_EXE:-$(command -v ffprobe)}"
    log "ffmpeg/ffprobe 已就绪：$(ffmpeg -version 2>/dev/null | head -1)"
    return 0
  fi

  log "未发现 ffmpeg/ffprobe，打包 runtime 需要内置它们。"
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    log "使用 Homebrew 安装 ffmpeg（该步骤可能较久，超时 ${FFMPEG_INSTALL_TIMEOUT}s，不会频繁重启下载）..."
    retry_command "brew install ffmpeg" "$FFMPEG_INSTALL_TIMEOUT" 1 brew install ffmpeg
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  else
    fail "请先安装 ffmpeg/ffprobe，或设置 APP_FFMPEG_EXE/APP_FFPROBE_EXE 后重试。macOS 推荐：brew install ffmpeg"
  fi

  command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 \
    || fail "ffmpeg/ffprobe 安装后仍不可用，请检查 PATH。"
  export APP_FFMPEG_EXE="${APP_FFMPEG_EXE:-$(command -v ffmpeg)}"
  export APP_FFPROBE_EXE="${APP_FFPROBE_EXE:-$(command -v ffprobe)}"
  log "ffmpeg/ffprobe 已就绪：$(ffmpeg -version 2>/dev/null | head -1)"
}

prepare_project_dependencies() {
  log "准备 uv..."
  ensure_uv_available "package"

  log "准备后端 Python 3.12 环境与依赖..."
  ensure_backend_venv "$BACKEND" "package"

  log "准备前端依赖..."
  ensure_npm_dependencies "$FRONTEND" "package"
}

package_current_platform() {
  local os
  os="$(uname -s)"
  cd "$FRONTEND"

  case "$os" in
    Darwin)
      log "当前平台：macOS，开始生成 unsigned .app/.zip/.dmg..."
      bash "$ROOT/scripts/package_macos_unsigned.sh"
      log "macOS 打包完成。产物目录：$FRONTEND/src-tauri/target/release/bundle"
      ;;
    Linux)
      log "当前平台：Linux，开始构建当前平台桌面包..."
      npm run desktop:build
      log "Linux 打包完成。产物目录：$FRONTEND/src-tauri/target/release/bundle"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      log "当前平台：Windows shell，开始构建 portable zip 包..."
      npm run desktop:build:win
      log "Windows 打包完成。产物目录：$FRONTEND/src-tauri/target/release/bundle"
      ;;
    *)
      fail "暂不支持当前平台：$os"
      ;;
  esac
}

main() {
  parse_args "$@"
  log "开始一键打包桌面端..."
  log_runtime_policy
  ensure_macos_command_line_tools
  ensure_git
  ensure_node_22
  ensure_rust
  ensure_ffmpeg
  prepare_project_dependencies
  package_current_platform
  log "全部完成。"
}

main "$@"
