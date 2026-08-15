"""Desktop launcher for the packaged app.

This entrypoint is intentionally separate from ``run_local.py``:
- it uses dynamic local ports to avoid collisions on user machines;
- it writes data/logs under a desktop user-data directory;
- it prints a machine-readable "desktop-ready" line for the Tauri shell.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import time
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
_LAUNCHER_LOG: Path | None = None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _default_data_dir() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / "Music Studio"


def _prepare_data_dir(packaged: bool) -> Path:
    requested = Path(os.environ.get("MUSIC_STUDIO_DATA_DIR") or _default_data_dir()).expanduser()
    candidates = [requested]
    if not packaged:
        candidates.append(
            Path(os.environ.get("MUSIC_STUDIO_FALLBACK_DATA_DIR") or (ROOT / "desktop-data")).expanduser()
        )
    last_error: Exception | None = None
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate
        except OSError as exc:
            last_error = exc
    raise RuntimeError(f"无法创建桌面数据目录: {last_error}")


def _emit(event: str, **payload: object) -> None:
    message = json.dumps({"event": event, **payload}, ensure_ascii=False)
    print(message, flush=True)
    if _LAUNCHER_LOG is not None:
        try:
            with _LAUNCHER_LOG.open("a", encoding="utf-8") as fh:
                fh.write(message + "\n")
        except OSError:
            pass


def _base_child_env(packaged: bool) -> dict[str, str]:
    if not packaged:
        return dict(os.environ)
    keep = {
        "HOME",
        "PATH",
        "TMPDIR",
        "TEMP",
        "TMP",
        "USER",
        "USERNAME",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    }
    return {key: value for key, value in os.environ.items() if key in keep and value}


def _venv_python(venv: Path) -> Path:
    if sys.platform == "win32":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def _runtime_tool(root: Path, name: str) -> Path:
    if sys.platform == "win32":
        return root / "tools" / f"{name}.exe"
    return root / "tools" / name


def _patch_windows_pyvenv_home(venv: Path, home: Path) -> None:
    if sys.platform != "win32":
        return
    cfg = venv / "pyvenv.cfg"
    if not cfg.is_file():
        return
    lines = cfg.read_text("utf-8").splitlines()
    home_line = f"home = {home}"
    replaced = False
    patched = []
    for line in lines:
        if line.startswith("home = "):
            patched.append(home_line)
            replaced = True
        else:
            patched.append(line)
    if not replaced:
        patched.append(home_line)
    cfg.write_text("\n".join(patched) + "\n", "utf-8")


def _archive_parts(archive: Path) -> list[Path]:
    return sorted(archive.parent.glob(f"{archive.name}.part*"))


def _archive_available(archive: Path) -> bool:
    return archive.is_file() or bool(_archive_parts(archive))


def _marker_value(marker: str, key: str) -> str:
    for line in marker.splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return ""


def _materialize_archive(archive: Path, runtime_dir: Path, marker: str) -> Path:
    if archive.is_file():
        return archive
    parts = _archive_parts(archive)
    if not parts:
        raise FileNotFoundError(f"runtime archive not found: {archive}")
    cache_dir = runtime_dir.parent / "runtime-archives"
    cache_dir.mkdir(parents=True, exist_ok=True)
    materialized = cache_dir / archive.name
    expected_sha = _marker_value(marker, "sha256")
    expected_size = sum(part.stat().st_size for part in parts)
    if materialized.is_file() and materialized.stat().st_size == expected_size:
        return materialized
    tmp = materialized.with_suffix(materialized.suffix + ".tmp")
    with tmp.open("wb") as out:
        for part in parts:
            with part.open("rb") as src:
                shutil.copyfileobj(src, out)
    tmp.replace(materialized)
    if expected_sha:
        import hashlib

        digest = hashlib.sha256()
        with materialized.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_sha:
            materialized.unlink(missing_ok=True)
            raise RuntimeError(f"runtime archive chunks sha256 mismatch: {archive.name}")
    return materialized


def _extract_runtime_archive(archive: Path, target: Path, marker: str) -> None:
    if target.exists():
        return
    target.mkdir(parents=True, exist_ok=True)
    archive = _materialize_archive(archive, target, marker)
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(target)


def _runtime_marker(runtime_name: str, archive: Path) -> str:
    marker = ROOT / "desktop-runtime" / f".{runtime_name}-runtime-ready"
    if marker.is_file():
        return marker.read_text("utf-8")
    if archive.is_file():
        return f"archive={archive.name}\nsize={archive.stat().st_size}\n"
    parts = _archive_parts(archive)
    return f"archive={archive.name}\nparts={len(parts)}\nsize={sum(part.stat().st_size for part in parts)}\n"


def _prepare_cached_runtime(
    archive: Path,
    runtime_dir: Path,
    marker_name: str,
) -> None:
    bundled_marker = _runtime_marker(marker_name, archive)
    installed_marker = runtime_dir / f".{marker_name}-runtime-ready"
    if runtime_dir.exists():
        try:
            if installed_marker.read_text("utf-8") == bundled_marker:
                return
        except OSError:
            pass
        shutil.rmtree(runtime_dir)
    _extract_runtime_archive(archive, runtime_dir, bundled_marker)
    installed_marker.write_text(bundled_marker, "utf-8")


def _locate_bundled_svc_python(data_dir: Path, log_dir: Path) -> Path | None:
    archive = ROOT / "desktop-runtime" / "svc-runtime.tar.gz"
    if not archive.is_file():
        return None
    runtime_dir = data_dir / "bundled-svc-runtime"
    try:
        _prepare_cached_runtime(archive, runtime_dir, "svc")
        venv = runtime_dir / "service-runtime" / ".venv"
        _patch_windows_pyvenv_home(venv, runtime_dir / "python" / "cpython")
        python = _venv_python(venv)
        if python.is_file():
            return python
    except Exception as exc:
        with open(log_dir / "svc.log", "a", encoding="utf-8") as fh:
            fh.write(f"SVC 内置 runtime 准备失败：{exc}\n")
    return None


def _prepare_acestep_runtime(data_dir: Path, log_dir: Path) -> Path | None:
    archive = ROOT / "desktop-runtime" / "acestep-runtime.tar.gz"
    if not _archive_available(archive):
        return None
    runtime_dir = data_dir / "bundled-acestep-runtime"
    try:
        _prepare_cached_runtime(archive, runtime_dir, "acestep")
        venv = runtime_dir / "ACE-Step-1.5" / ".venv"
        _patch_windows_pyvenv_home(venv, runtime_dir / "python" / "cpython")
        python = _venv_python(venv)
        if python.is_file():
            return runtime_dir
    except Exception as exc:
        with open(log_dir / "acestep.log", "a", encoding="utf-8") as fh:
            fh.write(f"ACE-Step 内置 runtime 准备失败：{exc}\n")
    return None


def _start_redis(redis_port: int, data_dir: Path):
    if sys.platform == "win32":
        _emit("desktop-log", message="Windows desktop runtime uses filesystem task queue; Redis is disabled")
        return None

    try:
        from redislite import Redis
    except ImportError:
        _emit(
            "desktop-error",
            message="缺少 redislite，请先在 backend/.venv 中安装 requirements-dev.txt",
        )
        raise SystemExit(1)

    import redis as redis_py

    redis_dir = data_dir / "redis"
    redis_dir.mkdir(parents=True, exist_ok=True)
    rdb = Redis(str(redis_dir / "redis.db"), serverconfig={"port": str(redis_port)})
    rdb.set("__healthcheck__", "1")
    client = redis_py.Redis(host="127.0.0.1", port=redis_port, socket_connect_timeout=1)
    last_error: Exception | None = None
    for _ in range(50):
        try:
            client.ping()
            break
        except Exception as exc:
            last_error = exc
            time.sleep(0.1)
    else:
        raise RuntimeError(f"Redis 启动超时: {last_error}")
    _emit("desktop-log", message=f"redis listening on 127.0.0.1:{redis_port}")
    return rdb


def _locate_uv() -> str | None:
    """Find the uv executable.

    SVC depends on so-vits-svc-fork which requires Python <3.12, so it cannot
    share the bundled 3.12 backend runtime and is launched via ``uv run`` in its
    own environment. uv is often installed outside the inherited PATH (e.g. the
    official installer drops it in ~/.local/bin), so probe those locations too.
    """
    found = shutil.which("uv")
    if found:
        return found
    candidates = [
        Path.home() / ".local" / "bin" / "uv",
        Path.home() / ".cargo" / "bin" / "uv",
    ]
    if sys.platform == "win32":
        candidates += [
            Path.home() / ".local" / "bin" / "uv.exe",
            Path.home() / ".cargo" / "bin" / "uv.exe",
            Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
            / "Programs"
            / "uv"
            / "uv.exe",
        ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def _read_runtime_setting(data_dir: Path, key: str) -> str:
    settings_file = data_dir / "backend" / "settings.json"
    if not settings_file.is_file():
        return ""
    try:
        return str(json.loads(settings_file.read_text("utf-8")).get(key) or "").strip()
    except Exception:
        return ""


def _svc_models_dir(data_dir: Path) -> str:
    configured = _read_runtime_setting(data_dir, "svc_models_dir")
    if configured:
        return configured
    workspace = _read_runtime_setting(data_dir, "workspace_dir")
    if workspace:
        return str(Path(workspace).expanduser() / "svc" / "models")
    return ""


def _svc_work_dir(data_dir: Path, svc_models_dir: str) -> str:
    workspace = _read_runtime_setting(data_dir, "workspace_dir")
    if workspace:
        return str(Path(workspace).expanduser() / "svc" / "work")
    return str(Path(svc_models_dir).expanduser() / ".work")


def _svc_pretrained_dir(data_dir: Path) -> str:
    """大文件权重目录：优先用户设置 svc_pretrained_dir，否则留空由 sidecar 取默认。"""
    return _read_runtime_setting(data_dir, "svc_pretrained_dir")


def _apply_svc_pretrained_dir(svc_env: dict[str, str], data_dir: Path) -> None:
    """若用户配置了自定义权重目录，则透传给 sidecar（否则用其默认逻辑）。"""
    pd = _svc_pretrained_dir(data_dir)
    if pd:
        svc_env["SVC_PRETRAINED_DIR"] = str(Path(pd).expanduser())


def _start_svc(env: dict[str, str], log_dir: Path, data_dir: Path) -> subprocess.Popen | None:
    if env.get("SKIP_SVC") == "1":
        return None
    svc_models_dir = _svc_models_dir(data_dir)
    if not svc_models_dir:
        with open(log_dir / "svc.log", "a", encoding="utf-8") as fh:
            fh.write("SVC 未启动：请先在设置中配置 SVC 音源存放目录。应用不会使用默认目录启动 SVC。\n")
        return None
    svc_dir = ROOT / "svc_service"
    svc_python = _locate_bundled_svc_python(data_dir, log_dir)
    if svc_python is not None and svc_dir.is_dir():
        svc_port = int(env["SVC_API_PORT"])
        svc_work_dir = _svc_work_dir(data_dir, svc_models_dir)
        svc_env = {
            **env,
            "SVC_MODELS_DIR": svc_models_dir,
            "SVC_WORK_DIR": svc_work_dir,
            "PYTHONUNBUFFERED": "1",
        }
        _apply_svc_pretrained_dir(svc_env, data_dir)
        Path(svc_work_dir).mkdir(parents=True, exist_ok=True)
        _isolate_python_env(svc_env)
        log_file = open(log_dir / "svc.log", "a", encoding="utf-8")
        return subprocess.Popen(
            [
                str(svc_python),
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(svc_port),
            ],
            cwd=str(svc_dir),
            env=svc_env,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

    uv = _locate_uv()
    if env.get("MUSIC_STUDIO_PACKAGED") == "1":
        with open(log_dir / "svc.log", "a", encoding="utf-8") as fh:
            fh.write("SVC 未启动：打包应用缺少内置 SVC runtime，为避免污染用户环境已禁止临时安装。\n")
        return None
    if not uv or not svc_dir.is_dir():
        reason = (
            "未找到 uv（人声转换 SVC 需要独立的 Python<3.12 环境，依赖 uv 自动创建）。"
            "请安装 uv 后重启应用：https://docs.astral.sh/uv/getting-started/installation/"
            if not uv
            else f"未找到 svc_service 目录: {svc_dir}"
        )
        with open(log_dir / "svc.log", "a", encoding="utf-8") as fh:
            fh.write(f"SVC 未启动：{reason}\n")
        return None

    svc_port = int(env["SVC_API_PORT"])
    svc_work_dir = _svc_work_dir(data_dir, svc_models_dir)
    svc_env = {
        **env,
        "SVC_MODELS_DIR": svc_models_dir,
        "SVC_WORK_DIR": svc_work_dir,
        "PYTHONUNBUFFERED": "1",
        "UV_PROJECT_ENVIRONMENT": str(svc_dir / ".venv"),
    }
    _apply_svc_pretrained_dir(svc_env, data_dir)
    Path(svc_work_dir).mkdir(parents=True, exist_ok=True)
    _isolate_python_env(svc_env)
    log_file = open(log_dir / "svc.log", "a", encoding="utf-8")
    return subprocess.Popen(
        [
            uv,
            "run",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(svc_port),
        ],
        cwd=str(svc_dir),
        env=svc_env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )


def _isolate_python_env(env: dict[str, str]) -> None:
    for key in ("VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH", "MUSIC_STUDIO_PYTHON"):
        env.pop(key, None)


def main() -> int:
    global _LAUNCHER_LOG

    if sys.version_info[:2] != (3, 12):
        _emit(
            "desktop-error",
            message=f"后端需要 Python 3.12，当前是 {sys.version.split()[0]}",
        )
        return 1

    packaged = os.environ.get("MUSIC_STUDIO_PACKAGED") == "1"
    data_dir = _prepare_data_dir(packaged)
    configured_log_dir = os.environ.get("APP_RUN_LOG_DIR", "").strip()
    log_dir = (
        data_dir / "logs"
        if packaged
        else Path(configured_log_dir).expanduser() if configured_log_dir else data_dir / "logs"
    )
    log_dir.mkdir(parents=True, exist_ok=True)
    _LAUNCHER_LOG = log_dir / "launcher.log"
    _LAUNCHER_LOG.touch()
    (log_dir / "api.log").touch()
    (log_dir / "worker.log").touch()
    (log_dir / "acestep.log").touch()
    (log_dir / "svc.log").touch()

    api_port = int(os.environ.get("LOCAL_API_PORT") or _free_port()) if not packaged else _free_port()
    redis_port = (
        int(os.environ.get("LOCAL_REDIS_PORT") or (_free_port() if sys.platform != "win32" else 0))
        if not packaged
        else (_free_port() if sys.platform != "win32" else 0)
    )
    svc_port = int(os.environ.get("SVC_API_PORT") or _free_port()) if not packaged else _free_port()
    ace_port = int(os.environ.get("ACESTEP_API_PORT") or _free_port()) if not packaged else _free_port()
    api_base_url = f"http://127.0.0.1:{api_port}"
    ace_base_url = f"http://127.0.0.1:{ace_port}"

    redis_url = "filesystem://"
    desktop_file_store = "1"
    rdb = None
    if sys.platform != "win32":
        try:
            rdb = _start_redis(redis_port, data_dir)
            redis_url = f"redis://127.0.0.1:{redis_port}/0"
            desktop_file_store = "0"
        except Exception as exc:
            _emit(
                "desktop-log",
                message=f"Redis 启动失败，已回退到本地文件队列: {exc}",
            )

    dev_acestep_dir = os.environ.get("APP_ACESTEP_DIR") or os.environ.get("ACESTEP_DIR")
    session_id = os.environ.get("MUSIC_STUDIO_SESSION_ID") or f"launcher-{int(time.time() * 1000)}"
    env = {
        **_base_child_env(packaged),
        "MUSIC_STUDIO_SESSION_ID": session_id,
        "APP_DATA_DIR": str(data_dir / "backend"),
        "APP_RUN_LOG_DIR": str(log_dir),
        "APP_REDIS_URL": redis_url,
        "APP_CELERY_FILESYSTEM_DIR": str(data_dir / "celery"),
        "APP_DESKTOP_FILE_STORE": desktop_file_store,
        "APP_SVC_API_URL": f"http://127.0.0.1:{svc_port}",
        "APP_ACESTEP_API_URL": ace_base_url,
        "MUSIC_STUDIO_RUNTIME_MODE": "packaged" if packaged else "desktop-dev",
        "LOCAL_API_PORT": str(api_port),
        "LOCAL_REDIS_PORT": str(redis_port),
        "SVC_API_PORT": str(svc_port),
        "ACESTEP_API_HOST": "127.0.0.1",
        "ACESTEP_API_PORT": str(ace_port),
        "ACESTEP_DIR": str(
            data_dir / "external" / "ACE-Step-1.5"
            if packaged
            else Path(dev_acestep_dir or (ROOT / "external" / "ACE-Step-1.5")).expanduser()
        ),
        "DISABLE_UV_AUTO_INSTALL": "1",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    _isolate_python_env(env)
    resource_root = HERE.parent
    for tool, key in (("ffmpeg", "APP_FFMPEG_EXE"), ("ffprobe", "APP_FFPROBE_EXE")):
        bundled_tool = _runtime_tool(resource_root, tool)
        if bundled_tool.is_file():
            env[key] = str(bundled_tool)
            continue
        if packaged:
            runtime_tool = data_dir / "bundled-runtime" / "tools" / (f"{tool}.exe" if sys.platform == "win32" else tool)
            if runtime_tool.is_file():
                env[key] = str(runtime_tool)
    if packaged:
        acestep_runtime = _prepare_acestep_runtime(data_dir, log_dir)
        if acestep_runtime is not None:
            env["APP_ACESTEP_RUNTIME_DIR"] = str(acestep_runtime)
            env["APP_ACESTEP_LAUNCHER"] = str(ROOT / "scripts" / "launch_acestep_runtime.py")
    else:
        env.pop("APP_ACESTEP_RUNTIME_DIR", None)
        env.pop("APP_ACESTEP_LAUNCHER", None)

    # SoundFont（旋律生成 / MIDI 轨导出需要）：设置 > <workspace>/soundfont/*.sf2|sf3 > 打包内置。
    if not env.get("APP_SOUNDFONT"):
        sf = _read_runtime_setting(data_dir, "soundfont_path")
        cand = Path(sf).expanduser() if sf else None
        if cand is None or not cand.is_file():
            ws = _read_runtime_setting(data_dir, "workspace_dir")
            if ws:
                found = sorted(Path(ws).expanduser().joinpath("soundfont").glob("*.sf[23]"))
                cand = found[0] if found else None
        if cand is None or not cand.is_file():
            bundled_sf = resource_root / "bundled-runtime" / "soundfont" / "general.sf2"
            cand = bundled_sf if bundled_sf.is_file() else None
        if cand is not None and cand.is_file():
            env["APP_SOUNDFONT"] = str(cand)
    Path(env["APP_DATA_DIR"]).mkdir(parents=True, exist_ok=True)
    celery_dir = data_dir / "celery"
    celery_dir.mkdir(parents=True, exist_ok=True)
    beat_schedule = celery_dir / "celerybeat-schedule"

    procs: list[subprocess.Popen] = []
    svc_proc = _start_svc(env, log_dir, data_dir)
    if svc_proc:
        procs.append(svc_proc)

    try:
        api_log = open(log_dir / "api.log", "a", encoding="utf-8")
        api = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(api_port),
            ],
            cwd=str(HERE),
            env=env,
            stdout=api_log,
            stderr=subprocess.STDOUT,
        )
        procs.append(api)

        worker_log = open(log_dir / "worker.log", "a", encoding="utf-8")
        # 队列拆分依赖 Redis broker；filesystem 兜底模式不支持多命名队列，
        # 此时让 default worker 同时消费两个队列，避免生成任务无人消费被卡住。
        using_redis = redis_url != "filesystem://"
        default_queues = "default" if using_redis else "default,generation"
        worker = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "celery",
                "-A",
                "app.celery_app.celery_app",
                "worker",
                "--beat",
                "--schedule",
                str(beat_schedule),
                "--pool=solo",
                f"--queues={default_queues}",
                "--hostname=default@%h",
                "--loglevel=info",
            ],
            cwd=str(HERE),
            env=env,
            stdout=worker_log,
            stderr=subprocess.STDOUT,
        )
        procs.append(worker)

        # 仅在 Redis broker 下起独立 generation worker：长任务独占，不阻塞分轨/编辑。
        if using_redis:
            gen_worker_log = open(log_dir / "worker-generation.log", "a", encoding="utf-8")
            gen_worker = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "celery",
                    "-A",
                    "app.celery_app.celery_app",
                    "worker",
                    "--pool=solo",
                    "--queues=generation",
                    "--hostname=generation@%h",
                    "--loglevel=info",
                ],
                cwd=str(HERE),
                env=env,
                stdout=gen_worker_log,
                stderr=subprocess.STDOUT,
            )
            procs.append(gen_worker)

        runtime = {
            "api_base_url": api_base_url,
            "api_port": api_port,
            "redis_port": redis_port,
            "redis_url": redis_url,
            "svc_port": svc_port,
            "ace_port": ace_port,
            "ace_url": ace_base_url,
            "data_dir": str(data_dir),
            "log_dir": str(log_dir),
        }
        (data_dir / "runtime.json").write_text(
            json.dumps(runtime, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        _emit("desktop-ready", **runtime)

        while True:
            if svc_proc is None and _svc_models_dir(data_dir):
                _emit("desktop-log", message="SVC directory configured; starting sidecar")
                svc_proc = _start_svc(env, log_dir, data_dir)
                if svc_proc:
                    procs.append(svc_proc)
            for proc in list(procs):
                if proc.poll() is not None and proc is svc_proc:
                    _emit("desktop-log", message=f"SVC sidecar exited: {proc.returncode}; restarting")
                    procs.remove(proc)
                    svc_proc = _start_svc(env, log_dir, data_dir)
                    if svc_proc:
                        procs.append(svc_proc)
                    continue
                if proc.poll() is not None:
                    _emit("desktop-error", message=f"child pid {proc.pid} exited: {proc.returncode}")
                    raise KeyboardInterrupt
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for proc in procs:
            if proc.poll() is None:
                try:
                    proc.send_signal(signal.SIGINT)
                except Exception:
                    proc.terminate()
        for proc in procs:
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
        try:
            if rdb is not None:
                rdb.shutdown()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
