#!/usr/bin/env bash
#
# 一键启动「音乐工作台」全部服务（开发模式）。
#
#   ./start.sh
#
# 启动流程：
#   1. 启动 SVC（:8002），详细输出写入 logs/ 目录
#   2. 启动后端 Redis + FastAPI（:8000）+ Celery worker，终端可见
#   3. 等待后端就绪后，启动前端 Vite dev server（:5173）
#   4. ACE-Step（:8001）不再随 start.sh 预启动；进入「音乐生成」页后按需启动，
#      首次可先在 UI 里设置模型目录，再开始下载/加载模型。
#   Ctrl+C 时同时优雅退出全部进程。
#
# 仅想用「音轨分离」、不启动 SVC 时：
#   SKIP_SVC=1 ./start.sh
# 不需要人声模式时单独跳过 SVC：
#   SKIP_SVC=1 ./start.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
source "$ROOT/scripts/dependency_helpers.sh"
export MUSIC_STUDIO_RUNTIME_MODE="${MUSIC_STUDIO_RUNTIME_MODE:-browser-dev}"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
export no_proxy="${no_proxy:-localhost,127.0.0.1,::1}"
LOGS_DIR="$ROOT/logs"
mkdir -p "$LOGS_DIR"
LOG_ARCHIVE_DIR="$LOGS_DIR/archive"
LOG_RUNS_DIR="$LOGS_DIR/runs"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-7}"

API_PORT="${LOCAL_API_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

# ACE-Step（音乐生成服务）由后端按需调用 scripts/launch_acestep.sh 启动。
export ACESTEP_API_HOST="${ACESTEP_API_HOST:-127.0.0.1}"
export ACESTEP_API_PORT="${ACESTEP_API_PORT:-8001}"

# SVC（歌声转换服务，人声模式用）
SVC_DIR="${SVC_DIR:-$ROOT/svc_service}"
SVC_API_HOST="${SVC_API_HOST:-127.0.0.1}"
SVC_API_PORT="${SVC_API_PORT:-8002}"

# 项目内 FFmpeg 共享库目录；SVC 启动时会复用其中的 libav*（若已存在）。
# vendor 目录支持外移（见 launch_svc 内解析）；此处仅记录是否外部显式指定了 FFMPEG_PREFIX。
VENDOR="$ROOT/vendor"
if [ -n "${FFMPEG_PREFIX:-}" ]; then
  FFMPEG_PREFIX_EXPLICIT=1
fi
FFMPEG_PREFIX="${FFMPEG_PREFIX:-$VENDOR/ffmpeg-env}"

PIDS=()
OPTIONAL_PIDS=()

prepare_logs() {
  # Keep each ./start.sh run readable: this run gets its own timestamped
  # directory. Old root-level logs from previous versions are archived once.
  mkdir -p "$LOG_RUNS_DIR"
  local ts
  ts="$(date +%Y%m%d_%H%M%S)"
  for name in acestep svc; do
    local src="$LOGS_DIR/${name}.log"
    if [ -s "$src" ]; then
      mkdir -p "$LOG_ARCHIVE_DIR"
      mv "$src" "$LOG_ARCHIVE_DIR/${ts}-${name}.log"
      echo "[start] 已归档旧日志: $LOG_ARCHIVE_DIR/${ts}-${name}.log"
    else
      rm -f "$src"
    fi
  done
  export APP_RUN_LOG_DIR="$LOG_RUNS_DIR/$ts"
  mkdir -p "$APP_RUN_LOG_DIR"
  for name in launcher api worker acestep svc; do
    : > "$APP_RUN_LOG_DIR/${name}.log"
  done
  echo "[start] 本次运行日志目录: $APP_RUN_LOG_DIR"
  find "$LOG_ARCHIVE_DIR" "$LOG_RUNS_DIR" -type f -name "*.log" -mtime +"$LOG_RETENTION_DAYS" -delete 2>/dev/null || true
  find "$LOG_RUNS_DIR" -type d -empty -mtime +"$LOG_RETENTION_DAYS" -delete 2>/dev/null || true
}

prepare_logs

cleanup() {
  echo ""
  echo "[start] 正在停止全部服务..."
  for pid in "${OPTIONAL_PIDS[@]:-}"; do
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill -INT "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${PIDS[@]:-}"; do
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill -INT "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${OPTIONAL_PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && wait "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && wait "$pid" 2>/dev/null || true
  done
  echo "[start] 已退出。"
}
trap cleanup INT TERM EXIT

# 依赖用 uv 管理（更快）。缺失时用官方安装脚本自动安装。
ensure_uv() {
  ensure_uv_available "start"
}

ensure_uv

# ACE-Step 改为由后端按需调用 scripts/launch_acestep.sh 启动，start.sh 不再内联维护启动逻辑。

# 从当前运行模式对应的 settings.json 读取一个键（未配置/无文件则返回空）。
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

# ---------- SVC（歌声转换服务，人声模式，后台启动） ----------
launch_svc() {
  cd "$SVC_DIR" || { echo "[svc] 找不到 $SVC_DIR" >&2; return 1; }
  unset VIRTUAL_ENV PYTHONHOME PYTHONPATH MUSIC_STUDIO_PYTHON
  export UV_PROJECT_ENVIRONMENT="$SVC_DIR/.venv"

  # 音源模型存放目录（来自前端「设置」），传给 sidecar 作 SVC_MODELS_DIR。
  local md
  md="$(read_setting svc_models_dir)"
  if [ -z "$md" ]; then
    local workspace
    workspace="$(read_setting workspace_dir)"
    if [ -n "$workspace" ]; then
      md="${workspace%/}/svc/models"
    fi
  fi
  if [ -n "$md" ]; then
    export SVC_MODELS_DIR="$md"
  else
    echo "[svc] 未配置 SVC 音源目录。请先在应用设置中选择目录；不会使用默认目录启动 SVC。" >&2
    return 1
  fi
  mkdir -p "$SVC_MODELS_DIR" 2>/dev/null || true
  if [ -z "${SVC_WORK_DIR:-}" ]; then
    local workspace_for_work
    workspace_for_work="$(read_setting workspace_dir)"
    if [ -n "$workspace_for_work" ]; then
      export SVC_WORK_DIR="${workspace_for_work%/}/svc/work"
    else
      export SVC_WORK_DIR="$SVC_MODELS_DIR/.work"
    fi
  fi
  mkdir -p "$SVC_WORK_DIR" 2>/dev/null || true
  echo "[svc] 音源目录: $SVC_MODELS_DIR"
  echo "[svc] 工作目录: $SVC_WORK_DIR"

  # 大文件权重目录（content-vec/HuBERT/底模）。未配置则默认 SVC_MODELS_DIR 同级 pretrained，
  # 首次启动缺失会自动下载（走 HF 镜像）。用户可在设置里指定 svc_pretrained_dir 到大盘。
  if [ -z "${SVC_PRETRAINED_DIR:-}" ]; then
    local pd
    pd="$(read_setting svc_pretrained_dir)"
    [ -n "$pd" ] && export SVC_PRETRAINED_DIR="$pd"
  fi
  [ -n "${SVC_PRETRAINED_DIR:-}" ] && echo "[svc] 权重目录: $SVC_PRETRAINED_DIR"

  echo "[svc] 安装依赖 (uv sync，首次较慢，会下载 torch 等；后续命中缓存跳过)..."
  if ! cached_uv_sync "SVC uv sync"; then
    echo "[svc] uv sync 失败，尝试使用系统证书重试 (--system-certs)..." >&2
    if ! cached_uv_sync "SVC uv sync --system-certs" --system-certs; then
      echo "[svc] SVC 依赖安装失败；人声模式将不可用。" >&2
      echo "[svc] 若日志包含证书错误（例如 UnknownIssuer），请手动执行：" >&2
      echo "[svc]   cd \"$SVC_DIR\" && uv sync --system-certs" >&2
      return 1
    fi
  fi

  # 复用项目内 FFmpeg 共享库（so-vits/torchaudio 解码需要）。
  # 解析可配置的 vendor 目录（VENDOR_DIR > settings.vendor_dir > workspace/vendor > 项目内），
  # 与 launch_acestep.sh 保持一致，使 SVC 能找到 ACE-Step 安装的 ffmpeg 库。
  if [ -z "${FFMPEG_PREFIX_EXPLICIT:-}" ]; then
    local svc_vendor svc_vd svc_ws
    if [ -n "${VENDOR_DIR:-}" ]; then
      svc_vendor="$VENDOR_DIR"
    else
      svc_vd="$(read_setting vendor_dir)"
      svc_ws="$(read_setting workspace_dir)"
      if [ -n "$svc_vd" ]; then
        svc_vendor="$svc_vd"
      elif [ -n "$svc_ws" ]; then
        svc_vendor="${svc_ws%/}/vendor"
      else
        svc_vendor="$VENDOR"
      fi
    fi
    FFMPEG_PREFIX="$svc_vendor/ffmpeg-env"
  fi
  if ls "$FFMPEG_PREFIX"/lib/libavutil* >/dev/null 2>&1; then
    case "$(uname -s)" in
      Darwin) export DYLD_FALLBACK_LIBRARY_PATH="$FFMPEG_PREFIX/lib:${DYLD_FALLBACK_LIBRARY_PATH:-$HOME/lib:/usr/local/lib:/usr/lib}" ;;
      Linux)  export LD_LIBRARY_PATH="$FFMPEG_PREFIX/lib:${LD_LIBRARY_PATH:-}" ;;
    esac
    export PATH="$FFMPEG_PREFIX/bin:$PATH"
  fi

  echo "[svc] 启动 SVC REST API: http://${SVC_API_HOST}:${SVC_API_PORT}"
  exec uv run uvicorn app.main:app --host "$SVC_API_HOST" --port "$SVC_API_PORT"
}

# ============================================================================
# 第一阶段：启动常驻 sidecar 服务（SVC），输出重定向到日志文件
# ACE-Step 改为从音乐生成页按需启动，避免首次启动前无法设置模型目录。
# ============================================================================
echo "[start] 音乐生成服务 (ACE-Step) 将在打开「音乐生成」页后按需启动。"

if [ "${SKIP_SVC:-0}" = "1" ]; then
  echo "[start] SKIP_SVC=1，跳过歌声转换服务。"
else
  echo "[start] 正在启动歌声转换服务 (SVC) ..."
  (launch_svc) > "${APP_RUN_LOG_DIR:-$LOGS_DIR}/svc.log" 2>&1 &
  OPTIONAL_PIDS+=("$!")
fi

# ============================================================================
# 第二阶段：后端（Redis + FastAPI + Celery worker）——终端输出可见
# ============================================================================
echo "[start] 正在启动后端..."
cd "$BACKEND"

# 项目锁定 Python 3.12；版本不一致会自动重建 backend/.venv。
ensure_backend_venv "$BACKEND" "start"
BACKEND_PYTHON="$(backend_python_path "$BACKEND")"

# 确保 static-ffmpeg 的二进制就位。
ensure_ffmpeg() {
  local info dir url zip
  info="$("$BACKEND_PYTHON" - <<'PY'
try:
    from static_ffmpeg import run
    print(run.get_platform_dir())
    print(run.get_platform_http_zip())
except Exception:
    pass
PY
)"
  dir="$(printf '%s\n' "$info" | sed -n '1p')"
  url="$(printf '%s\n' "$info" | sed -n '2p')"
  [ -z "$dir" ] && return 0
  if [ -x "$dir/ffmpeg" ] && [ -x "$dir/ffprobe" ]; then
    return 0
  fi
  echo "[start] 未发现 ffmpeg 二进制，正在用 curl 下载 static-ffmpeg..."
  mkdir -p "$dir"
  zip="$dir.zip"
  if retry_command "下载 static-ffmpeg" "$SHORT_NETWORK_TIMEOUT" "$NETWORK_RETRIES" \
    curl -fL --retry 3 -o "$zip" "$url"; then
    unzip -o "$zip" -d "$(dirname "$dir")" >/dev/null && rm -f "$zip"
    chmod +x "$dir/ffmpeg" "$dir/ffprobe" 2>/dev/null || true
    echo "installed via start.sh $(date)" > "$dir/installed.crumb"
    echo "[start] ffmpeg 就绪：$dir/ffmpeg"
  else
    echo "[start] 警告：ffmpeg 下载失败。若分轨报 'No such file or directory: ffmpeg'，请手动安装 ffmpeg 或设置 APP_FFMPEG_EXE/APP_FFPROBE_EXE。" >&2
  fi
}
ensure_ffmpeg

# 解析 MIDI 合成用的 SoundFont（旋律生成/MIDI 轨导出需要）。
# 优先级：APP_SOUNDFONT 环境变量 > settings.soundfont_path > <workspace>/soundfont/*.sf2|*.sf3 > backend/assets。
ensure_soundfont() {
  if [ -n "${APP_SOUNDFONT:-}" ] && [ -f "${APP_SOUNDFONT}" ]; then
    echo "[start] SoundFont: $APP_SOUNDFONT"
    return 0
  fi
  local sp ws cand
  sp="$(read_setting soundfont_path)"
  if [ -n "$sp" ] && [ -f "$sp" ]; then
    export APP_SOUNDFONT="$sp"
    echo "[start] SoundFont: $APP_SOUNDFONT"
    return 0
  fi
  ws="$(read_setting workspace_dir)"
  if [ -n "$ws" ]; then
    cand="$(ls "${ws%/}/soundfont/"*.sf2 "${ws%/}/soundfont/"*.sf3 2>/dev/null | head -1)"
    if [ -n "$cand" ]; then
      export APP_SOUNDFONT="$cand"
      echo "[start] SoundFont: $APP_SOUNDFONT"
      return 0
    fi
  fi
  echo "[start] 提示：未找到 SoundFont（.sf2/.sf3）。旋律生成/MIDI 导出需要它；可在设置 soundfont_path 或放到 <workspace>/soundfont/。" >&2
}
ensure_soundfont

echo "[start] 启动后端 (redis + api + worker)..."
"$BACKEND_PYTHON" run_local.py &
PIDS+=("$!")

# ============================================================================
# 第三阶段：前端（Vite dev server）——与后端启动并行，不必等后端就绪。
# Vite 只在浏览器发请求时才代理到后端，提前启动可与后端 boot 重叠，缩短总耗时。
# ============================================================================
echo "[start] 正在启动前端 (与后端并行)..."
(
  cd "$FRONTEND"
  ensure_npm_dependencies "$FRONTEND" "start"
  npm run dev -- --port "$FRONTEND_PORT"
) &
PIDS+=("$!")

# ============================================================================
# 等待后端就绪（仅用于日志提示；前端已在后台启动，不被阻塞）
# ============================================================================
echo "[start] 等待后端就绪..."
BACKEND_READY=0
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:${API_PORT}/docs" > /dev/null 2>&1; then
    BACKEND_READY=1
    echo "[start] 后端就绪"
    break
  fi
  sleep 0.5
done
if [ "$BACKEND_READY" = "0" ]; then
  echo "[start] 警告：后端未在预期时间内就绪，请检查日志。"
fi

# ============================================================================
# 启动完成 — 输出地址汇总
# ============================================================================
echo ""
echo "============================================================"
echo "  服务已启动"
echo "============================================================"
echo "  前端界面  : http://localhost:${FRONTEND_PORT}"
echo "  后端 API  : http://localhost:${API_PORT}"
if [ "${SKIP_ACESTEP:-0}" != "1" ]; then
  echo "  音乐生成  : 按需启动（打开前端「音乐生成」页后启动 ${ACESTEP_API_HOST}:${ACESTEP_API_PORT}）"
fi
if [ "${SKIP_SVC:-0}" != "1" ]; then
  echo "  SVC 音源  : http://${SVC_API_HOST}:${SVC_API_PORT}"
fi
echo "------------------------------------------------------------"
echo "  日志目录  : ${APP_RUN_LOG_DIR}"
echo "  查看 ACE-Step 日志 : tail -f ${APP_RUN_LOG_DIR}/acestep.log（打开音乐生成页后才会产生）"
echo "  查看 SVC 日志     : tail -f ${APP_RUN_LOG_DIR}/svc.log"
echo "------------------------------------------------------------"
echo "  按 Ctrl+C 停止全部服务"
echo "============================================================"
echo ""

# 等待任一子进程退出
wait -n 2>/dev/null || wait
