"""Music generation endpoints (ACE-Step sidecar).

Mirrors the separation job flow: create -> status -> SSE progress -> download.
Heavy generation runs in the same Celery worker via `app.tasks.run_generation`.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .. import acestep_client as ace
from .. import acestep_guard
from .. import acestep_service
from .. import hardware, store
from ..config import (
    configured_runtime_dir_text,
    effective_checkpoints_dir,
    effective_generation_dir,
    effective_history_dir,
    effective_uploads_dir,
    ensure_runtime_dirs,
    missing_runtime_dirs,
    settings,
)
from ..config import load_runtime_settings, save_runtime_settings
from ..models import (
    GenerationCapabilities,
    GenerationParams,
    GenHistoryItem,
    GenHistoryTrack,
    GenModelInfo,
    GenModelOption,
    InitRequest,
    JobState,
    JobStatus,
    LoraDownloadRequest,
    LoraItem,
    LoraListResponse,
)
from .. import lora_catalog, lora_service
from ._uploads import save_upload

router = APIRouter(prefix="/api/generation", tags=["generation"])

_MEDIA = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".opus": "audio/opus",
    ".aac": "audio/aac",
}

_ACE_REQUIRED_DIRS = (
    "acestep_checkpoints_dir",
    "generation_output_dir",
    "history_output_dir",
    "acestep_tmp_dir",
    "uploads_dir",
)
_FFMPEG_REQUIRED_FORMATS = {"mp3", "opus", "aac"}


def _ffmpeg_available() -> bool:
    explicit = os.environ.get("APP_FFMPEG_EXE", "").strip()
    if explicit and Path(explicit).expanduser().is_file():
        return True
    if shutil.which("ffmpeg"):
        return True
    # 项目内 vendor（向后兼容）+ 可配置的外置 vendor 目录都探测一遍。
    root = Path(__file__).resolve().parents[3]
    candidates = [root / "vendor" / "ffmpeg-env" / "bin" / "ffmpeg"]
    for base in _configurable_vendor_dirs():
        candidates.append(base / "ffmpeg-env" / "bin" / "ffmpeg")
    return any(c.is_file() for c in candidates)


def _configurable_vendor_dirs() -> list[Path]:
    """外置 vendor 目录候选：VENDOR_DIR 环境变量 / settings.vendor_dir / <workspace>/vendor。"""
    dirs: list[Path] = []
    env = os.environ.get("VENDOR_DIR", "").strip()
    if env:
        dirs.append(Path(env).expanduser())
    try:
        from ..config import load_runtime_settings, workspace_dir

        rs = load_runtime_settings()
        if rs.vendor_dir.strip():
            dirs.append(Path(rs.vendor_dir).expanduser())
        ws = workspace_dir(rs)
        if ws is not None:
            dirs.append(ws / "vendor")
    except Exception:
        pass
    return dirs


def _require_ace_dirs() -> None:
    try:
        ensure_runtime_dirs(_ACE_REQUIRED_DIRS)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _model_path(checkpoints_dir: Path | None, model_name: str | None) -> str:
    name = (model_name or "").strip()
    if not name or checkpoints_dir is None:
        return ""
    path = Path(name).expanduser()
    if path.is_absolute():
        return str(path)
    return str(checkpoints_dir / name)


def _generation_roots() -> list[Path]:
    if missing_runtime_dirs(("history_output_dir", "generation_output_dir")):
        return []
    return [effective_history_dir(), effective_generation_dir()]


def _song_path(job_id: str, filename: str) -> Path | None:
    """Resolve a generated file: prefer the history archive, fall back to the
    cache dir (for jobs that haven't been archived or whose move failed).

    Both `job_id` and `filename` are user-controlled on some routes, so each
    resolved path is confirmed to stay inside `<root>/<job_id>/` to block
    path traversal (e.g. name="../../etc/passwd").
    """
    job_id = (job_id or "").strip()
    if not job_id or "/" in job_id or "\\" in job_id:
        return None
    name = (filename or "").strip()
    if not name or "/" in name or "\\" in name:
        return None
    for root in _generation_roots():
        job_dir = (root / job_id).resolve()
        if job_dir.parent != root.resolve():
            continue
        p = (job_dir / name).resolve()
        if p.parent == job_dir and p.is_file():
            return p
    return None


def _history_job_dir(job_id: str) -> Path | None:
    """Resolve a history/cache job directory without allowing path traversal."""
    job_id = (job_id or "").strip()
    if not job_id or "/" in job_id or "\\" in job_id:
        return None
    for root in _generation_roots():
        base = (root / job_id).resolve()
        if base.parent == root.resolve() and base.is_dir():
            return base
    return None


def _history_track_by_index(job_id: str, index: int) -> Path | None:
    """Resolve a generated audio file from durable history/cache by 1-based index."""
    d = _history_job_dir(job_id)
    if d is None:
        return None
    audio = sorted(
        (p for p in d.iterdir() if p.is_file() and p.suffix.lower() in _MEDIA),
        key=lambda p: p.name,
    )
    if index < 1 or index > len(audio):
        return None
    return audio[index - 1]


def _staging_dir() -> Path:
    """Holding area for user-uploaded reference/source audio before a job runs."""
    d = effective_uploads_dir() / "generation_staging"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _consume_staged(token: str, dest_dir: Path, prefix: str) -> Path | None:
    """Move a staged upload (by token) into the job dir; return its new path."""
    token = (token or "").strip()
    if not token or "/" in token or "\\" in token:
        return None
    src_dir = _staging_dir() / token
    if not src_dir.is_dir():
        return None
    files = [p for p in src_dir.iterdir() if p.is_file()]
    if not files:
        return None
    src = files[0]
    dest = dest_dir / f"{prefix}{src.suffix.lower()}"
    try:
        shutil.move(str(src), str(dest))
        shutil.rmtree(src_dir, ignore_errors=True)
    except Exception:
        return None
    return dest


def _resolve_dit(rs, hw) -> str:
    """Currently selected DiT model: runtime override else hardware recommend."""
    return (rs.gen_dit_model or "").strip() or hw.recommended.dit_model


def _resolve_lm(rs, hw) -> str:
    """Currently selected LM as a catalog value ("none" or a model name)."""
    sel = (rs.gen_lm_model or "").strip()
    if sel:
        return sel
    return hw.recommended.lm_model or "none"


def _model_options(hw, selected_dit: str, selected_lm: str):
    """Build DiT/LM option lists with recommended + selected flags from catalogs."""
    rec_dit = hw.recommended.dit_model
    rec_lm = hw.recommended.lm_model or "none"
    dit_opts = [
        GenModelOption(name=n, label=lbl, recommended=(n == rec_dit))
        for n, lbl in hardware.DIT_CATALOG
    ]
    # Ensure the selected DiT is present even if not in the catalog.
    if selected_dit and selected_dit not in {o.name for o in dit_opts}:
        dit_opts.append(GenModelOption(name=selected_dit, label=selected_dit))
    lm_opts = [
        GenModelOption(name=n, label=lbl, recommended=(n == rec_lm))
        for n, lbl in hardware.LM_CATALOG
    ]
    return dit_opts, lm_opts


def _init_running() -> bool:
    jid = store.get_init_job_id()
    if not jid:
        return False
    j = store.get_job(jid)
    return bool(j and j.state in (JobState.queued, JobState.running))


@router.get("/capabilities", response_model=GenerationCapabilities)
def capabilities() -> GenerationCapabilities:
    hw = hardware.detect()
    rs = load_runtime_settings()
    performance_mode = hardware.normalize_performance_mode(rs.generation_performance_mode)
    hardware.apply_performance_mode(hw, performance_mode)
    allow_cpu = settings.allow_cpu_generation
    gen_ok = hw.generation_available or (hw.device == "cpu" and allow_cpu)
    selected_dit = _resolve_dit(rs, hw)
    selected_lm = _resolve_lm(rs, hw)
    dit_options, lm_options = _model_options(hw, selected_dit, selected_lm)
    missing_dirs = missing_runtime_dirs(_ACE_REQUIRED_DIRS, rs)
    dirs_ready = not missing_dirs
    ffmpeg_available = _ffmpeg_available()

    detail = ace.health_detail() if dirs_ready else {"service_up": False, "models_initialized": False}
    service_up = bool(detail.get("service_up"))
    ckpt_dir = effective_checkpoints_dir(rs) if dirs_ready else None
    selected_lm_model = None if selected_lm == "none" else selected_lm
    downloaded = (
        ace.model_downloaded(ckpt_dir, dit_model=selected_dit, lm_model=selected_lm_model)
        if ckpt_dir is not None
        else False
    )
    loaded_dit = detail.get("loaded_model") or ""
    loaded_lm = detail.get("loaded_lm_model") or ""
    loaded_in_memory = bool(detail.get("models_initialized"))
    selected_lm_ready = selected_lm == "none" or bool(loaded_lm)
    model_ready = loaded_in_memory and downloaded and selected_lm_ready
    initializing = _init_running()

    # Avoid calling /v1/models before initialization: ACE-Step may trigger its
    # internal model checks/downloads from that route and fall back to defaults.
    models = [GenModelInfo(name=m.get("name", ""), is_default=bool(m.get("is_default")))
              for m in ace.list_models()] if service_up and model_ready else []

    reason = ""
    if missing_dirs:
        reason = f"请先在设置中配置目录：{'、'.join(missing_dirs)}。应用不会使用默认目录启动 ACE-Step。"
    elif not gen_ok:
        reason = hw.generation_note
    elif not service_up:
        reason = "ACE-Step 服务未启动。打开生成页后可按需启动；首次请先设置模型目录再开始下载。"
    elif service_up and loaded_in_memory and not downloaded:
        if selected_lm_model and ckpt_dir is not None and not ace.component_downloaded(ckpt_dir, selected_lm_model):
            reason = f"当前选择的 LM 模型未下载：{selected_lm_model}。请重新初始化下载该 LM，或在设置中选择「不使用 LM」。"
        else:
            reason = "当前配置的模型目录未发现完整模型文件。请点击「保存并重启服务」后重新初始化，模型会下载到你设置的目录。"
    elif service_up and loaded_in_memory and not selected_lm_ready:
        reason = f"当前选择的 LM 模型尚未加载：{selected_lm_model}。请重新初始化，或在设置中选择「不使用 LM」。"
    elif not model_ready:
        if downloaded:
            reason = "模型已下载但尚未加载，请点击「初始化」完成加载后再生成。"
        else:
            reason = "首次使用需要下载大模型（数 GB）。请点击「初始化」开始下载。"

    return GenerationCapabilities(
        available=dirs_ready and gen_ok and service_up and model_ready,
        reason=reason,
        service_up=service_up,
        model_downloaded=downloaded,
        model_ready=model_ready,
        initializing=initializing,
        device=hw.device,
        gpu_name=hw.gpu_name,
        vram_gb=hw.vram_gb,
        ram_gb=hw.ram_gb,
        os=hw.os,
        arch=hw.arch,
        recommended_dit=hw.recommended.dit_model,
        recommended_lm=hw.recommended.lm_model,
        max_batch_size=hw.recommended.max_batch_size,
        max_duration_sec=hardware.MAX_DURATION_SEC,
        models=models,
        dit_options=dit_options,
        lm_options=lm_options,
        selected_dit=selected_dit,
        selected_lm=selected_lm,
        loaded_dit=loaded_dit,
        loaded_lm=loaded_lm,
        loaded_dit_path=_model_path(ckpt_dir, loaded_dit or selected_dit),
        loaded_lm_path=_model_path(ckpt_dir, loaded_lm or (selected_lm if selected_lm != "none" else "")),
        ffmpeg_available=ffmpeg_available,
        performance_mode=performance_mode,
        model_configured=bool((rs.gen_dit_model or "").strip()) and dirs_ready,
        checkpoints_dir=configured_runtime_dir_text("acestep_checkpoints_dir", rs),
        output_dir=configured_runtime_dir_text("generation_output_dir", rs),
    )


@router.post("/service/start")
def start_service() -> dict:
    """Start the ACE-Step sidecar on demand."""
    _require_ace_dirs()
    hw = hardware.detect()
    rs = load_runtime_settings()
    hardware.apply_performance_mode(hw, rs.generation_performance_mode)
    gen_ok = hw.generation_available or (hw.device == "cpu" and settings.allow_cpu_generation)
    if not gen_ok:
        raise HTTPException(status_code=400, detail=hw.generation_note or "当前硬件不支持音乐生成")
    result = acestep_service.start()
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("error") or "启动 ACE-Step 服务失败")
    return result


@router.post("/service/stop")
def stop_service() -> dict:
    """Stop the ACE-Step sidecar so path/model changes take effect next start."""
    result = acestep_service.stop()
    store.set_init_job_id("")
    return result


@router.post("/service/restart")
def restart_service() -> dict:
    """Restart the ACE-Step sidecar so path/model changes take effect."""
    _require_ace_dirs()
    store.set_init_job_id("")
    result = acestep_service.restart()
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("error") or "重启 ACE-Step 服务失败")
    return result


@router.post("/initialize", response_model=JobStatus)
def initialize(payload: InitRequest | None = None) -> JobStatus:
    """Trigger ACE-Step to download (if missing) + load models. Returns an init job.

    Optionally accepts {dit_model, lm_model} to override the models; the choice
    is persisted to runtime settings so generation and the UI reflect it.
    """
    hw = hardware.detect()
    rs = load_runtime_settings()
    hardware.apply_performance_mode(hw, rs.generation_performance_mode)
    gen_ok = hw.generation_available or (hw.device == "cpu" and settings.allow_cpu_generation)
    if not gen_ok:
        raise HTTPException(status_code=400, detail=hw.generation_note or "当前硬件不支持音乐生成")
    _require_ace_dirs()
    if not store.ping():
        raise HTTPException(status_code=503, detail="任务队列未连接：请重启应用；浏览器开发模式请运行 ./start.sh。")
    if not ace.health():
        raise HTTPException(
            status_code=503,
            detail="ACE-Step 服务未启动：请先在音乐生成页启动生成服务；打包应用也可退出后重新打开。",
        )

    # Persist any explicit model choices, then resolve the effective selection.
    if payload is not None:
        if payload.dit_model is not None:
            rs.gen_dit_model = payload.dit_model.strip()
        if payload.lm_model is not None:
            rs.gen_lm_model = payload.lm_model.strip()
        save_runtime_settings(rs)
    dit_model = _resolve_dit(rs, hw)
    lm_sel = _resolve_lm(rs, hw)
    lm_model = None if lm_sel == "none" else lm_sel

    duplicate_guard = acestep_guard.check_duplicate_acestep_processes()
    if not duplicate_guard.ok:
        raise HTTPException(status_code=409, detail=duplicate_guard.to_detail())
    memory_guard = acestep_guard.check_memory_before_init(
        dit_model=dit_model,
        lm_model=lm_model,
        device=hw.device,
        performance_mode=hardware.normalize_performance_mode(rs.generation_performance_mode),
    )
    if not memory_guard.ok and not (payload and payload.force_memory_guard):
        raise HTTPException(status_code=409, detail=memory_guard.to_detail())

    # Reuse the running init job if any.
    existing = store.get_init_job_id()
    if existing:
        j = store.get_job(existing)
        if j and j.state in (JobState.queued, JobState.running):
            return j

    job_id = uuid.uuid4().hex
    job = store.create_init_job(job_id)
    store.set_init_job_id(job_id)

    from ..celery_app import celery_app

    celery_app.send_task(
        "app.tasks.run_init",
        args=[job_id],
        kwargs={
            "dit_model": dit_model,
            "lm_model": lm_model,
            "init_llm": lm_model is not None,
            "force_memory_guard": bool(payload.force_memory_guard) if payload else False,
        },
    )
    return job


@router.post("", response_model=JobStatus)
def create_generation(params: GenerationParams) -> JobStatus:
    hw = hardware.detect()
    rs = load_runtime_settings()
    hardware.apply_performance_mode(hw, rs.generation_performance_mode)
    gen_ok = hw.generation_available or (hw.device == "cpu" and settings.allow_cpu_generation)
    if not gen_ok:
        raise HTTPException(status_code=400, detail=hw.generation_note or "当前硬件不支持音乐生成")
    _require_ace_dirs()

    if not params.prompt and not params.lyrics and not params.sample_query:
        raise HTTPException(status_code=400, detail="请至少提供 描述/歌词/简述 之一")

    # Vocal mode: convert the generated vocals to a trained SVC voice.
    if params.vocal_mode:
        if not params.voice_id:
            raise HTTPException(status_code=400, detail="人声模式需选择一个 SVC 音源，或先去训练。")
        try:
            ensure_runtime_dirs(("svc_models_dir",))
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        from .. import svc_client

        if not svc_client.health():
            raise HTTPException(
                status_code=503,
                detail="人声模式需要 SVC 音源服务。请先进入「SVC 音源」等待自动启动，或点击「重启加载 SVC」。",
            )
        if svc_client.get_voice(params.voice_id) is None:
            raise HTTPException(status_code=400, detail="所选 SVC 音源不存在，请重新选择或训练。")

    if not store.ping():
        raise HTTPException(
            status_code=503,
            detail="任务队列未连接：请重启应用；浏览器开发模式请运行 ./start.sh（或 python run_local.py）。",
        )
    detail = ace.health_detail()
    if not detail.get("service_up"):
        raise HTTPException(
            status_code=503,
            detail="ACE-Step 服务未启动：请先在音乐生成页启动生成服务；打包应用也可退出后重新打开。",
        )
    if not detail.get("models_initialized"):
        raise HTTPException(
            status_code=409,
            detail="模型尚未就绪：请先在生成页点击「初始化」下载并加载模型。",
        )
    selected_lm = _resolve_lm(rs, hw)
    lm_enabled = selected_lm != "none" and bool(detail.get("loaded_lm_model"))
    if selected_lm != "none":
        ckpt_dir = effective_checkpoints_dir(rs)
        if not ace.component_downloaded(ckpt_dir, selected_lm):
            raise HTTPException(
                status_code=409,
                detail=f"当前选择的 LM 模型未下载：{selected_lm}。请先重新初始化下载该 LM，或在设置中选择「不使用 LM」。",
            )
        if not detail.get("loaded_lm_model"):
            raise HTTPException(
                status_code=409,
                detail=f"当前选择的 LM 模型尚未加载：{selected_lm}。请先重新初始化，或在设置中选择「不使用 LM」。",
            )

    # Batch is still gated by the machine; duration is user-controlled with a
    # fixed 270s (4m30s) ceiling, independent of hardware.
    batch = max(1, min(params.batch_size, hw.recommended.max_batch_size))
    duration = params.audio_duration
    if duration is not None:
        duration = max(10.0, min(float(duration), float(hardware.MAX_DURATION_SEC)))

    model = params.model or _resolve_dit(rs, hw)
    task = (params.task_type or "text2music").lower()
    audio_format = (params.audio_format or "wav").lower()
    if audio_format in _FFMPEG_REQUIRED_FORMATS and not _ffmpeg_available():
        raise HTTPException(
            status_code=400,
            detail="当前未检测到可用 FFmpeg，暂不能保存 MP3/OPUS/AAC。请改用 WAV 或 FLAC。",
        )

    _sync_generation_lora(params.lora_id)

    request = acestep_service.build_acestep_request(
        params,
        model=model,
        batch=batch,
        duration=duration,
        audio_format=audio_format,
        task=task,
        lm_enabled=lm_enabled,
    )

    job_id = uuid.uuid4().hex
    gen_dir = effective_generation_dir() / job_id
    gen_dir.mkdir(parents=True, exist_ok=True)

    # Resolve any staged reference/source audio uploads into the job dir.
    files_meta: dict = {}
    src_moved = _consume_staged(params.src_audio_token, gen_dir, "_src")
    if src_moved:
        files_meta["src_audio"] = src_moved.name
    ref_moved = _consume_staged(params.reference_audio_token, gen_dir, "_ref")
    if ref_moved:
        files_meta["reference_audio"] = ref_moved.name

    song_title = (params.title or "").strip()
    payload = {"acestep": request, "title": song_title, "files": files_meta}
    if params.vocal_mode and params.voice_id:
        payload["svc"] = {
            "voice_id": params.voice_id,
            "engine": params.svc_engine,
            "transpose": int(params.svc_transpose),
        }
    (gen_dir / "params.json").write_text(json.dumps(payload, ensure_ascii=False), "utf-8")

    display_title = song_title or params.prompt or params.sample_query or "未命名"
    job = store.create_gen_job(job_id, display_title[:80])

    from ..celery_app import celery_app

    celery_app.send_task("app.tasks.run_generation", args=[job_id])
    return job


@router.post("/upload")
async def upload_audio(file: UploadFile = File(...)) -> dict:
    """Stage a reference/source audio upload; returns a token for create_generation."""
    try:
        ensure_runtime_dirs(("generation_output_dir",))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token = uuid.uuid4().hex
    d = _staging_dir() / token
    d.mkdir(parents=True, exist_ok=True)
    name = Path(file.filename or "audio").name or "audio"
    dest = d / name
    await save_upload(file, dest)
    return {"token": token, "filename": name}


@router.post("/format-input")
def format_input_route(payload: dict | None = None) -> dict:
    """LM-enhance the provided caption/lyrics (proxy to ACE-Step /format_input)."""
    if not ace.health():
        raise HTTPException(status_code=503, detail="ACE-Step 服务未启动：请先初始化/启动生成服务。")
    payload = payload or {}
    prompt = (payload.get("prompt") or "").strip()
    lyrics = (payload.get("lyrics") or "").strip()
    param_obj = payload.get("param_obj") or {}
    if not prompt and not lyrics:
        raise HTTPException(status_code=400, detail="请至少提供 描述 或 歌词 之一以供润色")
    try:
        return ace.format_input(prompt=prompt, lyrics=lyrics, param_obj=param_obj)
    except ace.AceStepError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/random-sample")
def random_sample_route(payload: dict | None = None) -> dict:
    """Return random sample form parameters (proxy to /create_random_sample)."""
    if not ace.health():
        raise HTTPException(status_code=503, detail="ACE-Step 服务未启动：请先初始化/启动生成服务。")
    sample_type = (payload or {}).get("sample_type", "simple_mode")
    try:
        return ace.create_random_sample(sample_type)
    except ace.AceStepError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


def _scan_job_dir(d: Path) -> GenHistoryItem | None:
    audio = sorted(
        (p for p in d.iterdir() if p.is_file() and p.suffix.lower() in _MEDIA),
        key=lambda p: p.name,
    )
    if not audio:
        return None
    title = ""
    params: dict = {}
    pj = d / "params.json"
    if pj.exists():
        try:
            payload = json.loads(pj.read_text("utf-8"))
            if isinstance(payload, dict):
                params = payload
                title = (payload.get("title") or "").strip()
                if not title:
                    req = payload.get("acestep", payload)
                    if isinstance(req, dict):
                        title = (req.get("prompt") or req.get("sample_query") or "").strip()
        except Exception:
            pass
    try:
        created = d.stat().st_mtime
    except OSError:
        created = 0.0
    tracks = [GenHistoryTrack(filename=p.name, size_bytes=p.stat().st_size) for p in audio]
    return GenHistoryItem(
        job_id=d.name,
        title=title or "未命名",
        created_at=created,
        tracks=tracks,
        params=params,
    )


def _current_dit_for_lora() -> str:
    """DiT model used to gauge LoRA compatibility: loaded one, else selection."""
    rs = load_runtime_settings()
    try:
        detail = ace.health_detail()
    except Exception:
        detail = {}
    loaded = (detail.get("loaded_model") or "").strip()
    if loaded:
        return loaded
    hw = hardware.detect()
    return _resolve_dit(rs, hw)


def _build_lora_item(preset: lora_catalog.LoraPreset, dit_model: str) -> LoraItem:
    prog = lora_service.get_progress(preset.id)
    downloaded = lora_service.is_downloaded(preset)
    return LoraItem(
        id=preset.id,
        name=preset.name,
        repo=preset.repo,
        category=preset.category,
        category_label=lora_catalog.CATEGORY_LABELS.get(preset.category, preset.category),
        description=preset.description,
        downloaded=downloaded,
        compatible=lora_catalog.base_matches(preset, dit_model),
        download_status="done" if downloaded else prog.get("status", "idle"),
        download_loaded=int(prog.get("loaded", 0)),
        download_total=int(prog.get("total", 0)),
        download_error=prog.get("error", ""),
    )


@router.get("/loras", response_model=LoraListResponse)
def list_loras() -> LoraListResponse:
    """List catalog LoRAs with local download state + base compatibility."""
    dit_model = _current_dit_for_lora()
    items = [_build_lora_item(p, dit_model) for p in lora_catalog.LORA_PRESETS]
    return LoraListResponse(selected_dit=dit_model, items=items)


@router.post("/loras/download", response_model=LoraItem)
def download_lora(req: LoraDownloadRequest) -> LoraItem:
    """Start (or report) a background download of one catalog LoRA."""
    preset = lora_catalog.get_preset(req.id)
    if preset is None:
        raise HTTPException(status_code=404, detail=f"未知的 LoRA：{req.id}")
    if not lora_service.is_downloaded(preset):
        lora_service.start_download_async(preset.id)
    return _build_lora_item(preset, _current_dit_for_lora())


def _sync_generation_lora(lora_id: str) -> None:
    """Load the selected LoRA into the sidecar, or unload when none is chosen.

    LoRA state is global to the ACE-Step decoder, so we reconcile it right
    before each submit: skip if already active, load the local adapter dir if
    downloaded, or unload to fall back to the base model.
    """
    lora_id = (lora_id or "").strip()
    try:
        status = ace.lora_status()
    except Exception:
        status = {}
    active_adapter = (status.get("active_adapter") or "").strip()
    lora_on = bool(status.get("use_lora")) and bool(status.get("lora_loaded"))

    if not lora_id:
        if lora_on:
            try:
                ace.lora_unload()
            except Exception:
                pass
        return

    preset = lora_catalog.get_preset(lora_id)
    if preset is None:
        raise HTTPException(status_code=400, detail=f"未知的 LoRA：{lora_id}")
    if not lora_service.is_downloaded(preset):
        raise HTTPException(status_code=400, detail=f"LoRA「{preset.name}」尚未下载，请先点击下载。")

    if lora_on and active_adapter == preset.id:
        return  # already active

    adapter_dir = str(lora_service.local_dir(preset))
    try:
        if lora_on and active_adapter and active_adapter != preset.id:
            # Different adapter loaded: reset to base before switching.
            ace.lora_unload()
        ace.lora_load(adapter_dir, adapter_name=preset.id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"加载 LoRA 失败：{exc}") from exc


@router.get("/history", response_model=list[GenHistoryItem])
def history(limit: int = 200) -> list[GenHistoryItem]:
    """List previously generated music by scanning disk.

    Songs are archived under the history dir on completion; the cache dir may
    still hold in-flight or un-archived jobs. We scan both (history first) and
    dedup by job id. Durable across Redis expiry. Newest first.
    """
    return _scan_generation_history()[:limit]


# 生成历史全量扫盘较重（每目录读 params.json / stat）。前端 15s 轮询反复触发，
# 故加短 TTL 缓存：所有根目录 mtime 未变且未过期则复用上次扫描结果。
_GEN_HISTORY_CACHE: dict = {"key": None, "at": 0.0, "items": []}
_GEN_HISTORY_TTL = 8.0


def _scan_generation_history() -> list["GenHistoryItem"]:
    import time as _time

    roots = [r for r in _generation_roots()]
    key_parts = []
    for root in roots:
        try:
            key_parts.append((str(root), root.stat().st_mtime if root.is_dir() else 0.0))
        except OSError:
            key_parts.append((str(root), 0.0))
    key = tuple(key_parts)
    now = _time.time()
    cache = _GEN_HISTORY_CACHE
    if cache["key"] == key and (now - cache["at"]) < _GEN_HISTORY_TTL:
        return cache["items"]

    items: dict[str, GenHistoryItem] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for d in root.iterdir():
            if not d.is_dir() or d.name in items:
                continue
            item = _scan_job_dir(d)
            if item is not None:
                items[d.name] = item
    out = sorted(items.values(), key=lambda it: it.created_at, reverse=True)
    cache["key"] = key
    cache["at"] = now
    cache["items"] = out
    return out


@router.get("/history/{job_id}/file")
def history_file(job_id: str, name: str, download: bool = False):
    """Serve a generated audio file directly from disk (history playback)."""
    fpath = _song_path(job_id, name)
    if fpath is None:
        raise HTTPException(status_code=404, detail="文件不存在")
    media_type = _MEDIA.get(fpath.suffix.lower(), "application/octet-stream")
    return FileResponse(fpath, media_type=media_type, filename=name if download else None)


@router.get("/history/{job_id}/params")
def history_params(job_id: str, download: bool = False):
    """Serve the saved generation parameter snapshot (params.json)."""
    d = _history_job_dir(job_id)
    if d is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    p = d / "params.json"
    if not p.is_file():
        raise HTTPException(status_code=404, detail="参数文件不存在")
    return FileResponse(
        p,
        media_type="application/json",
        filename=f"{job_id}-params.json" if download else None,
    )


@router.delete("/history/{job_id}")
def delete_history(job_id: str) -> dict:
    """Delete one generation's folder from disk (history + any cache copy)."""
    found = False
    for root in _generation_roots():
        base = (root / job_id).resolve()
        if base.parent == root.resolve() and base.is_dir():
            shutil.rmtree(base, ignore_errors=True)
            found = True
    if not found:
        raise HTTPException(status_code=404, detail="记录不存在")
    return {"ok": True, "job_id": job_id}


class RenameHistoryRequest(BaseModel):
    title: str


@router.patch("/history/{job_id}/rename", response_model=GenHistoryItem)
def rename_history(job_id: str, payload: RenameHistoryRequest) -> GenHistoryItem:
    """Rename a generation history item. Updates both disk (params.json) and Redis."""
    new_title = payload.title.strip() or "未命名"
    found_dir: Path | None = None
    for root in _generation_roots():
        base = (root / job_id).resolve()
        if base.parent == root.resolve() and base.is_dir():
            found_dir = base
            break
    if found_dir is None:
        raise HTTPException(status_code=404, detail="记录不存在")

    # Update params.json on disk
    pj = found_dir / "params.json"
    if pj.exists():
        try:
            payload_dict = json.loads(pj.read_text("utf-8"))
            if isinstance(payload_dict, dict):
                payload_dict["title"] = new_title
                pj.write_text(json.dumps(payload_dict, ensure_ascii=False), "utf-8")
        except Exception:
            pass

    # Update Redis if the job still exists
    store.rename_gen_job(job_id, new_title)

    # Return a fresh GenHistoryItem
    item = _scan_job_dir(found_dir)
    if item is None:
        raise HTTPException(status_code=500, detail="扫描记录目录失败")
    item.title = new_title
    return item


@router.get("/{job_id}", response_model=JobStatus)
def get_status(job_id: str) -> JobStatus:
    job = store.get_job(job_id)
    if job is None or job.kind != "generation":
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    return job


@router.get("/{job_id}/events")
async def gen_events(job_id: str):
    job = store.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")

    async def event_generator():
        last_signature: tuple | None = None
        while True:
            current = store.get_job(job_id)
            if current is None:
                yield {"event": "error", "data": "job not found"}
                return
            signature = (current.state, current.progress, current.stage, len(current.tracks))
            if signature != last_signature:
                last_signature = signature
                yield {"event": "status", "data": current.model_dump_json()}
            if current.state in (JobState.done, JobState.failed):
                return
            await asyncio.sleep(0.5)

    return EventSourceResponse(event_generator())


@router.get("/{job_id}/track/{index}")
def get_track(job_id: str, index: int, download: bool = False):
    job = store.get_job(job_id)
    if job is None or job.kind != "generation":
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    match = next((t for t in job.tracks if t.index == index), None)
    if match is None:
        raise HTTPException(status_code=404, detail="音轨不存在")
    fpath = _song_path(job_id, match.filename)
    if fpath is None:
        raise HTTPException(status_code=404, detail="音频文件已被清理")
    media_type = _MEDIA.get(Path(match.filename).suffix.lower(), "application/octet-stream")
    filename = match.filename if download else None
    return FileResponse(fpath, media_type=media_type, filename=filename)


@router.post("/{job_id}/to-separation", response_model=JobStatus)
def send_to_separation(job_id: str, index: int, stems: str | None = None):
    """Copy a generated track into a new separation job and enqueue it."""
    job = store.get_job(job_id)
    filename = ""
    src: Path | None = None
    if job is not None and job.kind == "generation":
        match = next((t for t in job.tracks if t.index == index), None)
        if match is not None:
            src = _song_path(job_id, match.filename)
            filename = match.filename
    if src is None:
        src = _history_track_by_index(job_id, index)
        filename = src.name if src is not None else ""
    if src is None:
        raise HTTPException(status_code=404, detail="音轨不存在或音频文件已被清理")
    try:
        ensure_runtime_dirs(("separation_output_dir", "uploads_dir"))
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not store.ping():
        raise HTTPException(status_code=503, detail="任务队列未连接：请重启应用；浏览器开发模式请运行 ./start.sh。")

    from ..config import load_runtime_settings
    from ..engines.factory import capabilities_for
    from ..stems import is_valid_stem

    if stems:
        try:
            requested = [s for s in json.loads(stems) if is_valid_stem(s)]
        except Exception:
            requested = []
    else:
        requested = []
    if not requested:
        _, supported = capabilities_for(None)
        requested = list(supported)

    new_id = uuid.uuid4().hex
    up_dir = effective_uploads_dir() / new_id
    up_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, up_dir / filename)

    engine = load_runtime_settings().default_engine
    new_job = store.create_job(new_id, filename, requested, engine)

    from ..celery_app import celery_app

    celery_app.send_task("app.tasks.run_separation", args=[new_id])
    return new_job
