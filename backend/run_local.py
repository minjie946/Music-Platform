"""Project-contained local launcher.

Starts everything the backend needs without any system install:
- Redis: via the `redislite` package (bundled redis-server binary), listening on
  a local TCP port with its data file under ``data/redis/``.
- FastAPI (uvicorn) on :8000
- Celery worker (solo pool, embedded beat)

ffmpeg is provided by the `static-ffmpeg` package (see app/audio_utils.py), so
no system ffmpeg is required either.

Usage:
    source .venv/bin/activate
    pip install -r requirements-dev.txt   # once, for redislite + static-ffmpeg
    python run_local.py

Stop with Ctrl+C.
"""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

if sys.version_info[:2] != (3, 12):
    sys.exit(
        f"[run_local] 本项目锁定 Python 3.12，当前是 {sys.version.split()[0]}。\n"
        f"请用 python3.12 重建虚拟环境：rm -rf .venv && python3.12 -m venv .venv"
    )

HERE = Path(__file__).resolve().parent
REDIS_PORT = int(os.environ.get("LOCAL_REDIS_PORT", "6390"))
API_PORT = int(os.environ.get("LOCAL_API_PORT", "8000"))
REDIS_URL = f"redis://127.0.0.1:{REDIS_PORT}/0"


def _ensure_port_free(port: int) -> None:
    """Check if *port* is already in use; if so, try to kill the holder and wait."""
    # 先用 socket.bind 探测端口是否已被占用，避免 macOS 上 psutil 权限问题
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", port))
        sock.close()
        return  # 端口空闲
    except OSError:
        sock.close()
        pass  # 端口被占用，继续往下走

    # 用 lsof 找到占用端口的进程 PID
    import subprocess as sp_proc

    try:
        result = sp_proc.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0 or not result.stdout.strip():
            print(f"[run_local] 端口 {port} 被占用但无法找到进程，请手动检查")
            return
        pid = int(result.stdout.strip().splitlines()[0])
    except Exception:
        print(f"[run_local] 端口 {port} 被占用但无法找到进程，请手动检查")
        return

    # 尝试优雅停止，失败则强杀
    print(f"[run_local] 端口 {port} 被 PID {pid} 占用，正在停止...")
    try:
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):  # wait up to 5s
            try:
                os.kill(pid, 0)  # 检查进程是否还在
                time.sleep(0.1)
            except ProcessLookupError:
                break
        else:
            os.kill(pid, signal.SIGKILL)
            time.sleep(0.5)
    except ProcessLookupError:
        pass  # 进程已消失
    print(f"[run_local] 端口 {port} 已释放")


def start_redis():
    try:
        from redislite import Redis
    except ImportError:
        print(
            "[run_local] 缺少 redislite，请先运行: pip install -r requirements-dev.txt",
            file=sys.stderr,
        )
        raise SystemExit(1)
    import redis as redis_py

    redis_dir = HERE / "data" / "redis"
    redis_dir.mkdir(parents=True, exist_ok=True)
    db_file = str(redis_dir / "redis.db")
    # 在启动前确保端口可用（清理上一次残留的 redis-server 进程）
    _ensure_port_free(REDIS_PORT)
    # Non-zero port makes redislite listen on TCP so the worker/api can connect.
    rdb = Redis(db_file, serverconfig={"port": str(REDIS_PORT)})
    rdb.set("__healthcheck__", "1")

    # Verify TCP reachability, since api/worker connect over TCP (not the socket).
    tcp = redis_py.Redis(host="127.0.0.1", port=REDIS_PORT, socket_connect_timeout=5)
    tcp.ping()
    print(f"[run_local] redis (redislite) listening on 127.0.0.1:{REDIS_PORT}")
    return rdb


def _log_dir() -> Path:
    configured = os.environ.get("APP_RUN_LOG_DIR", "").strip()
    path = Path(configured).expanduser() if configured else HERE.parent / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _append_launcher_log(log_dir: Path, message: str) -> None:
    print(message)
    try:
        with (log_dir / "launcher.log").open("a", encoding="utf-8") as fh:
            fh.write(message + "\n")
    except OSError:
        pass


def main() -> int:
    log_dir = _log_dir()
    (log_dir / "launcher.log").touch()
    (log_dir / "api.log").touch()
    (log_dir / "worker.log").touch()
    rdb = start_redis()

    env = {**os.environ, "APP_REDIS_URL": REDIS_URL, "PYTHONUNBUFFERED": "1"}

    procs: list[subprocess.Popen] = []
    try:
        api_log = open(log_dir / "api.log", "a", encoding="utf-8")
        api = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "0.0.0.0",
                "--port",
                str(API_PORT),
            ],
            cwd=str(HERE),
            env=env,
            stdout=api_log,
            stderr=subprocess.STDOUT,
        )
        procs.append(api)
        _append_launcher_log(log_dir, f"[run_local] api (uvicorn) on http://localhost:{API_PORT}")

        worker_log = open(log_dir / "worker.log", "a", encoding="utf-8")
        # default 队列 worker（分轨/编辑/清理等短任务）+ 内嵌 beat。
        worker = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "celery",
                "-A",
                "app.celery_app.celery_app",
                "worker",
                "--beat",
                "--pool=solo",
                "--queues=default",
                "--hostname=default@%h",
                "--loglevel=info",
            ],
            cwd=str(HERE),
            env=env,
            stdout=worker_log,
            stderr=subprocess.STDOUT,
        )
        procs.append(worker)
        _append_launcher_log(log_dir, "[run_local] celery worker[default] (solo pool, embedded beat) started")

        # generation 队列 worker（音乐生成/初始化等长任务，独占，不阻塞分轨/编辑）。
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
        _append_launcher_log(log_dir, "[run_local] celery worker[generation] (solo pool) started")
        _append_launcher_log(log_dir, "[run_local] Ready. 打开 http://localhost:5173 (前端) 使用，Ctrl+C 停止。")

        while True:
            for p in procs:
                if p.poll() is not None:
                    _append_launcher_log(log_dir, f"[run_local] child pid {p.pid} exited ({p.returncode}); shutting down")
                    raise KeyboardInterrupt
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            if p.poll() is None:
                p.send_signal(signal.SIGINT)
        for p in procs:
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()
        try:
            rdb.shutdown()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
