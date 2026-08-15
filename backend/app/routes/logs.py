"""Read-only runtime log endpoints."""
from __future__ import annotations

import asyncio
import os
from collections import deque
from pathlib import Path

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

router = APIRouter(prefix="/api/logs", tags=["logs"])

_LOG_FILES = {
    "launcher": "launcher.log",
    "api": "api.log",
    "worker": "worker.log",
    "acestep": "acestep.log",
    "svc": "svc.log",
}


def _logs_dir() -> Path:
    run_dir = os.environ.get("APP_RUN_LOG_DIR", "").strip()
    if run_dir:
        return Path(run_dir).expanduser()
    return Path(__file__).resolve().parents[3] / "logs"


def _log_path(name: str) -> Path:
    filename = _LOG_FILES.get(name)
    if not filename:
        raise HTTPException(status_code=404, detail="未知日志类型")
    return _logs_dir() / filename


def _tail_text(path: Path, lines: int = 300) -> str:
    if not path.is_file():
        return ""
    q: deque[str] = deque(maxlen=max(1, min(lines, 2000)))
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            q.append(line)
    return "".join(q)


@router.get("/{name}")
def read_log(name: str, lines: int = 300) -> dict:
    """Return the latest log lines. Read-only; no mutation endpoints exist."""
    path = _log_path(name)
    return {
        "name": name,
        "path": str(path),
        "exists": path.is_file(),
        "content": _tail_text(path, lines),
    }


@router.get("/{name}/events")
async def log_events(name: str):
    """Stream appended log content as server-sent events."""
    path = _log_path(name)

    async def gen():
        pos = path.stat().st_size if path.is_file() else 0
        while True:
            if path.is_file():
                size = path.stat().st_size
                if size < pos:
                    pos = 0
                if size > pos:
                    with path.open("r", encoding="utf-8", errors="replace") as fh:
                        fh.seek(pos)
                        chunk = fh.read()
                        pos = fh.tell()
                    if chunk:
                        yield {"event": "append", "data": chunk}
            await asyncio.sleep(1.0)

    return EventSourceResponse(gen())
