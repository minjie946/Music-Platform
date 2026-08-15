#!/usr/bin/env bash
#
# Launch ACE-Step REST sidecar on demand.
# This script is used by the backend when the user opens the generation tab.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
VENDOR="$ROOT/vendor"
source "$ROOT/scripts/dependency_helpers.sh"
# 记录 FFMPEG_PREFIX 是否由外部显式指定；未指定则随 VENDOR 解析。
if [ -n "${FFMPEG_PREFIX:-}" ]; then
  FFMPEG_PREFIX_EXPLICIT=1
fi
FFMPEG_PREFIX="${FFMPEG_PREFIX:-$VENDOR/ffmpeg-env}"
MICROMAMBA_BIN="$VENDOR/micromamba"
MICROMAMBA_ROOT="$VENDOR/micromamba-root"

ACESTEP_DIR="${ACESTEP_DIR:-$ROOT/external/ACE-Step-1.5}"
# 记录 ACESTEP_SOURCE_ZIP 是否由外部显式指定；未指定则稍后按 resources_dir/workspace 解析。
if [ -n "${ACESTEP_SOURCE_ZIP:-}" ]; then
  ACESTEP_SOURCE_ZIP_EXPLICIT=1
fi
ACESTEP_SOURCE_ZIP="${ACESTEP_SOURCE_ZIP:-$ROOT/resources/ACE-Step-1.5-main.zip}"
export ACESTEP_API_HOST="${ACESTEP_API_HOST:-127.0.0.1}"
export ACESTEP_API_PORT="${ACESTEP_API_PORT:-8001}"

ensure_uv() {
  ensure_uv_available "acestep"
}

ensure_acestep_source() {
  if [ ! -f "$ACESTEP_SOURCE_ZIP" ]; then
    echo "[acestep] 未找到本地 ACE-Step 源码包: $ACESTEP_SOURCE_ZIP" >&2
    echo "[acestep] 开发和打包都不会再从 GitHub clone，请先放置 resources/ACE-Step-1.5-main.zip。" >&2
    return 1
  fi
  python3 - "$ACESTEP_SOURCE_ZIP" "$ACESTEP_DIR" <<'PY'
import hashlib
import shutil
import sys
from pathlib import Path
from zipfile import ZipFile

archive = Path(sys.argv[1]).expanduser().resolve()
target = Path(sys.argv[2]).expanduser().resolve()
marker = target / ".source-zip-ready"
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
marker_text = f"archive={archive.name}\nsha256={digest}\n"
if target.is_dir() and marker.is_file() and marker.read_text("utf-8") == marker_text:
    print(f"[acestep] 本地源码已就绪: {target}")
    raise SystemExit(0)

print(f"[acestep] 解压本地 ACE-Step 源码包: {archive} -> {target}")
shutil.rmtree(target, ignore_errors=True)
target.parent.mkdir(parents=True, exist_ok=True)
tmp = target.parent / f".{target.name}.extracting"
shutil.rmtree(tmp, ignore_errors=True)
tmp.mkdir(parents=True, exist_ok=True)
with ZipFile(archive) as zf:
    zf.extractall(tmp)

entries = [p for p in tmp.iterdir() if p.name != "__MACOSX"]
if len(entries) == 1 and entries[0].is_dir():
    shutil.move(str(entries[0]), str(target))
    shutil.rmtree(tmp, ignore_errors=True)
else:
    shutil.move(str(tmp), str(target))

if not (target / "pyproject.toml").is_file():
    raise SystemExit(f"[acestep] 解压后的源码缺少 pyproject.toml: {target}")
marker.write_text(marker_text, "utf-8")
PY
}

runtime_mode() {
  if [ -n "${MUSIC_STUDIO_RUNTIME_MODE:-}" ]; then
    printf '%s\n' "$MUSIC_STUDIO_RUNTIME_MODE"
  elif [ "${MUSIC_STUDIO_PACKAGED:-0}" = "1" ]; then
    printf '%s\n' "packaged"
  elif [ -n "${APP_DATA_DIR:-}" ]; then
    printf '%s\n' "desktop-dev"
  else
    printf '%s\n' "browser-dev"
  fi
}

settings_json_path() {
  case "$(runtime_mode)" in
    packaged|desktop-dev)
      if [ -n "${APP_DATA_DIR:-}" ]; then
        printf '%s\n' "${APP_DATA_DIR%/}/settings.json"
      else
        printf '%s\n' ""
      fi
      ;;
    browser-dev)
      printf '%s\n' "$BACKEND/data/settings.json"
      ;;
    *)
      printf '%s\n' "${APP_DATA_DIR:-$BACKEND/data}/settings.json"
      ;;
  esac
}

read_setting() {
  local settings_json
  settings_json="$(settings_json_path)"
  [ -n "$settings_json" ] || return 0
  [ -f "$settings_json" ] || return 0
  python3 - "$settings_json" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    print((d.get(sys.argv[2]) or "").strip())
except Exception:
    print("")
PY
}

ensure_ffmpeg_libs() {
  if ls "$FFMPEG_PREFIX"/lib/libavutil* >/dev/null 2>&1; then
    return 0
  fi
  echo "[acestep] 准备项目内 FFmpeg 共享库（首次：下载 micromamba + conda-forge ffmpeg，约几十 MB）..."
  local uname_s uname_m mm_platform
  uname_s="$(uname -s)"; uname_m="$(uname -m)"
  case "$uname_s/$uname_m" in
    Darwin/arm64)   mm_platform="osx-arm64" ;;
    Darwin/x86_64)  mm_platform="osx-64" ;;
    Linux/x86_64)   mm_platform="linux-64" ;;
    Linux/aarch64)  mm_platform="linux-aarch64" ;;
    *) echo "[acestep] 未识别平台 $uname_s/$uname_m，跳过 FFmpeg 安装（可改用 WAV/FLAC 生成）" >&2; return 1 ;;
  esac
  mkdir -p "$VENDOR"
  if [ ! -x "$MICROMAMBA_BIN" ]; then
    echo "[acestep] 下载 micromamba ($mm_platform)..."
    retry_command "下载 micromamba" "$SHORT_NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
      bash -c 'curl -Ls "$1" | tar -xj -C "$2" --strip-components=1 bin/micromamba 2>/dev/null' \
      _ "https://micro.mamba.pm/api/micromamba/$mm_platform/latest" "$VENDOR" \
      || { echo "[acestep] 下载 micromamba 失败" >&2; return 1; }
    chmod +x "$MICROMAMBA_BIN" 2>/dev/null || true
  fi
  local lock_dir="$VENDOR/ffmpeg-install.lockdir"
  local wait_deadline=$((SECONDS + 600))
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if ls "$FFMPEG_PREFIX"/lib/libavutil* >/dev/null 2>&1; then
      return 0
    fi
    if [ "$SECONDS" -ge "$wait_deadline" ]; then
      echo "[acestep] 等待其他进程安装 FFmpeg 超时" >&2
      return 1
    fi
    echo "[acestep] 另一个进程正在安装 FFmpeg，等待中..."
    sleep 2
  done
  cleanup_ffmpeg_lock() {
    rmdir "$lock_dir" >/dev/null 2>&1 || true
  }
  trap cleanup_ffmpeg_lock RETURN
  if ls "$FFMPEG_PREFIX"/lib/libavutil* >/dev/null 2>&1; then
    return 0
  fi
  echo "[acestep] 安装 conda-forge ffmpeg 到 $FFMPEG_PREFIX ..."
  MAMBA_ROOT_PREFIX="$MICROMAMBA_ROOT" \
  CONDA_PKGS_DIRS="$MICROMAMBA_ROOT/pkgs" \
  XDG_CACHE_HOME="$VENDOR/cache" \
    retry_command "安装 conda-forge ffmpeg" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
      "$MICROMAMBA_BIN" create -y -q -p "$FFMPEG_PREFIX" -c conda-forge ffmpeg \
      || { echo "[acestep] 安装 ffmpeg 失败" >&2; return 1; }
  ls "$FFMPEG_PREFIX"/lib/libavutil* >/dev/null 2>&1 || {
    echo "[acestep] 安装 ffmpeg 后仍未找到共享库" >&2
    return 1
  }
  return 0
}

# 解析可配置的 vendor / resources 目录（settings > workspace 子目录 > 项目内）。
# 需在 read_setting 定义之后、首次使用 VENDOR/ACESTEP_SOURCE_ZIP 之前执行。
resolve_configurable_dirs() {
  local ws vd rd
  ws="$(read_setting workspace_dir)"

  # vendor：显式设置 VENDOR_DIR > settings.vendor_dir > workspace/vendor > 项目内
  if [ -n "${VENDOR_DIR:-}" ]; then
    VENDOR="$VENDOR_DIR"
  else
    vd="$(read_setting vendor_dir)"
    if [ -n "$vd" ]; then
      VENDOR="$vd"
    elif [ -n "$ws" ]; then
      VENDOR="${ws%/}/vendor"
    fi
  fi
  # 依赖 VENDOR 的派生路径需同步刷新（FFMPEG_PREFIX 若已由外部显式指定则尊重之）。
  if [ -z "${FFMPEG_PREFIX_EXPLICIT:-}" ]; then
    FFMPEG_PREFIX="$VENDOR/ffmpeg-env"
  fi
  MICROMAMBA_BIN="$VENDOR/micromamba"
  MICROMAMBA_ROOT="$VENDOR/micromamba-root"
  echo "[acestep] vendor 目录: $VENDOR"

  # resources：ACESTEP_SOURCE_ZIP 若已显式指定则尊重之，否则按 resources_dir 解析。
  if [ -z "${ACESTEP_SOURCE_ZIP_EXPLICIT:-}" ]; then
    rd="$(read_setting resources_dir)"
    if [ -n "$rd" ]; then
      ACESTEP_SOURCE_ZIP="${rd%/}/ACE-Step-1.5-main.zip"
    elif [ -n "$ws" ]; then
      ACESTEP_SOURCE_ZIP="${ws%/}/resources/ACE-Step-1.5-main.zip"
    fi
  fi
  echo "[acestep] ACE-Step 源码包: $ACESTEP_SOURCE_ZIP"
}
resolve_configurable_dirs

ensure_uv

# ACE-Step has its own uv project environment. Clear inherited Python env vars so
# backend/.venv or SVC settings never affect ACE-Step dependency resolution.
unset VIRTUAL_ENV PYTHONHOME PYTHONPATH MUSIC_STUDIO_PYTHON
export UV_PROJECT_ENVIRONMENT="$ACESTEP_DIR/.venv"

ensure_acestep_source

cd "$ACESTEP_DIR"

# Patch ACE-Step 1.5 local source so its API initialization honors
# ACESTEP_CHECKPOINTS_DIR for LM loading. Upstream service_init.py derives
# "<repo>/checkpoints" for the LM path, which duplicates downloads.
# 补丁幂等，但每次都启动一次解释器扫描文件。源码仅在 zip 重新解压时变化，
# 故用 marker 绑定 .source-zip-ready，未变则跳过本次 patch 扫描。
_patch_marker="$ACESTEP_DIR/.patched-ready"
if deps_marker_fresh "$_patch_marker" "$ACESTEP_DIR/.source-zip-ready" "str:patch-v1"; then
  echo "[acestep] 源码补丁已应用（跳过）。"
else
uv run python - <<'PY' || true
from pathlib import Path

patches = [
    (
        Path("acestep/ui/gradio/events/generation/service_init.py"),
        '        checkpoint_dir = os.path.join(project_root, "checkpoints")\n\n        lm_status, lm_success = llm_handler.initialize(',
        '        from acestep.model_downloader import get_checkpoints_dir\n\n        checkpoint_dir = str(get_checkpoints_dir())\n\n        lm_status, lm_success = llm_handler.initialize(',
    ),
    (
        Path("acestep/api/startup_model_init.py"),
        '    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
    (
        Path("acestep/api/runtime_helpers.py"),
        '        project_root = get_project_root()\n        checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '        from acestep.model_downloader import get_checkpoints_dir\n\n        checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
    (
        Path("acestep/api/http/model_init_service.py"),
        '    project_root = get_project_root()\n    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
    (
        Path("acestep/api/http/model_init_service.py"),
        '    llm = app_state.llm_handler\n    from acestep.model_downloader import get_checkpoints_dir\n',
        '    llm = app_state.llm_handler\n    project_root = get_project_root()\n    from acestep.model_downloader import get_checkpoints_dir\n',
    ),
    (
        Path("acestep/api/http/reinitialize_route.py"),
        '                    project_root = get_project_root()\n                    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '                    from acestep.model_downloader import get_checkpoints_dir\n\n                    checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
    (
        Path("acestep/api/http/model_service_routes.py"),
        '    project_root = get_project_root()\n    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
    (
        Path("acestep/api/llm_readiness.py"),
        '        project_root = get_project_root()\n        checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '        from acestep.model_downloader import get_checkpoints_dir\n\n        checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
    (
        Path("acestep/api/http/sample_format_routes.py"),
        '                project_root = get_project_root()\n                checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '                from acestep.model_downloader import get_checkpoints_dir\n\n                checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
    (
        Path("acestep/acestep_v15_pipeline.py"),
        '                if args.init_llm and args.lm_model_path:\n                    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '                if args.init_llm and args.lm_model_path:\n                    from acestep.model_downloader import get_checkpoints_dir\n\n                    checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
    (
        Path("acestep/core/generation/handler/init_service_orchestrator.py"),
        '            elif project_root:\n                checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
        '            elif project_root:\n                checkpoint_dir = str(get_checkpoints_dir())\n',
    ),
]

changed = []
for path, old, new in patches:
    if not path.is_file():
        continue
    src = path.read_text("utf-8")
    if old in src:
        path.write_text(src.replace(old, new), "utf-8")
        changed.append(str(path))

if changed:
    print("[acestep] 已修补 checkpoints 目录解析，使用 ACESTEP_CHECKPOINTS_DIR:")
    for item in changed:
        print(f"[acestep]   - {item}")
PY
  deps_marker_write "$_patch_marker" "$ACESTEP_DIR/.source-zip-ready" "str:patch-v1"
fi

# Read paths saved by the UI immediately before starting the sidecar.
settings_json="$(settings_json_path)"
echo "[acestep] 运行模式: $(runtime_mode)"
echo "[acestep] 设置文件: ${settings_json:-<未设置>}"
workspace="$(read_setting workspace_dir)"
ckpt="$(read_setting acestep_checkpoints_dir)"
if [ -z "$ckpt" ] && [ -n "$workspace" ]; then
  ckpt="${workspace%/}/ace/models"
fi
if [ -n "$ckpt" ]; then
  export ACESTEP_CHECKPOINTS_DIR="$ckpt"
  echo "[acestep] 模型存放目录（来自设置）: $ACESTEP_CHECKPOINTS_DIR"
else
  echo "[acestep] 未配置模型存放目录。请先在应用设置中选择目录；不会使用默认 checkpoints 启动。" >&2
  exit 1
fi

tmpd="$(read_setting acestep_tmp_dir)"
if [ -z "$tmpd" ] && [ -n "$workspace" ]; then
  tmpd="${workspace%/}/ace/generation/tmp"
fi
if [ -n "$tmpd" ]; then
  export ACESTEP_TMPDIR="$tmpd"
  echo "[acestep] 临时目录（来自设置）: $ACESTEP_TMPDIR"
else
  echo "[acestep] 未配置临时缓存目录。请先在应用设置中选择目录；不会使用默认临时目录启动。" >&2
  exit 1
fi

echo "[acestep] 安装依赖 (uv sync，首次很慢，会下载数 GB；后续命中缓存跳过)..."
if [ "$(uname -s)" = "Darwin" ] && grep -q "flash-attn.*win32\|flash-attn.*linux" uv.lock 2>/dev/null; then
  echo "[acestep] 检测到非当前平台的 flash-attn 锁定，重新生成 uv.lock ..."
  rm uv.lock
fi
# uv sync + modelscope 补装合并到同一 marker：依赖未变则整体跳过，省去每次的解析与探测。
_ace_sync_marker=".venv/.uv-sync-ready"
if deps_marker_fresh "$_ace_sync_marker" "uv.lock" "pyproject.toml" "str:+modelscope"; then
  echo "[acestep] 依赖已同步（跳过 uv sync 与 modelscope 探测；FORCE_DEP_INSTALL=1 可强制）。"
else
  retry_uv_sync_with_mirror "ACE-Step uv sync" || { echo "[acestep] uv sync 失败" >&2; exit 1; }
  if ! uv run python -c "import modelscope" >/dev/null 2>&1; then
    echo "[acestep] 补充安装 modelscope（ACE-Step 模型初始化依赖）..."
    retry_command "安装 modelscope（默认源）" "$SHORT_NETWORK_TIMEOUT" "$MIRROR_FALLBACK_ATTEMPTS" \
      uv pip install modelscope \
      || retry_command "安装 modelscope（国内镜像）" "$NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
        uv pip install --index-url "$PYPI_MIRROR_URL" modelscope \
      || { echo "[acestep] modelscope 安装失败" >&2; exit 1; }
  fi
  deps_marker_write "$_ace_sync_marker" "uv.lock" "pyproject.toml" "str:+modelscope"
fi

echo "[acestep] 检测硬件并选择配置..."
PERFORMANCE_MODE="$(read_setting generation_performance_mode)"
export APP_GENERATION_PERFORMANCE_MODE="${APP_GENERATION_PERFORMANCE_MODE:-${PERFORMANCE_MODE:-conservative}}"
echo "[acestep] 性能模式: $APP_GENERATION_PERFORMANCE_MODE"
# 硬件探测需启动一次 python+torch，较慢。结果按 性能模式+依赖指纹 缓存，
# 命中则直接复用，避免每次进生成页都 import torch 探测。
_detect_cache="$ACESTEP_DIR/.venv/.detect-$APP_GENERATION_PERFORMANCE_MODE.env"
_detect_key="$ACESTEP_DIR/.venv/.detect-$APP_GENERATION_PERFORMANCE_MODE.key"
if [ "${FORCE_DEP_INSTALL:-0}" != "1" ] && deps_marker_fresh "$_detect_key" "$ACESTEP_DIR/.venv/.uv-sync-ready" "str:$APP_GENERATION_PERFORMANCE_MODE" && [ -f "$_detect_cache" ]; then
  detect="$(cat "$_detect_cache")"
  echo "[acestep] 复用已缓存的硬件配置。"
else
detect="$(uv run python - <<'PY'
import os
dit = "acestep-v15-turbo"; lm = ""; backend = "pt"; init_llm = "false"
offload = "false"; device = "auto"
mode = os.environ.get("APP_GENERATION_PERFORMANCE_MODE", "conservative")
try:
    import torch
    if torch.cuda.is_available():
        device = "cuda"
        vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        if vram <= 6:
            lm=""; backend="pt"; init_llm="false"; offload="true"
        elif vram <= 8:
            lm="acestep-5Hz-lm-0.6B"; backend="pt"; init_llm="true"; offload="true"
        elif vram <= 16:
            lm="acestep-5Hz-lm-1.7B"; backend="vllm"; init_llm="true"; offload="false"
        elif vram <= 24:
            dit="acestep-v15-xl-turbo"; lm="acestep-5Hz-lm-1.7B"; backend="vllm"
            init_llm="true"; offload="true" if vram < 20 else "false"
        else:
            dit="acestep-v15-xl-sft"; lm="acestep-5Hz-lm-4B"; backend="vllm"
            init_llm="true"; offload="false"
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device = "mps"; backend = "pt"
        try:
            import psutil; ram = psutil.virtual_memory().total/(1024**3)
        except Exception:
            ram = 16
        if mode == "quality":
            lm = "acestep-5Hz-lm-1.7B" if ram >= 32 else "acestep-5Hz-lm-0.6B"
            init_llm="true"
        elif mode == "standard" and ram >= 24:
            lm="acestep-5Hz-lm-0.6B"; init_llm="true"
        offload = "true"
    else:
        device = "cpu"; lm=""; init_llm="false"; offload="true"
except Exception:
    device = "cpu"
print(f"export ACESTEP_CONFIG_PATH={dit}")
print(f"export ACESTEP_DEVICE={device}")
print(f"export ACESTEP_OFFLOAD_TO_CPU={offload}")
print(f"export ACESTEP_INIT_LLM={init_llm}")
if lm:
    print(f"export ACESTEP_LM_MODEL_PATH={lm}")
    print(f"export ACESTEP_LM_BACKEND={backend}")
PY
)"
  # 仅在探测成功（非空）时写缓存，避免缓存到失败结果。
  if [ -n "$detect" ]; then
    printf '%s' "$detect" > "$_detect_cache" 2>/dev/null || true
    deps_marker_write "$_detect_key" "$ACESTEP_DIR/.venv/.uv-sync-ready" "str:$APP_GENERATION_PERFORMANCE_MODE"
  fi
fi
echo "$detect"
eval "$detect"

# ACE-Step respects ACESTEP_CHECKPOINTS_DIR for the main unified repo, but a
# relative LM model name may still be resolved against the repo's default
# checkpoints folder. Use an absolute LM path when a checkpoints dir is known.
if [ -n "${ACESTEP_CHECKPOINTS_DIR:-}" ] && [ -n "${ACESTEP_LM_MODEL_PATH:-}" ]; then
  case "$ACESTEP_LM_MODEL_PATH" in
    /*) ;;
    *) export ACESTEP_LM_MODEL_PATH="${ACESTEP_CHECKPOINTS_DIR%/}/$ACESTEP_LM_MODEL_PATH" ;;
  esac
fi

ensure_ffmpeg_libs || {
  echo "[acestep] 错误：未能准备项目内 FFmpeg，无法继续启动 ACE-Step。请检查网络或本地 vendor 目录权限。" >&2
  exit 1
}
if ls "$FFMPEG_PREFIX"/lib/libavutil* >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin) export DYLD_FALLBACK_LIBRARY_PATH="$FFMPEG_PREFIX/lib:${DYLD_FALLBACK_LIBRARY_PATH:-$HOME/lib:/usr/local/lib:/usr/lib}" ;;
    Linux)  export LD_LIBRARY_PATH="$FFMPEG_PREFIX/lib:${LD_LIBRARY_PATH:-}" ;;
  esac
  export PATH="$FFMPEG_PREFIX/bin:$PATH"
  echo "[acestep] FFmpeg 共享库: $FFMPEG_PREFIX/lib"
fi

echo "[acestep] 使用配置：设备=${ACESTEP_DEVICE:-auto} DiT=${ACESTEP_CONFIG_PATH:-acestep-v15-turbo}" \
     "LM=${ACESTEP_LM_MODEL_PATH:-（不加载）} offload=${ACESTEP_OFFLOAD_TO_CPU:-false}" \
     "模型目录=${ACESTEP_CHECKPOINTS_DIR:-<未配置>}" \
     "临时目录=${ACESTEP_TMPDIR:-<未配置>}"
echo "[acestep] 启动 REST API: http://${ACESTEP_API_HOST}:${ACESTEP_API_PORT}"
exec uv run acestep-api
