#!/usr/bin/env bash
# Shared dependency install helpers for local/browser/desktop launch scripts.

NETWORK_RETRIES="${NETWORK_RETRIES:-3}"
NETWORK_TIMEOUT="${NETWORK_TIMEOUT:-900}"
SHORT_NETWORK_TIMEOUT="${SHORT_NETWORK_TIMEOUT:-180}"
PYPI_MIRROR_URL="${PYPI_MIRROR_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
PYTORCH_CPU_MIRROR_URL="${PYTORCH_CPU_MIRROR_URL:-https://mirror.sjtu.edu.cn/pytorch-wheels/cpu}"
NPM_MIRROR_REGISTRY="${NPM_MIRROR_REGISTRY:-https://registry.npmmirror.com}"
UV_PYTHON_INSTALL_MIRROR="${UV_PYTHON_INSTALL_MIRROR:-}"
GITHUB_PROXY_URL="${GITHUB_PROXY_URL:-}"
MIRROR_FALLBACK_ATTEMPTS="${MIRROR_FALLBACK_ATTEMPTS:-1}"

# ---------------------------------------------------------------------------
# 依赖安装缓存（marker）：对关键输入（lock/requirements/版本）算哈希写入 marker 文件，
# 内容未变则跳过重复安装，显著加快日常启动。设 FORCE_DEP_INSTALL=1 可强制重装。
# ---------------------------------------------------------------------------
_deps_hash() {
  # 对给定的文件/字符串组合算一个稳定指纹。参数：任意个 "文件路径" 或 "str:任意串"。
  local acc="" item
  for item in "$@"; do
    if [ "${item#str:}" != "$item" ]; then
      acc="${acc}|${item#str:}"
    elif [ -f "$item" ]; then
      acc="${acc}|$(shasum -a 256 "$item" 2>/dev/null | awk '{print $1}')"
    else
      acc="${acc}|missing:${item}"
    fi
  done
  printf '%s' "$acc" | shasum -a 256 2>/dev/null | awk '{print $1}'
}

# deps_marker_fresh <marker_file> <inputs...> —— marker 存在且哈希匹配则返回 0（可跳过）。
deps_marker_fresh() {
  local marker="$1"; shift
  [ "${FORCE_DEP_INSTALL:-0}" = "1" ] && return 1
  [ -f "$marker" ] || return 1
  local want have
  want="$(_deps_hash "$@")"
  have="$(cat "$marker" 2>/dev/null)"
  [ -n "$want" ] && [ "$want" = "$have" ]
}

# deps_marker_write <marker_file> <inputs...> —— 安装成功后记录当前哈希。
deps_marker_write() {
  local marker="$1"; shift
  local h; h="$(_deps_hash "$@")"
  [ -n "$h" ] || return 0
  mkdir -p "$(dirname "$marker")" 2>/dev/null || true
  printf '%s' "$h" > "$marker" 2>/dev/null || true
}

run_with_timeout() {
  local timeout_s="$1"
  shift
  local python_bin
  python_bin="$(command -v python3 || command -v python || true)"
  if [ -n "$python_bin" ]; then
    "$python_bin" - "$timeout_s" "$@" <<'PY'
import subprocess
import sys

timeout = int(sys.argv[1])
cmd = sys.argv[2:]
try:
    raise SystemExit(subprocess.run(cmd, timeout=timeout).returncode)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
PY
    return "$?"
  fi

  # Fallback without timeout support if Python is unexpectedly unavailable.
  "$@"
}

retry_command() {
  local label="$1"
  local timeout_s="$2"
  local attempts="${3:-$NETWORK_RETRIES}"
  shift 3
  local attempt status delay
  delay=3
  for attempt in $(seq 1 "$attempts"); do
    echo "[deps] ${label}（第 ${attempt}/${attempts} 次，超时 ${timeout_s}s）..."
    if run_with_timeout "$timeout_s" "$@"; then
      return 0
    else
      status="$?"
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      echo "[deps] ${label} 失败/超时（exit=${status}），${delay}s 后重试..." >&2
      sleep "$delay"
      delay=$((delay * 2))
    else
      echo "[deps] ${label} 失败（exit=${status}）。" >&2
      return "$status"
    fi
  done
}

ensure_uv_available() {
  local prefix="${1:-deps}"
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if ! command -v uv >/dev/null 2>&1; then
    if [ "${MUSIC_STUDIO_PACKAGED:-0}" = "1" ] || [ "${DISABLE_UV_AUTO_INSTALL:-0}" = "1" ]; then
      echo "[${prefix}] 错误：未找到 uv，且当前为打包应用/禁用自动安装模式。" >&2
      echo "[${prefix}] 为避免污染用户电脑环境，应用不会自动安装 uv 到 ~/.local 或系统目录。" >&2
      echo "[${prefix}] 请重新打包含完整 runtime，或由用户手动安装 uv 后再启用该功能。" >&2
      return 1
    fi
    echo "[${prefix}] 未发现 uv，正在安装 (https://astral.sh/uv)..."
    if ! retry_command "安装 uv" "$SHORT_NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
      bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'; then
      echo "[${prefix}] uv 官方安装源不可达，请手动安装或配置可访问代理后重试。" >&2
      return 1
    fi
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  fi
  if ! command -v uv >/dev/null 2>&1; then
    echo "[${prefix}] 错误：uv 不可用。请手动安装后重试：https://docs.astral.sh/uv/getting-started/installation/" >&2
    return 1
  fi
  export UV_SYSTEM_CERTS=1
}

retry_uv_venv_python312() {
  local label="$1"
  if retry_command "${label}" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" uv venv --python 3.12 .venv; then
    return 0
  fi
  if [ -n "$UV_PYTHON_INSTALL_MIRROR" ]; then
    echo "[deps] Python 3.12 下载失败，临时使用 UV_PYTHON_INSTALL_MIRROR=$UV_PYTHON_INSTALL_MIRROR 重试..." >&2
    retry_command "${label}（Python 镜像）" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
      env UV_PYTHON_INSTALL_MIRROR="$UV_PYTHON_INSTALL_MIRROR" uv venv --python 3.12 .venv
    return "$?"
  fi
  echo "[deps] Python 3.12 下载失败。可配置 UV_PYTHON_INSTALL_MIRROR 后重试，或先执行：uv python install 3.12" >&2
  return 1
}

retry_torch_install() {
  local py="$1"
  if [ "$(uname -s)" = "Darwin" ]; then
    if retry_command "安装 torch/torchaudio（PyPI 默认源）" "$SHORT_NETWORK_TIMEOUT" "$MIRROR_FALLBACK_ATTEMPTS" \
      uv pip install --python "$py" torch==2.5.1 torchaudio==2.5.1; then
      return 0
    fi
    echo "[deps] PyPI 默认源失败，macOS 临时切换到国内 PyPI 镜像：${PYPI_MIRROR_URL}" >&2
    retry_command "安装 torch/torchaudio（国内 PyPI 镜像）" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
      uv pip install --python "$py" --index-url "$PYPI_MIRROR_URL" torch==2.5.1 torchaudio==2.5.1
    return "$?"
  fi

  if retry_command "安装 torch/torchaudio CPU 依赖（官方源）" "$SHORT_NETWORK_TIMEOUT" 1 \
    uv pip install --python "$py" --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchaudio==2.5.1; then
    return 0
  fi
  echo "[deps] PyTorch 官方源失败，临时切换到国内 PyTorch CPU 镜像：$PYTORCH_CPU_MIRROR_URL" >&2
  retry_command "安装 torch/torchaudio CPU 依赖（国内镜像）" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
    uv pip install --python "$py" --index-url "$PYTORCH_CPU_MIRROR_URL" torch==2.5.1 torchaudio==2.5.1
}

retry_uv_pip_requirements() {
  local py="$1"
  local requirements="$2"
  local label="${3:-安装 Python requirements}"
  if retry_command "${label}（默认源）" "$SHORT_NETWORK_TIMEOUT" "$MIRROR_FALLBACK_ATTEMPTS" \
    uv pip install --python "$py" -r "$requirements"; then
    return 0
  fi
  echo "[deps] PyPI 默认源失败，临时切换到国内 PyPI 镜像：$PYPI_MIRROR_URL" >&2
  retry_command "${label}（国内镜像）" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
    uv pip install --python "$py" --index-url "$PYPI_MIRROR_URL" -r "$requirements"
}

retry_uv_sync_with_mirror() {
  local label="$1"
  shift || true
  if retry_command "${label}（默认源）" "$SHORT_NETWORK_TIMEOUT" "$MIRROR_FALLBACK_ATTEMPTS" uv sync "$@"; then
    return 0
  fi
  echo "[deps] uv sync 默认源失败，临时切换到国内 PyPI 镜像：$PYPI_MIRROR_URL" >&2
  retry_command "${label}（国内镜像）" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
    env UV_DEFAULT_INDEX="$PYPI_MIRROR_URL" uv sync --default-index "$PYPI_MIRROR_URL" "$@"
}

# uv sync 带 marker 缓存：在当前工作目录基于 uv.lock + pyproject.toml 判断是否可跳过。
# 用法：cached_uv_sync <label> [uv sync 额外参数...]；须在目标项目目录下调用。
cached_uv_sync() {
  local label="$1"; shift || true
  local marker=".venv/.uv-sync-ready"
  if deps_marker_fresh "$marker" "uv.lock" "pyproject.toml" "str:$*"; then
    echo "[deps] ${label}：依赖已同步（跳过 uv sync；FORCE_DEP_INSTALL=1 可强制）。"
    return 0
  fi
  retry_uv_sync_with_mirror "$label" "$@" || return "$?"
  deps_marker_write "$marker" "uv.lock" "pyproject.toml" "str:$*"
}

backend_python_path() {
  local backend="$1"
  if [ "$(uname -s 2>/dev/null || echo unknown)" = "MINGW64_NT" ] || [ -x "$backend/.venv/Scripts/python.exe" ]; then
    printf '%s\n' "$backend/.venv/Scripts/python.exe"
  else
    printf '%s\n' "$backend/.venv/bin/python"
  fi
}

python_is_312() {
  local py="$1"
  [ -x "$py" ] || return 1
  "$py" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)' >/dev/null 2>&1
}

ensure_backend_venv() {
  local backend="$1"
  local prefix="${2:-deps}"
  local py
  py="$(backend_python_path "$backend")"

  if [ -d "$backend/.venv" ] && ! python_is_312 "$py"; then
    echo "[${prefix}] 检测到 backend/.venv Python 版本不匹配，自动删除并重建。"
    "$py" --version 2>/dev/null | sed "s/^/[${prefix}] 当前版本: /" || true
    rm -rf "$backend/.venv"
  fi

  if [ ! -d "$backend/.venv" ]; then
    echo "[${prefix}] 创建 Python 3.12 虚拟环境..."
    (cd "$backend" && retry_uv_venv_python312 "创建 backend/.venv")
  fi

  py="$(backend_python_path "$backend")"
  if ! python_is_312 "$py"; then
    echo "[${prefix}] 错误：backend/.venv 仍不是 Python 3.12，请检查 uv Python 下载源或手动运行：uv python install 3.12" >&2
    return 1
  fi

  echo "[${prefix}] 安装/校验后端依赖..."
  local marker="$backend/.venv/.deps-ready"
  # 指纹：requirements-dev.txt 内容 + torch 版本 + 平台。任一变化即触发重装。
  if deps_marker_fresh "$marker" "$backend/requirements-dev.txt" "str:torch==2.5.1" "str:$(uname -s)"; then
    echo "[${prefix}] 后端依赖已是最新（跳过安装；FORCE_DEP_INSTALL=1 可强制重装）。"
    return 0
  fi
  (cd "$backend" && retry_torch_install "$py") || return 1
  (cd "$backend" && retry_uv_pip_requirements "$py" requirements-dev.txt "安装后端 requirements-dev.txt") || return 1
  deps_marker_write "$marker" "$backend/requirements-dev.txt" "str:torch==2.5.1" "str:$(uname -s)"
}

ensure_npm_dependencies() {
  local frontend="$1"
  local prefix="${2:-deps}"
  if [ -d "$frontend/node_modules" ]; then
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "[${prefix}] 错误：未找到 npm，请先安装 Node 22。" >&2
    return 1
  fi
  echo "[${prefix}] 未发现 node_modules，准备安装前端依赖..."
  if (cd "$frontend" && retry_command "npm install（默认 .npmrc/当前源）" "$SHORT_NETWORK_TIMEOUT" "$MIRROR_FALLBACK_ATTEMPTS" npm install); then
    return 0
  fi
  echo "[${prefix}] npm 默认源失败，临时切换到国内镜像：${NPM_MIRROR_REGISTRY}" >&2
  (cd "$frontend" && retry_command "npm install（国内镜像）" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" npm install --registry "$NPM_MIRROR_REGISTRY")
}
