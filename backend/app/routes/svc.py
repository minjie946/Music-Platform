"""SVC (voice conversion) endpoints: capabilities, voices, training.

These proxy to the SVC sidecar (:8002). Training samples uploaded from the UI
are saved to a temp dir and forwarded as multipart to the sidecar, which runs
the actual engine in its isolated environment.
"""
from __future__ import annotations

import shutil
import tempfile
import time
import uuid
import os
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import svc_client
from ..config import ensure_runtime_dirs, missing_runtime_dirs
from ..models import SvcCapabilities, SvcTrainStatus, SvcVoice
from ._uploads import save_upload

router = APIRouter(prefix="/api/svc", tags=["svc"])


@router.post("/service/restart")
def restart_service() -> dict:
    """Restart SVC sidecar. Packaged desktop launcher will bring it back."""
    _require_svc_dir()
    was_up = svc_client.health(timeout=1.0)
    if os.environ.get("MUSIC_STUDIO_RUNTIME_MODE") == "browser-dev":
        if was_up:
            return {"ok": True, "service_up": True, "restarting": False}
        return {
            "ok": True,
            "service_up": False,
            "restarting": False,
            "reason": "浏览器开发模式下 SVC 由 ./start.sh 管理。请重新运行 ./start.sh，或单独启动 svc_service。",
        }
    if was_up:
        svc_client.shutdown()
        for _ in range(20):
            time.sleep(0.1)
            if not svc_client.health(timeout=0.3):
                break
    # Give the desktop launcher a short window to re-spawn SVC with the latest
    # SVC_MODELS_DIR from runtime settings.
    for _ in range(30):
        time.sleep(0.2)
        if svc_client.health(timeout=0.5):
            return {"ok": True, "service_up": True, "restarting": False}
    return {"ok": True, "service_up": False, "restarting": True}


@router.get("/capabilities", response_model=SvcCapabilities)
def capabilities() -> SvcCapabilities:
    missing = missing_runtime_dirs(("svc_models_dir",))
    if missing:
        return SvcCapabilities(
            service_up=False,
            reason=f"请先在设置中配置目录：{'、'.join(missing)}。应用不会使用默认目录启动 SVC。",
        )
    data = svc_client.capabilities()
    if not data.get("service_up"):
        return SvcCapabilities(
            service_up=False,
            reason="SVC 音源服务未启动。请等待自动启动完成，或点击「重启加载 SVC」。",
        )
    return SvcCapabilities(
        service_up=True,
        device=data.get("device", "cpu"),
        engines=data.get("engines", {}),
    )


@router.get("/voices", response_model=list[SvcVoice])
def voices() -> list[SvcVoice]:
    if missing_runtime_dirs(("svc_models_dir",)):
        return []
    return [SvcVoice(**v) for v in svc_client.list_voices()]


@router.delete("/voices/{voice_id}")
def delete_voice(voice_id: str) -> dict:
    _require_svc_dir()
    if not svc_client.delete_voice(voice_id):
        raise HTTPException(status_code=404, detail="音源不存在或服务未启动")
    return {"ok": True, "voice_id": voice_id}


@router.get("/voices/{voice_id}/export")
def export_voice(voice_id: str, background_tasks: BackgroundTasks) -> FileResponse:
    _require_svc_dir()
    if not svc_client.health():
        raise HTTPException(status_code=503, detail="SVC 音源服务未启动：请等待自动启动完成，或点击「重启加载 SVC」。")
    tmp = Path(tempfile.mkdtemp(prefix="svc_voice_export_"))
    dest = tmp / f"{voice_id}.svcvoice.zip"
    try:
        path, filename = svc_client.export_voice(voice_id, dest)
    except svc_client.SvcError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    background_tasks.add_task(shutil.rmtree, tmp, True)
    return FileResponse(path, media_type="application/zip", filename=filename)


@router.post("/voices/import", response_model=SvcVoice)
async def import_voice(file: UploadFile = File(...)) -> SvcVoice:
    _require_svc_dir()
    if not svc_client.health():
        raise HTTPException(status_code=503, detail="SVC 音源服务未启动：请等待自动启动完成，或点击「重启加载 SVC」。")
    tmp = Path(tempfile.mkdtemp(prefix="svc_voice_import_"))
    suffix = Path(file.filename or "").suffix.lower()
    dest = tmp / f"voice{suffix or '.zip'}"
    try:
        await save_upload(file, dest)
        meta = svc_client.import_voice(dest)
        return SvcVoice(**meta)
    except svc_client.SvcError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@router.post("/voices/{voice_id}/preview")
async def preview_voice(
    voice_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    transpose: int = Form(0),
) -> FileResponse:
    _require_svc_dir()
    if not svc_client.health():
        raise HTTPException(status_code=503, detail="SVC 音源服务未启动：请等待自动启动完成，或点击「重启加载 SVC」。")

    voice = svc_client.get_voice(voice_id)
    if not voice:
        raise HTTPException(status_code=404, detail="音源不存在")
    if not voice.get("ready"):
        raise HTTPException(status_code=400, detail="音源尚未就绪，训练完成后才能试听")

    tmp = Path(tempfile.mkdtemp(prefix="svc_preview_"))
    suffix = Path(file.filename or "").suffix.lower() or ".wav"
    src = tmp / f"input{suffix}"
    dest = tmp / "preview.wav"
    try:
        await save_upload(file, src)
        try:
            svc_client.convert(src, voice_id, dest, transpose=transpose)
        except svc_client.SvcError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        background_tasks.add_task(shutil.rmtree, tmp, True)
        return FileResponse(dest, media_type="audio/wav", filename="svc-preview.wav")
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


@router.post("/train", response_model=SvcTrainStatus)
async def train(
    files: list[UploadFile] = File(...),
    name: str = Form(""),
    engine: str = Form("sovits"),
    max_epochs: int = Form(50),
) -> SvcTrainStatus:
    _require_svc_dir()
    if not svc_client.health():
        raise HTTPException(status_code=503, detail="SVC 音源服务未启动：请等待自动启动完成，或点击「重启加载 SVC」。")
    if not files:
        raise HTTPException(status_code=400, detail="请上传至少一段声音样本")

    tmp = Path(tempfile.mkdtemp(prefix="svc_train_"))
    saved: list[Path] = []
    try:
        for i, f in enumerate(files):
            suffix = Path(f.filename or "").suffix.lower() or ".wav"
            dest = tmp / f"sample_{i:03d}{suffix}"
            await save_upload(f, dest)
            saved.append(dest)
        try:
            res = svc_client.train(saved, name=name, engine=engine, max_epochs=max_epochs)
        except svc_client.SvcError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return SvcTrainStatus(
        train_id=res.get("train_id", uuid.uuid4().hex),
        voice_id=res.get("voice_id", ""),
        state="running",
        stage="已提交训练",
    )


@router.get("/train/{train_id}", response_model=SvcTrainStatus)
def train_status(train_id: str) -> SvcTrainStatus:
    _require_svc_dir()
    data = svc_client.train_status(train_id)
    if data is None:
        raise HTTPException(status_code=404, detail="训练任务不存在或服务未启动")
    return SvcTrainStatus(
        train_id=data.get("train_id", train_id),
        voice_id=data.get("voice_id", ""),
        state=data.get("state", "running"),
        progress=int(data.get("progress", 0)),
        stage=data.get("stage", ""),
        error=data.get("error", ""),
    )


def _require_svc_dir() -> None:
    try:
        ensure_runtime_dirs(("svc_models_dir",))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
