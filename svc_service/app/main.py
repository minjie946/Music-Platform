"""SVC sidecar REST API (so-vits-svc).

Endpoints (all under the service root, default :8002):
    GET    /health
    GET    /capabilities          per-engine infer/train availability + device
    GET    /voices                trained voice models
    POST   /convert               (multipart) vocal wav + voice_id -> converted wav
    POST   /train                 (multipart) samples + name + engine -> {train_id}
    GET    /train/{train_id}       training job status
    DELETE /voices/{voice_id}
"""
from __future__ import annotations

import os
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from . import jobs, voices
from . import pretrained
from .config import detect_device, use_offline_pretrained, work_dir
from .engines import ENGINES, get_engine
from .engines.base import SvcEngineError

# 优先使用已就位的本地权重（存在则强制离线）；缺失则后台自动下载，不阻塞启动。
use_offline_pretrained()
pretrained.ensure_async()

app = FastAPI(title="SVC 音源服务", version="0.1.0")


def log_train(train_id: str, message: str) -> None:
    print(f"[svc-train:{train_id}] {message}", flush=True)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/pretrained")
def pretrained_status() -> dict:
    """权重就绪 / 下载状态；前端可据此提示"正在下载模型"。"""
    st = pretrained.status()
    st["ready"] = pretrained.all_ready()
    st["dir"] = str(pretrained.config.pretrained_dir())
    return st


@app.post("/pretrained/retry")
def pretrained_retry() -> dict:
    """手动重试下载（例如首次下载因网络失败后）。"""
    pretrained.ensure_async()
    return pretrained.status()


@app.post("/service/shutdown")
def shutdown() -> dict:
    """Exit after responding so the desktop launcher can restart this sidecar."""
    def _exit() -> None:
        os._exit(0)

    threading.Timer(0.2, _exit).start()
    return {"ok": True, "shutting_down": True}


@app.get("/capabilities")
def capabilities() -> dict:
    device = detect_device()
    engines = {}
    for name in ENGINES:
        eng = get_engine(name)
        try:
            train_ok, note = eng.train_available(device)
        except Exception as exc:  # pragma: no cover
            train_ok, note = False, str(exc)
        engines[name] = {
            "infer_available": bool(eng.infer_available()),
            "train_available": bool(train_ok),
            "note": note,
        }
    return {"device": device, "engines": engines}


@app.get("/voices")
def list_voices() -> list[dict]:
    return voices.list_voices()


@app.delete("/voices/{voice_id}")
def delete_voice(voice_id: str) -> dict:
    if not voices.delete_voice(voice_id):
        raise HTTPException(status_code=404, detail="音源不存在")
    return {"ok": True, "voice_id": voice_id}


@app.get("/voices/{voice_id}/export")
def export_voice(voice_id: str) -> FileResponse:
    meta = voices.get_meta(voice_id)
    vdir = voices.voice_dir(voice_id)
    if not meta or not vdir:
        raise HTTPException(status_code=404, detail="音源不存在")
    tmp = Path(tempfile.mkdtemp(prefix="svc_voice_export_"))
    safe_name = _safe_filename(str(meta.get("name") or voice_id))
    archive = tmp / f"{safe_name}_{voice_id[:8]}.svcvoice.zip"
    with ZipFile(archive, "w", ZIP_DEFLATED) as zf:
        for item in voices.export_files(vdir):
            zf.write(item, item.relative_to(vdir).as_posix())
    print(f"[svc-voice-export] voice_id={voice_id} archive={archive} size={archive.stat().st_size}", flush=True)
    return FileResponse(
        archive,
        media_type="application/zip",
        filename=archive.name,
        background=BackgroundCleanup(tmp),
    )


@app.post("/voices/import")
async def import_voice(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix != ".zip":
        raise HTTPException(status_code=400, detail="请上传 .zip 格式的 SVC 音源包")
    tmp = Path(tempfile.mkdtemp(prefix="svc_voice_import_"))
    archive = tmp / "voice.zip"
    try:
        await _save_upload(file, archive)
        extract_dir = tmp / "voice"
        extract_dir.mkdir(parents=True, exist_ok=True)
        _safe_extract_zip(archive, extract_dir)
        meta = voices.import_voice(extract_dir)
        print(f"[svc-voice-import] imported voice_id={meta.get('id')} name={meta.get('name')}", flush=True)
        return meta
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def _save_upload(file: UploadFile, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "wb") as f:
        while True:
            chunk = await file.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
    return dest


class BackgroundCleanup:
    def __init__(self, path: Path) -> None:
        self.path = path

    async def __call__(self) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


def _safe_filename(name: str) -> str:
    value = "".join(c if c.isalnum() or c in ("-", "_", ".") else "_" for c in name).strip("._")
    return value[:80] or "svc_voice"


def _safe_extract_zip(archive: Path, dest: Path) -> None:
    root = dest.resolve()
    with ZipFile(archive) as zf:
        for member in zf.infolist():
            target = (dest / member.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError("导入包包含非法路径")
        zf.extractall(dest)


@app.post("/convert")
async def convert(
    file: UploadFile = File(...),
    voice_id: str = Form(...),
    transpose: int = Form(0),
) -> FileResponse:
    meta = voices.get_meta(voice_id)
    if not meta:
        raise HTTPException(status_code=404, detail="音源不存在")
    vdir = voices.voice_dir(voice_id)
    engine = get_engine(meta.get("engine", "sovits"))

    work = work_dir() / "convert" / uuid.uuid4().hex
    in_wav = work / ("input" + (Path(file.filename or "").suffix.lower() or ".wav"))
    out_wav = work / "converted.wav"
    await _save_upload(file, in_wav)
    try:
        engine.convert(in_wav, vdir, out_wav, detect_device(), transpose=int(transpose))
    except SvcEngineError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"转换出错: {exc}")
    return FileResponse(out_wav, media_type="audio/wav", filename="converted.wav")


@app.post("/train")
async def train(
    files: list[UploadFile] = File(...),
    name: str = Form(""),
    engine: str = Form("sovits"),
    max_epochs: int = Form(50),
) -> dict:
    engine = (engine or "sovits").lower()
    if engine not in ENGINES:
        raise HTTPException(status_code=400, detail=f"未知引擎: {engine}")
    eng = get_engine(engine)
    train_ok, note = eng.train_available(detect_device())
    if not train_ok:
        raise HTTPException(status_code=400, detail=note or "该引擎当前不支持训练")
    if not files:
        raise HTTPException(status_code=400, detail="请上传至少一段声音样本")

    meta = voices.create_voice(name, engine)
    vid = meta["id"]
    vdir = voices.voice_dir(vid)
    sample_dir = vdir / "samples"
    saved: list[Path] = []
    for i, f in enumerate(files):
        suffix = Path(f.filename or "").suffix.lower() or ".wav"
        saved.append(await _save_upload(f, sample_dir / f"sample_{i:03d}{suffix}"))

    train_id = uuid.uuid4().hex
    jobs.create(train_id, vid)
    log_train(
        train_id,
        f"已创建训练任务 voice_id={vid} name={meta.get('name') or ''} engine={engine} samples={len(saved)} max_epochs={max_epochs}",
    )

    def _run() -> None:
        jobs.update(train_id, state="running", stage="准备样本", progress=5)
        log_train(train_id, "开始训练：准备样本")

        def cb(pct: int, stage: str) -> None:
            jobs.update(train_id, progress=int(pct), stage=stage)
            log_train(train_id, f"进度 {int(pct)}%：{stage}")

        try:
            eng.train(saved, vdir, detect_device(), cb, max_epochs=int(max_epochs) or None)
            voices.mark_ready(vid, True)
            jobs.update(train_id, state="done", progress=100, stage="完成")
            log_train(train_id, "训练完成，音源已就绪")
        except Exception as exc:
            voices.mark_ready(vid, False)
            jobs.update(train_id, state="failed", error=str(exc), stage="失败")
            log_train(train_id, f"训练失败：{exc}")

    threading.Thread(target=_run, daemon=True).start()
    return {"train_id": train_id, "voice_id": vid}


@app.get("/train/{train_id}")
def train_status(train_id: str) -> dict:
    job = jobs.get(train_id)
    if not job:
        raise HTTPException(status_code=404, detail="训练任务不存在")
    return job
