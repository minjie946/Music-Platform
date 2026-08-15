"""On-disk voice-model registry.

Each voice is a directory under ``models_dir()`` containing a ``meta.json``:

    {"id", "name", "engine", "created_at", "ready"}

so-vits voices also carry a ``work/`` subtree with the trained checkpoint;
"""
from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path

from .config import models_dir
from .engines import get_engine


def _meta_path(voice_dir: Path) -> Path:
    return voice_dir / "meta.json"


def create_voice(name: str, engine: str) -> dict:
    vid = uuid.uuid4().hex
    d = models_dir() / vid
    d.mkdir(parents=True, exist_ok=True)
    meta = {
        "id": vid,
        "name": (name or "未命名音源").strip()[:80],
        "engine": engine,
        "created_at": time.time(),
        "ready": False,
    }
    _meta_path(d).write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    return meta


def mark_ready(voice_id: str, ready: bool = True) -> None:
    d = models_dir() / voice_id
    mp = _meta_path(d)
    if not mp.exists():
        return
    try:
        meta = json.loads(mp.read_text("utf-8"))
        meta["ready"] = ready
        mp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        pass


def voice_dir(voice_id: str) -> Path | None:
    if not voice_id or "/" in voice_id or "\\" in voice_id:
        return None
    d = models_dir() / voice_id
    return d if (d.is_dir() and _meta_path(d).exists()) else None


def get_meta(voice_id: str) -> dict | None:
    d = voice_dir(voice_id)
    if not d:
        return None
    try:
        return json.loads(_meta_path(d).read_text("utf-8"))
    except Exception:
        return None


def _is_ready(meta: dict, d: Path) -> bool:
    engine = (meta.get("engine") or "").lower()
    if engine == "sovits":
        try:
            return get_engine("sovits")._latest_ckpt(d / "work") is not None  # type: ignore[attr-defined]
        except Exception:
            return bool(meta.get("ready"))
    return bool(meta.get("ready"))


def list_voices() -> list[dict]:
    out: list[dict] = []
    base = models_dir()
    for d in base.iterdir():
        if not d.is_dir():
            continue
        mp = _meta_path(d)
        if not mp.exists():
            continue
        try:
            meta = json.loads(mp.read_text("utf-8"))
        except Exception:
            continue
        meta["ready"] = _is_ready(meta, d)
        out.append(meta)
    out.sort(key=lambda m: m.get("created_at", 0), reverse=True)
    return out


def delete_voice(voice_id: str) -> bool:
    d = voice_dir(voice_id)
    if not d:
        return False
    shutil.rmtree(d, ignore_errors=True)
    return True


def export_files(voice_path: Path) -> list[Path]:
    meta = get_meta(voice_path.name) or _read_meta(voice_path)
    engine = str(meta.get("engine") or "").strip().lower()
    files = [voice_path / "meta.json"]
    if engine == "sovits":
        work = voice_path / "work"
        ckpt = get_engine("sovits")._latest_ckpt(work)  # type: ignore[attr-defined]
        cfg = get_engine("sovits")._config(work)  # type: ignore[attr-defined]
        if not ckpt or not cfg:
            raise ValueError("音源缺少模型权重或配置，无法导出")
        files.extend([ckpt, cfg])
        return [path for path in files if path.is_file()]
    return [path for path in voice_path.rglob("*") if path.is_file()]


def import_voice(src_dir: Path) -> dict:
    root = _normalize_import_root(src_dir)
    meta_path = _meta_path(root)
    if not meta_path.is_file():
        raise ValueError("导入包缺少 meta.json")
    try:
        meta = json.loads(meta_path.read_text("utf-8"))
    except Exception as exc:
        raise ValueError("导入包 meta.json 无法解析") from exc
    engine = str(meta.get("engine") or "").strip().lower()
    if engine != "sovits":
        raise ValueError(f"暂不支持导入该音源引擎: {engine or 'unknown'}")
    vid = uuid.uuid4().hex
    dest = models_dir() / vid
    shutil.copytree(root, dest)
    _normalize_imported_sovits_layout(dest)
    imported = {
        **meta,
        "id": vid,
        "name": str(meta.get("name") or "导入音源").strip()[:80] or "导入音源",
        "engine": engine,
        "created_at": time.time(),
    }
    imported["ready"] = _is_ready(imported, dest)
    _meta_path(dest).write_text(json.dumps(imported, ensure_ascii=False, indent=2), "utf-8")
    return imported


def _normalize_import_root(src_dir: Path) -> Path:
    if _meta_path(src_dir).is_file():
        return src_dir
    children = [p for p in src_dir.iterdir() if p.is_dir()]
    if len(children) == 1 and _meta_path(children[0]).is_file():
        return children[0]
    return src_dir


def _read_meta(voice_path: Path) -> dict:
    try:
        return json.loads(_meta_path(voice_path).read_text("utf-8"))
    except Exception:
        return {}


def _normalize_imported_sovits_layout(voice_path: Path) -> None:
    meta = _read_meta(voice_path)
    if str(meta.get("engine") or "").strip().lower() != "sovits":
        return
    logs = voice_path / "work" / "logs" / "44k"
    logs.mkdir(parents=True, exist_ok=True)
    for ckpt in list(voice_path.glob("G_*.pth")) + list(voice_path.glob("work/G_*.pth")):
        if ckpt.is_file():
            shutil.move(str(ckpt), str(logs / ckpt.name))
    for cfg in (
        voice_path / "config.json",
        voice_path / "work" / "config.json",
        voice_path / "work" / "configs" / "44k" / "config.json",
    ):
        if cfg.is_file() and not (logs / "config.json").is_file():
            shutil.copy2(cfg, logs / "config.json")
