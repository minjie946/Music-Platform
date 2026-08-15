"""Thin synchronous client for the ACE-Step REST API (sidecar on :8001).

ACE-Step exposes an async job API:
- POST /release_task        -> {data: {task_id, status, queue_position}}
- POST /query_result        -> {data: [{task_id, status(int), result(JSON str)}]}
- GET  /v1/audio?path=...   -> audio bytes
- GET  /v1/models           -> available DiT models
- GET  /health              -> liveness

All responses are wrapped as {data, code, error, timestamp, extra}.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import httpx

from .config import settings
from .sidecar import BaseSidecarClient, open_uploads


class AceStepError(RuntimeError):
    pass


# ACE-Step integer task status.
STATUS_RUNNING = 0
STATUS_SUCCEEDED = 1
STATUS_FAILED = 2


@dataclass
class GenResultTrack:
    file_path: str   # value of `path` to feed into /v1/audio
    seed: str = ""
    duration: float | None = None


def _headers() -> dict:
    h = {"Content-Type": "application/json"}
    if settings.acestep_api_key:
        h["Authorization"] = f"Bearer {settings.acestep_api_key}"
    return h


def _auth_only() -> dict:
    if settings.acestep_api_key:
        return {"Authorization": f"Bearer {settings.acestep_api_key}"}
    return {}


# ACE-Step accepts proxies for its (potentially remote) endpoint, so trust_env.
_sidecar = BaseSidecarClient(
    "acestep", lambda: settings.acestep_api_url, trust_env=True, auth=_auth_only
)


def _base() -> str:
    return _sidecar.base()


def _client(timeout: float) -> httpx.Client:
    return _sidecar.client(timeout)


def _unwrap(resp: httpx.Response) -> dict:
    try:
        body = resp.json()
    except Exception:
        raise AceStepError(f"ACE-Step 返回非 JSON ({resp.status_code}): {resp.text[:200]}")
    if resp.status_code >= 400:
        detail = body.get("error") or body.get("detail") or resp.text
        raise AceStepError(f"ACE-Step 错误 {resp.status_code}: {detail}")
    if body.get("code") not in (200, None) and body.get("error"):
        raise AceStepError(f"ACE-Step 错误: {body.get('error')}")
    return body.get("data", body)


def health(timeout: float = 3.0) -> bool:
    return _sidecar.health(timeout)


def health_detail(timeout: float = 3.0) -> dict:
    """Return {service_up, models_initialized, loaded_model, loaded_lm_model}."""
    try:
        with _client(timeout) as c:
            r = c.get(f"{_base()}/health")
            if r.status_code != 200:
                return {"service_up": False}
            data = r.json().get("data", {})
            return {
                "service_up": True,
                "models_initialized": bool(data.get("models_initialized")),
                "loaded_model": data.get("loaded_model"),
                "loaded_lm_model": data.get("loaded_lm_model"),
            }
    except Exception:
        return {"service_up": False}


BASE_MODEL_COMPONENTS = (
    "acestep-v15-turbo",
    "vae",
    "Qwen3-Embedding-0.6B",
)
_WEIGHT_FILES = (
    "model.safetensors",
    "model.safetensors.index.json",
    "pytorch_model.bin",
    "pytorch_model.bin.index.json",
    "diffusion_pytorch_model.safetensors",
    "diffusion_pytorch_model.safetensors.index.json",
    "diffusion_pytorch_model.bin",
    "diffusion_pytorch_model.bin.index.json",
)


def component_downloaded(checkpoints_dir, component: str | None) -> bool:
    from pathlib import Path

    if not component:
        return True
    base = Path(checkpoints_dir)
    if not base.is_dir():
        return False
    comp = base / component
    return comp.is_dir() and any((comp / w).exists() for w in _WEIGHT_FILES)


def model_downloaded(checkpoints_dir, dit_model: str | None = None, lm_model: str | None = None) -> bool:
    """True when the selected DiT + required shared components + selected LM exist."""
    required = set(BASE_MODEL_COMPONENTS)
    if dit_model:
        required.add(dit_model)
    if lm_model and lm_model != "none":
        required.add(lm_model)
    for component in required:
        if not component_downloaded(checkpoints_dir, component):
            return False
    return True


def init_models(
    model: str | None = None,
    init_llm: bool = False,
    lm_model_path: str | None = None,
    timeout: float = 60 * 60,
) -> dict:
    """Trigger ACE-Step to download (if missing) + load models. Blocks until done."""
    payload: dict = {"slot": 1, "init_llm": init_llm}
    if model:
        payload["model"] = model
    if lm_model_path:
        payload["lm_model_path"] = lm_model_path
    with _client(timeout) as c:
        return _unwrap(c.post(f"{_base()}/v1/init", headers=_headers(), json=payload))


def list_models(timeout: float = 5.0) -> list[dict]:
    try:
        with _client(timeout) as c:
            data = _unwrap(c.get(f"{_base()}/v1/models"))
        return data.get("models", []) if isinstance(data, dict) else []
    except Exception:
        return []


def lora_load(lora_path: str, adapter_name: str | None = None, timeout: float = 120.0) -> dict:
    """Load a LoRA adapter into the ACE-Step decoder (has global effect)."""
    payload: dict = {"lora_path": lora_path}
    if adapter_name:
        payload["adapter_name"] = adapter_name
    with _client(timeout) as c:
        return _unwrap(c.post(f"{_base()}/v1/lora/load", headers=_headers(), json=payload))


def lora_unload(timeout: float = 60.0) -> dict:
    """Unload all LoRA adapters and restore the base decoder."""
    with _client(timeout) as c:
        return _unwrap(c.post(f"{_base()}/v1/lora/unload", headers=_headers(), json={}))


def lora_status(timeout: float = 5.0) -> dict:
    try:
        with _client(timeout) as c:
            return _unwrap(c.get(f"{_base()}/v1/lora/status"))
    except Exception:
        return {}


def release_task(params: dict, timeout: float = 30.0) -> str:
    payload = {k: v for k, v in params.items() if v is not None and v != ""}
    with _client(timeout) as c:
        data = _unwrap(c.post(f"{_base()}/release_task", headers=_headers(), json=payload))
    task_id = data.get("task_id")
    if not task_id:
        raise AceStepError(f"ACE-Step 未返回 task_id: {data}")
    return task_id


def release_task_multipart(params: dict, files: dict, timeout: float = 60.0) -> str:
    """Submit /release_task as multipart/form-data, uploading reference/source audio.

    `files` maps an ACE-Step file field (e.g. "src_audio", "reference_audio") to a
    filesystem path. ACE-Step ignores the matching `_path` param when a file is
    uploaded and uses the temp file instead.
    """
    # Form fields must be strings; serialize bools/numbers, drop empties.
    data: dict = {}
    for k, v in params.items():
        if v is None or v == "":
            continue
        if isinstance(v, bool):
            data[k] = "true" if v else "false"
        else:
            data[k] = str(v)

    with open_uploads(files.items()) as file_field:
        if not file_field:
            # No usable files -> fall back to JSON path.
            return release_task(params, timeout=timeout)
        # Multipart: don't set Content-Type manually (httpx sets the boundary).
        with _client(timeout) as c:
            resp = c.post(
                f"{_base()}/release_task",
                headers=_sidecar.auth_headers(),
                data=data,
                files=file_field,
            )
        body = _unwrap(resp)

    task_id = body.get("task_id")
    if not task_id:
        raise AceStepError(f"ACE-Step 未返回 task_id: {body}")
    return task_id


def format_input(
    prompt: str = "",
    lyrics: str = "",
    param_obj: dict | None = None,
    temperature: float = 0.85,
    timeout: float = 120.0,
) -> dict:
    """LM-enhance/format a caption + lyrics. Returns the enhanced fields dict."""
    payload = {
        "prompt": prompt,
        "lyrics": lyrics,
        "temperature": temperature,
        "param_obj": json.dumps(param_obj or {}, ensure_ascii=False),
    }
    with _client(timeout) as c:
        return _unwrap(c.post(f"{_base()}/format_input", headers=_headers(), json=payload))


def create_random_sample(sample_type: str = "simple_mode", timeout: float = 60.0) -> dict:
    """Return random sample form parameters from preloaded examples."""
    with _client(timeout) as c:
        return _unwrap(c.post(
            f"{_base()}/create_random_sample",
            headers=_headers(),
            json={"sample_type": sample_type},
        ))


def query_result(task_id: str, timeout: float = 15.0) -> tuple[int, list[GenResultTrack], str]:
    """Return (status_int, tracks, error_message)."""
    with _client(timeout) as c:
        data = _unwrap(
            c.post(
                f"{_base()}/query_result",
                headers=_headers(),
                json={"task_id_list": [task_id]},
            )
        )
    items = data if isinstance(data, list) else data.get("data", [])
    if not items:
        return STATUS_RUNNING, [], ""
    item = items[0]
    status = int(item.get("status", 0))
    if status != STATUS_SUCCEEDED:
        return status, [], item.get("error", "") or ""

    tracks: list[GenResultTrack] = []
    raw = item.get("result", "[]")
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        parsed = []
    for entry in parsed if isinstance(parsed, list) else [parsed]:
        file_url = entry.get("file", "")
        path = _extract_path(file_url)
        if not path:
            error = entry.get("error") or entry.get("message") or "ACE-Step 未返回有效音频路径，可能是音频保存失败。"
            return STATUS_FAILED, [], str(error)
        metas = entry.get("metas", {}) or {}
        tracks.append(
            GenResultTrack(
                file_path=path,
                seed=str(entry.get("seed_value", "")),
                duration=metas.get("duration"),
            )
        )
    return STATUS_SUCCEEDED, tracks, ""


def _extract_path(file_url: str) -> str:
    """`file` looks like `/v1/audio?path=%2Ftmp%2F...mp3`; pull out the path."""
    if not file_url:
        return ""
    if "path=" in file_url:
        from urllib.parse import unquote, urlparse, parse_qs

        q = parse_qs(urlparse(file_url).query)
        if "path" in q:
            return unquote(q["path"][0])
    return file_url


def download_audio(file_path: str, dest, timeout: float = 120.0) -> int:
    """Download a generated audio file to `dest`; return bytes written."""
    from urllib.parse import quote

    url = f"{_base()}/v1/audio?path={quote(file_path, safe='')}"
    total = 0
    headers = _sidecar.auth_headers()
    with _client(timeout) as c:
        with c.stream("GET", url, headers=headers) as r:
            if r.status_code >= 400:
                detail = ""
                try:
                    detail = r.read().decode("utf-8", errors="ignore")[:200]
                except Exception:
                    detail = ""
                suffix = f" {detail}" if detail else ""
                raise AceStepError(f"下载生成音频失败 {r.status_code}: {file_path}{suffix}")
            with open(dest, "wb") as f:
                for chunk in r.iter_bytes(1024 * 256):
                    f.write(chunk)
                    total += len(chunk)
    return total
