"""Single-stem playback/download endpoint."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import store
from ..config import effective_separation_dir, ensure_runtime_dirs
from .jobs import _history_stem_path

router = APIRouter(prefix="/api/stems", tags=["stems"])

_MEDIA = {".mp3": "audio/mpeg", ".wav": "audio/wav"}


@router.get("/{job_id}/{stem_id}")
def get_stem(job_id: str, stem_id: str, download: bool = False):
    try:
        ensure_runtime_dirs(("separation_output_dir",))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    job = store.get_job(job_id)
    if job is None:
        history_match = _history_stem_path(job_id, stem_id)
        if history_match is None:
            raise HTTPException(status_code=404, detail="任务不存在或已过期")
        fpath, match = history_match
    else:
        match = next((s for s in job.stems if s.stem == stem_id), None)
        if match is None:
            raise HTTPException(status_code=404, detail="分轨不存在")

        fpath = effective_separation_dir() / job_id / match.filename
        if not fpath.exists():
            raise HTTPException(status_code=404, detail="分轨文件已被清理")

    media_type = _MEDIA.get(Path(match.filename).suffix.lower(), "application/octet-stream")
    # FileResponse supports HTTP range requests, enabling streamed playback.
    filename = match.filename if download else None
    return FileResponse(fpath, media_type=media_type, filename=filename)
