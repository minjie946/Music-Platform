"""Celery tasks: run separation jobs and periodic cleanup."""
from __future__ import annotations

import json
import os
import subprocess
import shutil
import time
from pathlib import Path

from celery import shared_task

from . import store
from .audio_utils import (
    ensure_stereo as _ensure_stereo,
    match_length as _match_length,
    probe_duration,
    soft_limit as _soft_limit,
)
from .config import configured_runtime_dir, effective_separation_dir, effective_uploads_dir, ensure_runtime_dirs, settings
from .engines.base import EngineError
from .engines.factory import get_engine
from .models import GenTrack, StemResult
from .stems import STEM_BY_ID


def _mono_envelope(arr, sr: int, window_ms: int = 40):
    import numpy as np

    arr = _ensure_stereo(arr)
    mono = np.mean(np.abs(arr), axis=0)
    win = max(1, int(sr * window_ms / 1000))
    kernel = np.ones(win, dtype="float32") / float(win)
    return np.convolve(mono, kernel, mode="same")


def _rms(arr, mask=None) -> float:
    import numpy as np

    data = np.asarray(arr, dtype="float32")
    if mask is not None:
        data = data[:, mask]
    if data.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(data)) + 1e-8))


@shared_task(name="app.tasks.run_separation")
def run_separation(job_id: str) -> None:
    job = store.get_job(job_id)
    if job is None:
        return
    try:
        ensure_runtime_dirs(("separation_output_dir", "uploads_dir"))
    except RuntimeError as exc:
        store.mark_failed(job_id, str(exc))
        return

    upload_dir = effective_uploads_dir() / job_id
    out_dir = effective_separation_dir() / job_id
    audio_files = list(upload_dir.glob("*"))
    if not audio_files:
        store.mark_failed(job_id, "找不到上传的音频文件")
        return
    audio_path = str(audio_files[0])

    def progress_cb(pct: int, stage: str) -> None:
        store.update_progress(job_id, pct, stage)

    try:
        engine = get_engine(job.engine)
        store.update_progress(job_id, 1, "开始处理")
        produced = engine.separate(
            audio_path, job.requested_stems, str(out_dir), progress_cb, job.output_format
        )
    except EngineError as exc:
        store.mark_failed(job_id, str(exc))
        return
    except Exception as exc:  # pragma: no cover - unexpected failure
        store.mark_failed(job_id, f"处理出错: {exc}")
        return

    results: list[StemResult] = []
    for stem_id, path in produced.items():
        p = Path(path)
        meta = STEM_BY_ID.get(stem_id)
        results.append(
            StemResult(
                stem=stem_id,
                label_zh=meta.label_zh if meta else stem_id,
                label_en=meta.label_en if meta else stem_id,
                filename=p.name,
                url=f"/api/stems/{job_id}/{stem_id}",
                size_bytes=p.stat().st_size if p.exists() else 0,
                duration_sec=probe_duration(p),
            )
        )

    results.sort(key=lambda r: list(STEM_BY_ID.keys()).index(r.stem) if r.stem in STEM_BY_ID else 99)
    store.mark_done(job_id, results)
    done_job = store.get_job(job_id)
    if done_job is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "job.json").write_text(done_job.model_dump_json(), "utf-8")


@shared_task(name="app.tasks.run_generation")
def run_generation(job_id: str) -> None:
    from . import acestep_client as ace

    job = store.get_job(job_id)
    if job is None:
        return

    from .config import effective_generation_dir, effective_history_dir

    try:
        ensure_runtime_dirs(("generation_output_dir", "history_output_dir", "acestep_checkpoints_dir", "acestep_tmp_dir"))
    except RuntimeError as exc:
        store.mark_failed(job_id, str(exc))
        return

    out_root = effective_generation_dir()
    gen_dir = out_root / job_id
    params_file = gen_dir / "params.json"
    if not params_file.exists():
        store.mark_failed(job_id, "找不到生成参数")
        return
    payload = json.loads(params_file.read_text("utf-8"))
    # New structure: {"acestep": {...}, "title": "..."}; fall back to legacy flat.
    files_meta: dict = {}
    svc_meta: dict | None = None
    if isinstance(payload, dict) and "acestep" in payload:
        params = payload["acestep"]
        song_title = (payload.get("title") or "").strip()
        files_meta = payload.get("files") or {}
        svc_meta = payload.get("svc") or None
    else:
        params = payload
        song_title = ""

    try:
        if not ace.health():
            store.mark_failed(
                job_id,
                "ACE-Step 服务未启动（默认 http://127.0.0.1:8001）。"
                "请先在音乐生成页启动生成服务；打包应用也可退出后重新打开。",
            )
            return

        store.update_progress(job_id, 3, "提交生成任务")
        # Editing/reference modes upload audio alongside the form (multipart).
        upload_files = {
            field: gen_dir / name
            for field, name in files_meta.items()
            if name and (gen_dir / name).is_file()
        }
        if upload_files:
            task_id = ace.release_task_multipart(params, upload_files)
        else:
            task_id = ace.release_task(params)

        store.update_progress(job_id, 8, "生成中（排队/推理）")
        # Poll until the ACE-Step task succeeds or fails.
        deadline = time.time() + 60 * 30  # 30 min ceiling
        tracks_meta: list[ace.GenResultTrack] = []
        pct = 8
        while True:
            if time.time() > deadline:
                store.mark_failed(job_id, "生成超时（超过 30 分钟）")
                return
            status, tracks_meta, err = ace.query_result(task_id)
            if status == ace.STATUS_SUCCEEDED:
                break
            if status == ace.STATUS_FAILED:
                store.mark_failed(job_id, f"ACE-Step 生成失败: {err or '未知错误'}")
                return
            pct = min(pct + 2, 90)
            store.update_progress(job_id, pct, "生成中（排队/推理）")
            time.sleep(2.0)

        if not tracks_meta:
            store.mark_failed(job_id, "ACE-Step 未返回音频")
            return

        store.update_progress(job_id, 92, "下载生成音频")
        gen_dir.mkdir(parents=True, exist_ok=True)
        audio_format = params.get("audio_format", "mp3")
        # Duplicate-name detection is against the permanent history archive,
        # since the cache dir is cleared after each job completes.
        hist_root = effective_history_dir()
        base = _sanitize_filename(song_title)
        multi = len(tracks_meta) > 1
        results: list[GenTrack] = []
        for i, t in enumerate(tracks_meta):
            ext = Path(t.file_path).suffix or f".{audio_format}"
            filename = _build_track_filename(hist_root, gen_dir, base, ext, i, multi)
            dest = gen_dir / filename
            size = ace.download_audio(t.file_path, dest)
            results.append(
                GenTrack(
                    index=i + 1,
                    filename=filename,
                    url=f"/api/generation/{job_id}/track/{i + 1}",
                    size_bytes=size,
                    duration_sec=t.duration or probe_duration(dest),
                    seed=t.seed,
                )
            )
        # Vocal mode: convert the generated vocals to the chosen SVC voice and
        # remix with the accompaniment, replacing each track file in place.
        if svc_meta and svc_meta.get("voice_id"):
            try:
                _apply_vocal_mode(job_id, gen_dir, results, svc_meta)
            except Exception as exc:
                store.mark_failed(job_id, f"人声转换失败: {exc}")
                return

        # Move the finished song into the history archive and clear the cache.
        store.update_progress(job_id, 97, "归档到历史目录")
        _archive_to_history(gen_dir, hist_root / job_id)
        store.mark_gen_done(job_id, results)
    except ace.AceStepError as exc:
        store.mark_failed(job_id, str(exc))
    except Exception as exc:  # pragma: no cover
        store.mark_failed(job_id, f"生成出错: {exc}")


def _apply_vocal_mode(job_id: str, gen_dir: Path, results: list[GenTrack], svc_meta: dict) -> None:
    """For each generated track: split into vocals + accompaniment (2-stem only),
    run SVC voice conversion on the vocals, then remix and overwrite the track."""
    import tempfile

    import numpy as np

    from . import svc_client
    from .audio_utils import decode_to_wav, read_wav, transcode, wav_to_mp3, write_wav
    from .engines.demucs_engine import DemucsEngine

    voice_id = str(svc_meta.get("voice_id") or "")
    transpose = int(svc_meta.get("transpose") or 0)
    if not voice_id:
        return

    sr = 44100
    total = max(len(results), 1)
    # Force cascade off: we only want a clean vocals + residual(accompaniment) split.
    engine = DemucsEngine(cascade=False)

    for i, track in enumerate(results):
        base = 92
        span = 5  # 92 -> 97 across all tracks
        seg = span / total

        def report(frac: float, stage: str) -> None:
            store.update_progress(job_id, int(base + seg * (i + frac)), stage)

        track_path = gen_dir / track.filename
        if not track_path.is_file():
            continue

        with tempfile.TemporaryDirectory() as tmp:
            tmpd = Path(tmp)
            report(0.05, "分离人声/伴奏")
            produced = engine.separate(
                str(track_path), ["lead_vocals", "other"], str(tmpd / "sep"), lambda p, s: None
            )
            vocals_path = produced.get("lead_vocals")
            accomp_path = produced.get("other")
            if not vocals_path or not accomp_path:
                raise RuntimeError("未能分离出人声/伴奏")

            report(0.4, "转换人声音色")
            # Feed a plain WAV to the SVC engine (avoids needing an mp3 decoder).
            voc_in = tmpd / "vocals_in.wav"
            decode_to_wav(vocals_path, voc_in, samplerate=sr, channels=1)
            converted = tmpd / "converted.wav"
            svc_client.convert(voc_in, voice_id, converted, transpose=transpose)

            report(0.75, "混音")
            voc_wav = tmpd / "voc.wav"
            raw_voc_wav = tmpd / "raw_voc.wav"
            acc_wav = tmpd / "acc.wav"
            decode_to_wav(vocals_path, raw_voc_wav, samplerate=sr, channels=2)
            decode_to_wav(converted, voc_wav, samplerate=sr, channels=2)
            decode_to_wav(accomp_path, acc_wav, samplerate=sr, channels=2)
            raw_voc, _ = read_wav(raw_voc_wav)
            voc, _ = read_wav(voc_wav)
            acc, _ = read_wav(acc_wav)
            raw_voc = _ensure_stereo(raw_voc)
            voc = _ensure_stereo(voc)
            acc = _ensure_stereo(acc)
            raw_voc, voc = _match_length(raw_voc, voc)
            raw_voc, acc = _match_length(raw_voc, acc)

            env = _mono_envelope(raw_voc, sr)
            active = env > max(0.012, float(np.percentile(env, 65)) * 0.35)
            raw_rms = _rms(raw_voc, active)
            svc_rms = _rms(voc, active)
            if raw_rms > 1e-4 and svc_rms > 1e-4:
                gain = min(1.35, max(0.75, raw_rms / svc_rms))
                voc = voc * gain

            # Suppress SVC hiss / warble between phrases using the original vocal envelope.
            gate = np.clip((env - 0.006) / 0.03, 0.0, 1.0).astype("float32")
            gate = np.maximum(gate, 0.12)
            gate2 = np.broadcast_to(gate[None, :], voc.shape)
            voc = voc * gate2

            # Slightly duck the accompaniment when vocals are active to reduce leakage artifacts.
            duck = 1.0 - 0.16 * gate2
            mix = voc * 0.96 + acc * duck
            mix = _soft_limit(mix)
            mixed_wav = tmpd / "mixed.wav"
            write_wav(mixed_wav, mix, sr)

            report(0.95, "写回音轨")
            if track_path.suffix.lower() == ".mp3":
                wav_to_mp3(mixed_wav, track_path)
            else:
                transcode(mixed_wav, track_path)
            try:
                track.size_bytes = track_path.stat().st_size
            except OSError:
                pass


_ILLEGAL_FILENAME = set('/\\:*?"<>|')


def _sanitize_filename(name: str) -> str:
    """Make a song title safe as a filename stem (keeps CJK; strips illegal chars)."""
    name = (name or "").strip()
    if not name:
        return ""
    cleaned = "".join("_" if (ch in _ILLEGAL_FILENAME or ord(ch) < 32) else ch for ch in name)
    cleaned = cleaned.strip().strip(".")
    return cleaned[:120]


def _name_exists_elsewhere(out_root: Path, current_dir: Path, filename: str) -> bool:
    """Whether a file with the same name already exists in another generation."""
    try:
        for p in out_root.glob(f"*/{filename}"):
            if p.parent != current_dir:
                return True
    except OSError:
        pass
    return False


def _build_track_filename(
    out_root: Path, gen_dir: Path, base: str, ext: str, index: int, multi: bool
) -> str:
    """Build the output filename. Uses the song title when provided; appends a
    timestamp (to the second) when that name was already used by a prior song."""
    if not base:
        return f"track_{index + 1}{ext}"
    stem = f"{base}_{index + 1}" if multi else base
    candidate = f"{stem}{ext}"
    if _name_exists_elsewhere(out_root, gen_dir, candidate):
        ts = time.strftime("%Y%m%d-%H%M%S")
        candidate = f"{stem}-{ts}{ext}"
    return candidate


def _archive_to_history(gen_dir: Path, hist_dir: Path) -> None:
    """Move a finished job's files from the cache dir into the history archive,
    then remove the (now empty) cache dir.

    Best-effort: if archiving fails, the cache copy is left in place and serving
    falls back to it, so a song is never lost.
    """
    try:
        hist_dir.mkdir(parents=True, exist_ok=True)
        for p in list(gen_dir.iterdir()):
            if p.is_file():
                shutil.move(str(p), str(hist_dir / p.name))
        shutil.rmtree(gen_dir, ignore_errors=True)
    except Exception:
        pass


def _dir_size_gb(path: Path) -> float:
    total = 0
    try:
        for p in path.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
    except OSError:
        pass
    return total / (1024**3)


@shared_task(name="app.tasks.run_init")
def run_init(
    job_id: str,
    dit_model: str | None = None,
    lm_model: str | None = None,
    init_llm: bool | None = None,
    force_memory_guard: bool = False,
) -> None:
    """Download (if missing) + load ACE-Step models via /v1/init, with progress.

    /v1/init is blocking and gives no incremental progress, so we run it on a
    background thread and meanwhile report the growing checkpoints dir size.

    Model selection: explicit args win; otherwise fall back to the hardware
    recommendation.
    """
    import threading

    from . import acestep_client as ace
    from . import acestep_guard
    from . import hardware
    from .config import effective_checkpoints_dir, load_runtime_settings

    job = store.get_job(job_id)
    if job is None:
        return
    try:
        ensure_runtime_dirs(("acestep_checkpoints_dir", "generation_output_dir", "history_output_dir", "acestep_tmp_dir"))
    except RuntimeError as exc:
        store.mark_failed(job_id, str(exc))
        return

    if not ace.health():
        store.mark_failed(
            job_id,
            "ACE-Step 服务未启动（默认 http://127.0.0.1:8001）。请先在音乐生成页启动生成服务；打包应用也可退出后重新打开。",
        )
        return

    hw = hardware.detect()
    rs = load_runtime_settings()
    hardware.apply_performance_mode(hw, rs.generation_performance_mode)
    rec = hw.recommended
    use_dit = dit_model or rec.dit_model
    use_lm = lm_model if lm_model is not None else rec.lm_model
    use_init_llm = init_llm if init_llm is not None else rec.init_llm
    ckpt_dir = effective_checkpoints_dir()
    duplicate_guard = acestep_guard.check_duplicate_acestep_processes()
    if not duplicate_guard.ok:
        store.mark_failed(job_id, duplicate_guard.message)
        return
    memory_guard = acestep_guard.check_memory_before_init(
        dit_model=use_dit,
        lm_model=use_lm,
        device=hw.device,
        performance_mode=hardware.normalize_performance_mode(rs.generation_performance_mode),
    )
    if not memory_guard.ok and not force_memory_guard:
        store.mark_failed(job_id, memory_guard.message)
        return
    if use_lm and not Path(str(use_lm)).is_absolute():
        use_lm = str(ckpt_dir / str(use_lm))

    result: dict = {}

    def _do_init():
        try:
            result["data"] = ace.init_models(
                model=use_dit,
                init_llm=use_init_llm,
                lm_model_path=use_lm,
            )
        except Exception as exc:  # noqa: BLE001
            result["error"] = str(exc)

    t = threading.Thread(target=_do_init, daemon=True)
    t.start()

    store.update_progress(job_id, 3, "开始下载/加载模型（首次较慢）")
    pct = 3
    while t.is_alive():
        size_gb = _dir_size_gb(ckpt_dir)
        pct = min(pct + 1, 95)
        store.update_progress(
            job_id, pct, f"下载/加载模型中… 已就绪约 {size_gb:.1f}GB（首次会下载数 GB）"
        )
        time.sleep(3.0)

    if result.get("error"):
        store.mark_failed(job_id, f"模型初始化失败: {result['error']}")
        return
    # Confirm readiness.
    detail = ace.health_detail()
    if detail.get("models_initialized"):
        store.mark_done_simple(job_id, "模型已就绪")
    else:
        store.mark_done_simple(job_id, "初始化完成")


def _edit_source_path(spec, edit_dir: Path) -> Path | None:
    """Resolve the on-disk source file for one edit track spec."""
    from .config import effective_separation_dir

    source = getattr(spec, "source", "separation")
    if source == "separation":
        job = store.get_job(spec.job_id)
        filename = ""
        if job is not None:
            match = next((s for s in job.stems if s.stem == spec.stem_id), None)
            if match is not None:
                filename = match.filename
        base = (effective_separation_dir() / spec.job_id).resolve()
        if base.parent != effective_separation_dir().resolve():
            return None
        if filename:
            p = (base / filename).resolve()
            if p.parent == base and p.is_file():
                return p
        # Fallback: scan for <stem_id>.<ext> in the job dir.
        if base.is_dir():
            for ext in (".mp3", ".wav", ".flac"):
                cand = base / f"{spec.stem_id}{ext}"
                if cand.is_file():
                    return cand
        return None
    if source == "generation":
        from .routes.generation import _song_path, _history_track_by_index

        job = store.get_job(spec.job_id)
        if job is not None and job.kind == "generation":
            match = next((t for t in job.tracks if t.index == spec.index), None)
            if match is not None:
                p = _song_path(spec.job_id, match.filename)
                if p is not None:
                    return p
        return _history_track_by_index(spec.job_id, spec.index)
    if source == "upload":
        from .config import effective_edit_dir

        name = (spec.upload_name or "").strip()
        if not name or "/" in name or "\\" in name:
            return None
        staging = (effective_edit_dir() / "_staging").resolve()
        p = (staging / name).resolve()
        if p.parent == staging and p.is_file():
            return p
    return None


def _apply_dock_vocal_fx(spec, src, tmpd, index: int, samplerate: int):
    """按 track 的底部 Dock 设置，依次应用 Autotune 与一键叠声（人声引擎）。

    返回处理后（或原始）的音频路径。任一步失败都退回上一步结果，不中断混音。
    """
    from pathlib import Path

    dock = getattr(getattr(spec, "effects", None), "dock", None)
    if dock is None:
        return src

    current = src
    at = getattr(dock, "autotune", None)
    if at is not None and getattr(at, "enabled", False):
        try:
            from .vocal_fx import apply_autotune

            out = tmpd / f"autotune_{index}.wav"
            apply_autotune(
                current,
                out,
                key=at.key,
                response_ms=float(at.responseMs),
                naturalness=float(at.naturalness),
                samplerate=samplerate,
            )
            if Path(out).exists():
                current = out
        except Exception:  # noqa: BLE001 — 效果失败不应中断导出
            pass

    vf = getattr(dock, "vocalFx", None)
    if vf is not None and getattr(vf, "enabled", False) and float(getattr(vf, "intensity", 0)) > 0:
        try:
            from .vocal_fx import apply_harmony

            out = tmpd / f"harmony_{index}.wav"
            apply_harmony(
                current,
                out,
                preset=vf.preset,
                intensity=float(vf.intensity),
                samplerate=samplerate,
            )
            if Path(out).exists():
                current = out
        except Exception:  # noqa: BLE001
            pass

    return current


@shared_task(name="app.tasks.run_edit")
def run_edit(job_id: str) -> None:
    """Mix/pitch/tempo the requested tracks into a single exported file."""
    import tempfile

    from .audio_utils import apply_clip_fx, build_effect_filters, mix_tracks, time_stretch_pitch
    from .config import effective_edit_dir
    from .models import EditRequest

    job = store.get_job(job_id)
    if job is None:
        return
    try:
        ensure_runtime_dirs(("edit_output_dir",))
    except RuntimeError as exc:
        store.mark_failed(job_id, str(exc))
        return

    edit_dir = effective_edit_dir() / job_id
    req_path = edit_dir / "request.json"
    if not req_path.is_file():
        store.mark_failed(job_id, "找不到编辑请求参数")
        return
    try:
        req = EditRequest.model_validate_json(req_path.read_text("utf-8"))
    except Exception as exc:
        store.mark_failed(job_id, f"编辑参数无效: {exc}")
        return

    active = [t for t in req.tracks if not t.mute]
    if not active:
        store.mark_failed(job_id, "没有可混音的音轨（全部静音或为空）")
        return

    sr = 44100
    fmt = "mp3" if str(req.output_format).lower() == "mp3" else "wav"
    store.update_progress(job_id, 5, "定位音轨文件")

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmpd = Path(tmp)
            mix_inputs: list[dict] = []
            total = len(active)
            for i, spec in enumerate(active):
                if getattr(spec, "source", "") == "midi":
                    from .midi_utils import render_midi_to_wav

                    src = tmpd / f"midi_{i}.wav"
                    try:
                        render_midi_to_wav(spec.midi, src, samplerate=sr)
                    except Exception as exc:  # noqa: BLE001
                        store.mark_failed(job_id, f"MIDI 合成失败：{exc}")
                        return
                else:
                    src = _edit_source_path(spec, edit_dir)
                    if src is None:
                        store.mark_failed(job_id, f"音轨源文件缺失: {spec.label or spec.stem_id or spec.upload_name}")
                        return
                store.update_progress(job_id, int(10 + 50 * (i + 1) / total), "处理音轨")

                # 底部 Dock：Autotune / 一键叠声（本地引擎，人声轨适用）。
                src = _apply_dock_vocal_fx(spec, src, tmpd, i, sr)

                clip = {
                    "gain": float(spec.gain),
                    "pan": float(getattr(spec, "pan", 0.0)),
                    "offset_sec": float(getattr(spec, "offset_sec", 0.0)),
                    "clip_start_sec": float(getattr(spec, "clip_start_sec", 0.0)),
                    "clip_end_sec": float(getattr(spec, "clip_end_sec", 0.0)),
                }
                effects = getattr(spec, "effects", None)
                has_fx = bool(build_effect_filters(effects))
                if abs(float(spec.semitones)) >= 1e-6 or has_fx:
                    processed = tmpd / f"fx_{i}.wav"
                    apply_clip_fx(
                        src, processed, semitones=float(spec.semitones), effects=effects, samplerate=sr
                    )
                    mix_inputs.append({"path": str(processed), **clip})
                else:
                    mix_inputs.append({"path": str(src), **clip})

            store.update_progress(job_id, 70, "混音")
            needs_master = abs(float(req.tempo) - 1.0) >= 1e-6 or abs(float(req.master_semitones)) >= 1e-6
            mix_target = tmpd / f"mix.{fmt}" if not needs_master else tmpd / "mix.wav"
            mix_tracks(mix_inputs, mix_target, samplerate=sr)

            title = _sanitize_filename(req.title) or "mix"
            out_path = edit_dir / f"{title}.{fmt}"
            if needs_master:
                store.update_progress(job_id, 88, "应用变速/变调")
                time_stretch_pitch(
                    mix_target,
                    out_path,
                    semitones=float(req.master_semitones),
                    tempo=float(req.tempo),
                    samplerate=sr,
                )
            else:
                edit_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(mix_target), str(out_path))
    except Exception as exc:  # noqa: BLE001
        store.mark_failed(job_id, f"混音失败: {exc}")
        return

    track = GenTrack(
        index=0,
        filename=out_path.name,
        url=f"/api/edit/{job_id}/result",
        size_bytes=out_path.stat().st_size if out_path.exists() else 0,
        duration_sec=probe_duration(out_path),
    )
    store.mark_gen_done(job_id, [track])
    done_job = store.get_job(job_id)
    if done_job is not None:
        edit_dir.mkdir(parents=True, exist_ok=True)
        (edit_dir / "job.json").write_text(done_job.model_dump_json(), "utf-8")


@shared_task(name="app.tasks.cleanup_old_jobs")
def cleanup_old_jobs() -> int:
    """Remove upload/output directories older than the configured TTL."""
    cutoff = time.time() - settings.job_ttl_hours * 3600
    removed = 0
    cleanup_bases = []
    for key in ("uploads_dir", "separation_output_dir", "generation_output_dir"):
        configured = configured_runtime_dir(key)
        if configured is not None:
            cleanup_bases.append(configured)
    for base in cleanup_bases:
        if not base.exists():
            continue
        for child in base.iterdir():
            try:
                if child.is_dir() and child.stat().st_mtime < cutoff:
                    shutil.rmtree(child, ignore_errors=True)
                    removed += 1
            except OSError:
                continue
    return removed
