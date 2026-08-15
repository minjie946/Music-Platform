"""Job lifecycle endpoints: create, status, SSE progress, download-all."""
from __future__ import annotations

import asyncio
import io
import json
import shutil
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sse_starlette.sse import EventSourceResponse

from .. import store
from ..config import effective_separation_dir, effective_uploads_dir, ensure_runtime_dirs, missing_runtime_dirs, settings
from ..models import JobState, JobStatus, StemResult
from ..stems import STEM_BY_ID, is_valid_stem

router = APIRouter(prefix="/api/jobs", tags=["jobs"])

CHUNK = 1024 * 1024


def _history_job(job_id: str) -> JobStatus | None:
    """Load a finished separation job from durable output files."""
    if missing_runtime_dirs(("separation_output_dir",)):
        return None
    if not job_id or "/" in job_id or "\\" in job_id:
        return None
    d = effective_separation_dir() / job_id
    if not d.is_dir():
        return None

    meta = d / "job.json"
    if meta.is_file():
        try:
            return JobStatus.model_validate_json(meta.read_text("utf-8"))
        except Exception:
            pass

    stems: list[StemResult] = []
    for p in sorted(d.iterdir(), key=lambda x: x.name):
        if not p.is_file() or p.suffix.lower() not in {".mp3", ".wav"}:
            continue
        stem_id = p.stem
        if stem_id not in STEM_BY_ID:
            stem_id = p.stem
        meta_def = STEM_BY_ID.get(stem_id)
        stems.append(
            StemResult(
                stem=stem_id,
                label_zh=meta_def.label_zh if meta_def else stem_id,
                label_en=meta_def.label_en if meta_def else stem_id,
                filename=p.name,
                url=f"/api/stems/{job_id}/{stem_id}",
                size_bytes=p.stat().st_size,
            )
        )
    if not stems:
        return None
    created = d.stat().st_mtime
    return JobStatus(
        id=job_id,
        state=JobState.done,
        progress=100,
        stage="完成",
        original_filename=job_id,
        created_at=created,
        updated_at=created,
        stems=stems,
    )


def _history_stem_path(job_id: str, stem_id: str) -> tuple[Path, StemResult] | None:
    job = _history_job(job_id)
    if job is None:
        return None
    match = next((s for s in job.stems if s.stem == stem_id), None)
    if match is None:
        return None
    fpath = effective_separation_dir() / job_id / match.filename
    if not fpath.is_file():
        return None
    return fpath, match


@router.post("", response_model=JobStatus)
async def create_job(
    file: UploadFile = File(...),
    stems: str = Form(...),
    engine: str | None = Form(None),
    output_format: str = Form("wav"),
) -> JobStatus:
    try:
        ensure_runtime_dirs(("separation_output_dir", "uploads_dir"))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Validate extension.
    ext = Path(file.filename or "").suffix.lower()
    if ext not in settings.allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件格式 {ext}，允许: {', '.join(settings.allowed_extensions)}",
        )

    # Validate requested stems.
    try:
        requested = json.loads(stems)
        assert isinstance(requested, list)
    except Exception:
        raise HTTPException(status_code=400, detail="stems 参数必须是 JSON 数组")
    requested = [s for s in requested if is_valid_stem(s)]
    if not requested:
        raise HTTPException(status_code=400, detail="未选择任何有效的分轨类型")

    # Fail fast with a clear message if the task infrastructure isn't up.
    if not store.ping():
        raise HTTPException(
            status_code=503,
            detail="任务队列未连接：请重启应用；浏览器开发模式请运行 ./start.sh"
            "（或 python run_local.py），不要单独运行 uvicorn。",
        )

    job_id = uuid.uuid4().hex
    upload_dir = effective_uploads_dir() / job_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / Path(file.filename or "input").name

    # Stream to disk with a size cap.
    max_bytes = settings.max_upload_mb * 1024 * 1024
    written = 0
    with open(dest, "wb") as out:
        while True:
            chunk = await file.read(CHUNK)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"文件超过大小上限 {settings.max_upload_mb}MB",
                )
            out.write(chunk)

    from ..config import load_runtime_settings

    effective_engine = engine or load_runtime_settings().default_engine
    fmt = "mp3" if str(output_format).lower() == "mp3" else "wav"
    job = store.create_job(job_id, file.filename or "input", requested, effective_engine, fmt)

    # Enqueue the heavy work in Celery.
    from ..celery_app import celery_app

    celery_app.send_task("app.tasks.run_separation", args=[job_id])
    return job


@router.get("/history", response_model=list[JobStatus])
def history(limit: int = 200) -> list[JobStatus]:
    """List finished separation jobs from durable output files, newest first."""
    if missing_runtime_dirs(("separation_output_dir",)):
        return []
    out_root = effective_separation_dir()
    items = _scan_separation_history(str(out_root))
    return items[:limit]


# 分轨历史全量扫盘较重（每目录读 job.json / stat 文件）。前端 15s 轮询会反复触发，
# 故加短 TTL 缓存：目录 mtime 未变且未过期则复用上次扫描结果。
_HISTORY_CACHE: dict = {"key": None, "at": 0.0, "items": []}
_HISTORY_TTL = 8.0


def _scan_separation_history(out_root_str: str) -> list[JobStatus]:
    import time as _time

    out_root = Path(out_root_str)
    if not out_root.is_dir():
        return []
    try:
        dir_mtime = out_root.stat().st_mtime
    except OSError:
        dir_mtime = 0.0
    now = _time.time()
    cache = _HISTORY_CACHE
    if (
        cache["key"] == (out_root_str, dir_mtime)
        and (now - cache["at"]) < _HISTORY_TTL
    ):
        return cache["items"]

    items: list[JobStatus] = []
    for d in out_root.iterdir():
        if not d.is_dir():
            continue
        item = _history_job(d.name)
        if item is not None and item.state == JobState.done:
            items.append(item)
    items.sort(key=lambda it: it.created_at or it.updated_at, reverse=True)
    cache["key"] = (out_root_str, dir_mtime)
    cache["at"] = now
    cache["items"] = items
    return items


@router.get("/{job_id}", response_model=JobStatus)
def get_status(job_id: str) -> JobStatus:
    job = store.get_job(job_id)
    if job is None:
        job = _history_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    return job


@router.get("/{job_id}/events")
async def job_events(job_id: str):
    job = store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")

    async def event_generator():
        # 优先用 Redis pubsub 事件驱动（_save 时已 publish），避免每 0.5s 轮询 GET；
        # 文件存储模式或 pubsub 不可用时回退到轮询。两种方式都不阻塞事件循环。
        last_signature: tuple | None = None

        def _emit_if_changed(current):
            nonlocal last_signature
            sig = (current.state, current.progress, current.stage, len(current.stems))
            if sig != last_signature:
                last_signature = sig
                return {"event": "status", "data": current.model_dump_json()}
            return None

        pubsub = None
        try:
            pubsub = store.subscribe(job_id)
        except Exception:
            pubsub = None

        try:
            # 先推一次当前快照。
            current = store.get_job(job_id)
            if current is None:
                yield {"event": "error", "data": "job not found"}
                return
            msg = _emit_if_changed(current)
            if msg:
                yield msg
            if current.state in (JobState.done, JobState.failed):
                return

            loop = asyncio.get_event_loop()
            while True:
                if pubsub is not None:
                    # 阻塞等待放到线程池，最多等 1s（兼作心跳/兜底刷新）。
                    try:
                        await loop.run_in_executor(
                            None, lambda: pubsub.get_message(timeout=1.0)
                        )
                    except Exception:
                        await asyncio.sleep(0.5)
                else:
                    await asyncio.sleep(0.5)

                current = store.get_job(job_id)
                if current is None:
                    yield {"event": "error", "data": "job not found"}
                    return
                msg = _emit_if_changed(current)
                if msg:
                    yield msg
                if current.state in (JobState.done, JobState.failed):
                    return
        finally:
            if pubsub is not None:
                try:
                    pubsub.close()
                except Exception:
                    pass

    return EventSourceResponse(event_generator())


@router.get("/{job_id}/download-all")
def download_all(job_id: str):
    try:
        ensure_runtime_dirs(("separation_output_dir",))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    job = store.get_job(job_id)
    if job is None:
        job = _history_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    if job.state != JobState.done or not job.stems:
        raise HTTPException(status_code=409, detail="任务尚未完成")

    out_dir = effective_separation_dir() / job_id

    def iter_zip():
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for stem in job.stems:
                fpath = out_dir / stem.filename
                if fpath.exists():
                    zf.write(fpath, arcname=stem.filename)
        buf.seek(0)
        yield from iter(lambda: buf.read(CHUNK), b"")

    base = Path(job.original_filename).stem or "stems"
    headers = {"Content-Disposition": f'attachment; filename="{base}_stems.zip"'}
    return StreamingResponse(iter_zip(), media_type="application/zip", headers=headers)


@router.delete("/history/{job_id}", status_code=204)
def delete_history(job_id: str):
    try:
        ensure_runtime_dirs(("separation_output_dir",))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not job_id or "/" in job_id or "\\" in job_id:
        raise HTTPException(status_code=400, detail="无效任务 ID")
    out_dir = effective_separation_dir() / job_id
    if not out_dir.is_dir():
        raise HTTPException(status_code=404, detail="分离记录不存在")
    shutil.rmtree(out_dir)
    return None
