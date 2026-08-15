#!/usr/bin/env python3
"""Launch a prebuilt ACE-Step runtime without requiring uv on the user machine."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


def log(message: str) -> None:
    print(f"[acestep-runtime] {message}", flush=True)


def read_setting(key: str) -> str:
    settings_json = Path(os.environ.get("APP_DATA_DIR") or (BACKEND / "data")) / "settings.json"
    if not settings_json.is_file():
        return ""
    try:
        return str(json.loads(settings_json.read_text("utf-8")).get(key) or "").strip()
    except Exception:
        return ""


def runtime_python(runtime_dir: Path) -> Path:
    if os.name == "nt":
        return runtime_dir / "ACE-Step-1.5" / ".venv" / "Scripts" / "python.exe"
    return runtime_dir / "ACE-Step-1.5" / ".venv" / "bin" / "python"


def runtime_console(runtime_dir: Path, name: str) -> Path:
    if os.name == "nt":
        return runtime_dir / "ACE-Step-1.5" / ".venv" / "Scripts" / f"{name}.exe"
    return runtime_dir / "ACE-Step-1.5" / ".venv" / "bin" / name


def patch_checkpoint_resolution(repo: Path) -> None:
    patches = [
        (
            repo / "acestep" / "api" / "http" / "model_init_service.py",
            '    project_root = get_project_root()\n    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "http" / "model_init_service.py",
            '    llm = app_state.llm_handler\n    from acestep.model_downloader import get_checkpoints_dir\n',
            '    llm = app_state.llm_handler\n    project_root = get_project_root()\n    from acestep.model_downloader import get_checkpoints_dir\n',
        ),
        (
            repo / "acestep" / "api" / "startup_model_init.py",
            '    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "runtime_helpers.py",
            '        project_root = get_project_root()\n        checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '        from acestep.model_downloader import get_checkpoints_dir\n\n        checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "http" / "reinitialize_route.py",
            '                    project_root = get_project_root()\n                    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '                    from acestep.model_downloader import get_checkpoints_dir\n\n                    checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "http" / "model_service_routes.py",
            '    project_root = get_project_root()\n    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "llm_readiness.py",
            '        project_root = get_project_root()\n        checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '        from acestep.model_downloader import get_checkpoints_dir\n\n        checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "http" / "sample_format_routes.py",
            '                project_root = get_project_root()\n                checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '                from acestep.model_downloader import get_checkpoints_dir\n\n                checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
    ]
    changed = []
    for path, old, new in patches:
        if not path.is_file():
            continue
        src = path.read_text("utf-8")
        if old in src:
            path.write_text(src.replace(old, new), "utf-8")
            changed.append(path.relative_to(repo))
    if changed:
        log("已修补 ACE-Step checkpoints 目录解析，使用 ACESTEP_CHECKPOINTS_DIR:")
        for item in changed:
            log(f"  - {item}")


def hardware_env(py: Path, repo: Path) -> dict[str, str]:
    code = r"""
import json
result = {
    "ACESTEP_CONFIG_PATH": "acestep-v15-turbo",
    "ACESTEP_DEVICE": "cpu",
    "ACESTEP_OFFLOAD_TO_CPU": "true",
    "ACESTEP_INIT_LLM": "false",
}
try:
    import torch
    if torch.cuda.is_available():
        result["ACESTEP_DEVICE"] = "cuda"
        vram = torch.cuda.get_device_properties(0).total_memory / (1024**3)
        if vram > 8:
            result["ACESTEP_LM_MODEL_PATH"] = "acestep-5Hz-lm-0.6B"
            result["ACESTEP_LM_BACKEND"] = "pt"
            result["ACESTEP_INIT_LLM"] = "true"
        if vram > 16:
            result["ACESTEP_CONFIG_PATH"] = "acestep-v15-xl-turbo"
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        result["ACESTEP_DEVICE"] = "mps"
except Exception:
    pass
print(json.dumps(result))
"""
    try:
        out = subprocess.check_output([str(py), "-c", code], cwd=str(repo), text=True)
        return {k: str(v) for k, v in json.loads(out).items()}
    except Exception:
        return {
            "ACESTEP_CONFIG_PATH": "acestep-v15-turbo",
            "ACESTEP_DEVICE": "cpu",
            "ACESTEP_OFFLOAD_TO_CPU": "true",
            "ACESTEP_INIT_LLM": "false",
        }


def main() -> int:
    runtime_dir = Path(os.environ.get("APP_ACESTEP_RUNTIME_DIR") or "").expanduser()
    if not runtime_dir.is_dir():
        log("APP_ACESTEP_RUNTIME_DIR 未设置或目录不存在")
        return 1

    repo = runtime_dir / "ACE-Step-1.5"
    py = runtime_python(runtime_dir)
    cli = runtime_console(runtime_dir, "acestep-api")
    if not repo.is_dir() or not py.is_file():
        log(f"ACE-Step runtime 不完整: repo={repo} python={py}")
        return 1
    patch_checkpoint_resolution(repo)

    env = {
        **os.environ,
        **hardware_env(py, repo),
        "PYTHONUNBUFFERED": "1",
        "ACESTEP_API_HOST": os.environ.get("ACESTEP_API_HOST", "127.0.0.1"),
        "ACESTEP_API_PORT": os.environ.get("ACESTEP_API_PORT", "8001"),
    }
    ffmpeg = env.get("APP_FFMPEG_EXE", "").strip()
    if ffmpeg:
        ffmpeg_dir = str(Path(ffmpeg).expanduser().parent)
        env["PATH"] = f"{ffmpeg_dir}{os.pathsep}{env.get('PATH', '')}"
        log(f"使用内置 ffmpeg: {ffmpeg}")
    # Do not auto-load an LM at service startup. The backend /initialize task
    # applies the user's selected LM and can report missing downloads clearly.
    env["ACESTEP_INIT_LLM"] = "false"
    env.pop("ACESTEP_LM_MODEL_PATH", None)
    env.pop("ACESTEP_LM_BACKEND", None)
    workspace = read_setting("workspace_dir")
    configured = read_setting("acestep_checkpoints_dir") or (
        str(Path(workspace).expanduser() / "ace" / "models") if workspace else ""
    )
    if configured:
        env["ACESTEP_CHECKPOINTS_DIR"] = configured
    else:
        log("未配置模型存放目录。请先在应用设置中选择目录；不会使用默认 checkpoints 启动。")
        return 1
    configured = read_setting("acestep_tmp_dir") or (
        str(Path(workspace).expanduser() / "ace" / "generation" / "tmp") if workspace else ""
    )
    if configured:
        env["ACESTEP_TMPDIR"] = configured
    else:
        log("未配置临时缓存目录。请先在应用设置中选择目录；不会使用默认临时目录启动。")
        return 1

    if env.get("ACESTEP_CHECKPOINTS_DIR") and env.get("ACESTEP_LM_MODEL_PATH"):
        lm = env["ACESTEP_LM_MODEL_PATH"]
        if not Path(lm).is_absolute():
            env["ACESTEP_LM_MODEL_PATH"] = str(Path(env["ACESTEP_CHECKPOINTS_DIR"]) / lm)

    log(
        "启动 REST API: "
        f"http://{env['ACESTEP_API_HOST']}:{env['ACESTEP_API_PORT']} "
        f"device={env.get('ACESTEP_DEVICE')} model={env.get('ACESTEP_CONFIG_PATH')}"
    )
    command = [str(cli)] if cli.is_file() else [str(py), "-m", "acestep.api"]
    return subprocess.call(command, cwd=str(repo), env=env)


if __name__ == "__main__":
    raise SystemExit(main())
