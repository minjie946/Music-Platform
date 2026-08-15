"""On-demand launcher for the ACE-Step sidecar.

The development launcher starts the UI/backend first. When the user opens the
generation tab, the backend can start ACE-Step after the user has saved model
paths in runtime settings.
"""
from __future__ import annotations

import atexit
import os
import shutil
import sys
import subprocess
import threading
import time
from pathlib import Path

from . import acestep_client as ace
from .models import GenerationParams

_lock = threading.Lock()
_proc: subprocess.Popen | None = None


def build_acestep_request(
    params: GenerationParams,
    *,
    model: str,
    batch: int,
    duration: float | None,
    audio_format: str,
    task: str,
    lm_enabled: bool,
) -> dict:
    """Assemble the ACE-Step /release_task payload from validated params.

    Pure: all hardware clamping, model resolution and readiness checks are done
    by the caller; this only maps fields and applies model-shape gating (turbo
    ignores base-DiT knobs; LM sampling/CoT is dropped when no LM is loaded).
    """
    is_base = "turbo" not in (model or "").lower()
    has_ref = bool(params.reference_audio_token)

    # Pure instrumental: ACE-Step treats "[Instrumental]" lyrics (language
    # "unknown") as no-vocals, matching its own UI toggle.
    instrumental = bool(params.instrumental)
    lyrics = "[Instrumental]" if instrumental else params.lyrics
    vocal_language = "unknown" if instrumental else params.vocal_language

    request: dict = {
        "prompt": params.prompt,
        "lyrics": lyrics,
        "sample_query": params.sample_query,
        "audio_duration": duration,
        "bpm": params.bpm,
        "key_scale": params.key_scale,
        "time_signature": params.time_signature,
        "vocal_language": vocal_language,
        "inference_steps": params.inference_steps,
        "batch_size": batch,
        "thinking": params.thinking and lm_enabled,
        "use_format": params.use_format and lm_enabled,
        "audio_format": audio_format,
        "model": model,
        "use_random_seed": params.use_random_seed,
        "seed": params.seed,
        "task_type": task,
        "infer_method": params.infer_method,
        # LM sampling + CoT must be disabled when no LM is loaded. Otherwise
        # ACE-Step still enters prepare_llm_generation_inputs and fails with
        # "LLM disabled via ACESTEP_INIT_LLM=false" in conservative mode.
        "lm_temperature": params.lm_temperature,
        "lm_cfg_scale": params.lm_cfg_scale,
        "lm_top_p": params.lm_top_p,
        "lm_repetition_penalty": params.lm_repetition_penalty,
        "use_cot_caption": params.use_cot_caption and lm_enabled,
        "use_cot_language": params.use_cot_language and lm_enabled,
        "constrained_decoding": params.constrained_decoding and lm_enabled,
        "sample_mode": bool(
            params.sample_query and not params.prompt and not params.lyrics and lm_enabled
        ),
    }
    if params.lm_top_k is not None:
        request["lm_top_k"] = params.lm_top_k

    # base-only DiT knobs (turbo ignores these)
    if is_base:
        request["guidance_scale"] = params.guidance_scale
        request["shift"] = params.shift
        request["use_adg"] = params.use_adg
        request["cfg_interval_start"] = params.cfg_interval_start
        request["cfg_interval_end"] = params.cfg_interval_end

    # editing / reference-audio modes
    if task != "text2music" or has_ref:
        if params.instruction:
            request["instruction"] = params.instruction
        if task == "repaint":
            request["repainting_start"] = params.repainting_start
            if params.repainting_end is not None:
                request["repainting_end"] = params.repainting_end
        request["audio_cover_strength"] = params.audio_cover_strength

    return request


def _root_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def _script_path() -> Path:
    return _root_dir() / "scripts" / "launch_acestep.sh"


def _log_path() -> Path:
    log_dir = Path(os.environ.get("APP_RUN_LOG_DIR") or (_root_dir() / "logs"))
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "acestep.log"


def _append_log(message: str) -> None:
    try:
        with _log_path().open("a", encoding="utf-8") as fh:
            fh.write(message.rstrip() + "\n")
    except Exception:
        pass


def _find_bash() -> str | None:
    """Locate a bash interpreter to run the (bash) launcher script.

    The ACE-Step launcher is a bash script that relies on a Unix toolchain.
    On Windows it can still run under Git Bash, so we probe the standard
    Git for Windows install locations in addition to PATH.
    """
    found = shutil.which("bash")
    if found:
        return found
    if os.name == "nt":
        for candidate in (
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ):
            if Path(candidate).is_file():
                return candidate
    return None


def start() -> dict:
    """Start ACE-Step if it is not already reachable/running."""
    global _proc

    if os.environ.get("SKIP_ACESTEP") == "1" or os.environ.get("APP_DISABLE_ACESTEP_LAUNCH") == "1":
        return {
            "ok": False,
            "service_up": False,
            "starting": False,
            "error": "音乐生成服务已被 SKIP_ACESTEP=1 禁用。",
            "log": str(_log_path()),
        }

    if (
        os.environ.get("MUSIC_STUDIO_PACKAGED") == "1"
        and not os.environ.get("APP_ACESTEP_RUNTIME_DIR")
    ):
        return {
            "ok": False,
            "service_up": False,
            "starting": False,
            "error": (
                "打包应用未包含 ACE-Step runtime。为避免污染用户电脑环境，"
                "不会在用户机器上自动安装 uv 或下载 ACE-Step 依赖。"
            ),
            "log": str(_log_path()),
        }

    if ace.health(timeout=1.0):
        _append_log("[acestep] 检测到 ACE-Step 服务已在运行，复用现有进程；如刚修改目录，请在设置中执行「保存并重启服务」。")
        return {"ok": True, "service_up": True, "starting": False, "log": str(_log_path())}

    with _lock:
        if _proc and _proc.poll() is None:
            return {"ok": True, "service_up": False, "starting": True, "log": str(_log_path())}

        script = _script_path()
        if not script.is_file():
            return {
                "ok": False,
                "service_up": False,
                "starting": False,
                "error": f"启动脚本不存在: {script}",
                "log": str(_log_path()),
            }

        runtime_launcher = Path(os.environ.get("APP_ACESTEP_LAUNCHER") or "")
        if runtime_launcher.is_file() and os.environ.get("APP_ACESTEP_RUNTIME_DIR"):
            command = [sys.executable, str(runtime_launcher)]
        else:
            bash = _find_bash()
            if bash is None:
                return {
                    "ok": False,
                    "service_up": False,
                    "starting": False,
                    "error": (
                        "未找到 bash，无法启动音乐生成服务。"
                        "Windows 请先安装 Git for Windows（自带 Git Bash）或改用 WSL 后重试；"
                        "音轨分离等其他功能不受影响。"
                    ),
                    "log": str(_log_path()),
                }
            command = [bash, str(script)]

        if command is None:
            return {
                "ok": False,
                "service_up": False,
                "starting": False,
                "error": "无法确定音乐生成服务启动命令。",
                "log": str(_log_path()),
            }

        log_file = open(_log_path(), "a", encoding="utf-8")
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        _proc = subprocess.Popen(
            command,
            cwd=str(_root_dir()),
            env=env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=(os.name != "nt"),
        )
        return {"ok": True, "service_up": False, "starting": True, "log": str(_log_path())}


def stop(timeout: float = 8.0) -> dict:
    global _proc
    stopped = False
    with _lock:
        proc = _proc
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
        deadline = time.time() + timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                stopped = True
                break
            time.sleep(0.1)
        if proc.poll() is None:
            try:
                if os.name != "nt":
                    os.killpg(proc.pid, 15)
                else:
                    proc.kill()
            except Exception:
                pass
        try:
            proc.wait(timeout=2)
            stopped = True
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    with _lock:
        if _proc is proc:
            _proc = None
    service_up = ace.health(timeout=1.0)
    return {"ok": True, "stopped": stopped or not service_up, "service_up": service_up, "log": str(_log_path())}


def restart() -> dict:
    stop()
    return start()


atexit.register(stop)
