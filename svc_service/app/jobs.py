"""In-memory training job registry (one sidecar process, threaded training)."""
from __future__ import annotations

import threading
import time

_lock = threading.Lock()
_jobs: dict[str, dict] = {}


def create(train_id: str, voice_id: str) -> dict:
    with _lock:
        job = {
            "train_id": train_id,
            "voice_id": voice_id,
            "state": "queued",  # queued | running | done | failed
            "progress": 0,
            "stage": "排队中",
            "error": "",
            "updated_at": time.time(),
        }
        _jobs[train_id] = job
        return dict(job)


def update(train_id: str, **fields) -> None:
    with _lock:
        job = _jobs.get(train_id)
        if not job:
            return
        job.update(fields)
        job["updated_at"] = time.time()


def get(train_id: str) -> dict | None:
    with _lock:
        job = _jobs.get(train_id)
        return dict(job) if job else None
