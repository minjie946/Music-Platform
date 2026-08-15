"""Redis-backed job store and progress pub/sub.

Job status is persisted as a JSON blob under `job:{id}`. Progress updates are
also published on a Redis channel `job-events:{id}` so the SSE endpoint can push
updates to the browser in real time.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import redis

from .config import settings
from .models import GenTrack, JobState, JobStatus, StemResult

_client: redis.Redis | None = None


def _use_file_store() -> bool:
    return os.environ.get("APP_DESKTOP_FILE_STORE") == "1" or settings.redis_url == "filesystem://"


def _jobs_dir() -> Path:
    path = settings.data_dir / "jobs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _file_key_path(key: str) -> Path:
    safe = key.replace(":", "_").replace("/", "_").replace("\\", "_")
    return _jobs_dir() / f"{safe}.json"


def _file_save_job(job: JobStatus) -> None:
    path = _file_key_path(_key(job.id))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(job.model_dump_json(), "utf-8")
    tmp.replace(path)


def _file_load_job(job_id: str) -> JobStatus | None:
    path = _file_key_path(_key(job_id))
    if not path.is_file():
        return None
    try:
        return JobStatus.model_validate_json(path.read_text("utf-8"))
    except Exception:
        return None


def client() -> redis.Redis:
    if _use_file_store():
        raise RuntimeError("Redis client is not available when desktop file store is enabled")
    global _client
    if _client is None:
        _client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    return _client


def ping() -> bool:
    """Return True if Redis is reachable."""
    if _use_file_store():
        return True
    try:
        return bool(client().ping())
    except Exception:
        return False


def _key(job_id: str) -> str:
    return f"job:{job_id}"


def _channel(job_id: str) -> str:
    return f"job-events:{job_id}"


def create_job(
    job_id: str,
    original_filename: str,
    requested_stems: list[str],
    engine: str,
    output_format: str = "wav",
) -> JobStatus:
    now = time.time()
    job = JobStatus(
        id=job_id,
        state=JobState.queued,
        progress=0,
        stage="排队中",
        engine=engine,
        requested_stems=requested_stems,
        output_format=output_format,
        original_filename=original_filename,
        created_at=now,
        updated_at=now,
    )
    _save(job)
    return job


def create_gen_job(job_id: str, title: str, engine: str = "acestep") -> JobStatus:
    now = time.time()
    job = JobStatus(
        id=job_id,
        state=JobState.queued,
        progress=0,
        stage="排队中",
        engine=engine,
        kind="generation",
        title=title,
        created_at=now,
        updated_at=now,
    )
    _save(job)
    return job


def create_init_job(job_id: str) -> JobStatus:
    now = time.time()
    job = JobStatus(
        id=job_id,
        state=JobState.queued,
        progress=0,
        stage="准备初始化",
        engine="acestep",
        kind="init",
        title="模型初始化",
        created_at=now,
        updated_at=now,
    )
    _save(job)
    return job


def rename_gen_job(job_id: str, title: str) -> None:
    """Update the title of a generation job in Redis (if it still exists)."""
    job = get_job(job_id)
    if job is None or job.kind != "generation":
        return
    job.title = title
    _save(job)


def mark_done_simple(job_id: str, stage: str = "完成") -> None:
    job = get_job(job_id)
    if job is None:
        return
    job.state = JobState.done
    job.progress = 100
    job.stage = stage
    _save(job)


def mark_gen_done(job_id: str, tracks: list[GenTrack]) -> None:
    job = get_job(job_id)
    if job is None:
        return
    job.state = JobState.done
    job.progress = 100
    job.stage = "完成"
    job.tracks = tracks
    _save(job)


def _save(job: JobStatus) -> None:
    job.updated_at = time.time()
    if _use_file_store():
        _file_save_job(job)
        return
    ttl = settings.job_ttl_hours * 3600
    c = client()
    c.set(_key(job.id), job.model_dump_json(), ex=ttl)
    c.publish(_channel(job.id), job.model_dump_json())


def get_job(job_id: str) -> JobStatus | None:
    if _use_file_store():
        return _file_load_job(job_id)
    raw = client().get(_key(job_id))
    if raw is None:
        return None
    return JobStatus.model_validate_json(raw)


def update_progress(job_id: str, progress: int, stage: str) -> None:
    job = get_job(job_id)
    if job is None:
        return
    job.state = JobState.running
    job.progress = max(job.progress, progress)
    job.stage = stage
    _save(job)


def mark_done(job_id: str, stems: list[StemResult]) -> None:
    job = get_job(job_id)
    if job is None:
        return
    job.state = JobState.done
    job.progress = 100
    job.stage = "完成"
    job.stems = stems
    _save(job)


def mark_failed(job_id: str, error: str) -> None:
    job = get_job(job_id)
    if job is None:
        return
    job.state = JobState.failed
    job.stage = "失败"
    job.error = error
    _save(job)


_INIT_KEY = "acestep:init_job"


def set_init_job_id(job_id: str) -> None:
    if _use_file_store():
        path = _file_key_path(_INIT_KEY)
        path.write_text(json.dumps({"job_id": job_id}), "utf-8")
        return
    try:
        client().set(_INIT_KEY, job_id, ex=24 * 3600)
    except Exception:
        pass


def get_init_job_id() -> str | None:
    if _use_file_store():
        path = _file_key_path(_INIT_KEY)
        if not path.is_file():
            return None
        try:
            return str(json.loads(path.read_text("utf-8")).get("job_id") or "") or None
        except Exception:
            return None
    try:
        return client().get(_INIT_KEY)
    except Exception:
        return None


def subscribe(job_id: str) -> redis.client.PubSub:
    if _use_file_store():
        raise RuntimeError("PubSub is not available when desktop file store is enabled")
    pubsub = client().pubsub()
    pubsub.subscribe(_channel(job_id))
    return pubsub
