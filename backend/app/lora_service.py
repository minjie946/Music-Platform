"""LoRA download + local-state service for music generation.

Presets (see ``lora_catalog``) are metadata only; adapter weights are fetched on
demand from HuggingFace (国内镜像优先) into the user's LoRA directory. Each
adapter lands in ``<lora_dir>/<preset.id>/`` holding the PEFT files
(``adapter_config.json`` + ``adapter_model.safetensors``), which the ACE-Step
sidecar loads via ``/v1/lora/load``.
"""
from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path

import httpx

from .config import effective_lora_dir
from .lora_catalog import LoraPreset, get_preset

# 国内镜像优先，失败回退官方。
_HF_ENDPOINTS = ("https://hf-mirror.com", "https://huggingface.co")

# Only these adapter files are downloaded; demo audio/images/readme are skipped.
_WANTED_EXACT = {"adapter_config.json", "adapter_model.safetensors"}
_WANTED_SUFFIX = (".safetensors",)

# Per-preset download progress, keyed by preset id.
_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()


def local_dir(preset: LoraPreset) -> Path:
    return effective_lora_dir() / preset.id


def is_downloaded(preset: LoraPreset) -> bool:
    """A preset is usable once its PEFT config + a safetensors weight exist."""
    d = local_dir(preset)
    if not d.is_dir():
        return False
    has_config = (d / "adapter_config.json").is_file()
    has_weight = any(p.suffix == ".safetensors" for p in d.iterdir() if p.is_file())
    return has_config and has_weight


def get_progress(preset_id: str) -> dict:
    with _progress_lock:
        return dict(_progress.get(preset_id, {"status": "idle", "loaded": 0, "total": 0, "error": ""}))


def _set_progress(preset_id: str, **kw) -> None:
    with _progress_lock:
        cur = _progress.get(preset_id, {"status": "idle", "loaded": 0, "total": 0, "error": ""})
        cur.update(kw)
        _progress[preset_id] = cur


def _list_repo_files(repo: str, subfolder: str) -> list[str]:
    """Return repo-relative paths of the adapter files we want to download."""
    last_exc: Exception | None = None
    for base in _HF_ENDPOINTS:
        url = f"{base}/api/models/{repo}"
        try:
            with httpx.Client(timeout=30.0, follow_redirects=True) as c:
                resp = c.get(url)
                resp.raise_for_status()
                data = resp.json()
        except Exception as exc:  # noqa: BLE001 - try next endpoint
            last_exc = exc
            continue
        siblings = [s.get("rfilename", "") for s in data.get("siblings", [])]
        prefix = f"{subfolder.rstrip('/')}/" if subfolder else ""
        wanted: list[str] = []
        for rel in siblings:
            if prefix and not rel.startswith(prefix):
                continue
            name = rel[len(prefix):] if prefix else rel
            if "/" in name:  # nested deeper than the adapter folder
                continue
            if name in _WANTED_EXACT or name.endswith(_WANTED_SUFFIX):
                wanted.append(rel)
        if wanted:
            return wanted
        last_exc = RuntimeError(f"仓库 {repo} 未找到可用的 LoRA 适配器文件")
    raise RuntimeError(f"无法列出 {repo} 的文件：{last_exc}")


def _download_file(repo: str, rel_path: str, dest: Path) -> int:
    """Stream one repo file to dest, mirror-first. Returns bytes written."""
    last_exc: Exception | None = None
    for base in _HF_ENDPOINTS:
        url = f"{base}/{repo}/resolve/main/{rel_path}"
        try:
            with httpx.Client(timeout=None, follow_redirects=True) as c:
                with c.stream("GET", url) as resp:
                    resp.raise_for_status()
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    written = 0
                    tmp = dest.with_suffix(dest.suffix + ".part")
                    with open(tmp, "wb") as fh:
                        for chunk in resp.iter_bytes(chunk_size=262144):
                            fh.write(chunk)
                            written += len(chunk)
                    tmp.replace(dest)
                    return written
        except Exception as exc:  # noqa: BLE001 - try next endpoint
            last_exc = exc
            continue
    raise RuntimeError(f"下载 {rel_path} 失败：{last_exc}")


def download(preset_id: str) -> None:
    """Download a preset's adapter files into its local dir (blocking).

    Progress is published via ``get_progress``. Flattens the repo subfolder so
    the adapter files always land at ``<lora_dir>/<id>/`` root.
    """
    preset = get_preset(preset_id)
    if preset is None:
        _set_progress(preset_id, status="failed", error=f"未知的 LoRA：{preset_id}")
        return
    if is_downloaded(preset):
        _set_progress(preset_id, status="done")
        return

    _set_progress(preset_id, status="downloading", loaded=0, total=0, error="")
    dest_dir = local_dir(preset)
    try:
        files = _list_repo_files(preset.repo, preset.subfolder)
        _set_progress(preset_id, total=len(files))
        dest_dir.mkdir(parents=True, exist_ok=True)
        for i, rel in enumerate(files, start=1):
            name = os.path.basename(rel)
            _download_file(preset.repo, rel, dest_dir / name)
            _set_progress(preset_id, loaded=i)
        if not is_downloaded(preset):
            raise RuntimeError("下载完成但缺少 adapter_config.json 或权重文件")
        _set_progress(preset_id, status="done")
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(dest_dir, ignore_errors=True)
        _set_progress(preset_id, status="failed", error=str(exc))


def start_download_async(preset_id: str) -> None:
    """Kick off a background download thread (idempotent while running)."""
    cur = get_progress(preset_id)
    if cur.get("status") == "downloading":
        return
    threading.Thread(target=download, args=(preset_id,), daemon=True).start()
