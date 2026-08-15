"""Thin synchronous client for the SVC sidecar (:8002).

Mirrors acestep_client style. All calls degrade gracefully: health() never
raises, and the higher layers surface friendly messages when the service is
down or an engine is unavailable.
"""
from __future__ import annotations

from pathlib import Path

import httpx

from .config import settings
from .sidecar import (
    BaseSidecarClient,
    error_detail as _detail,
    filename_from_disposition as _filename_from_disposition,
    open_uploads,
)


class SvcError(RuntimeError):
    pass


_sidecar = BaseSidecarClient("svc", lambda: settings.svc_api_url)


def _base() -> str:
    return _sidecar.base()


def _client(timeout: float) -> httpx.Client:
    # SVC is a local sidecar. Do not let HTTP_PROXY/HTTPS_PROXY intercept
    # localhost calls, otherwise corporate proxies can turn health checks into 502.
    return _sidecar.client(timeout)


def health(timeout: float = 3.0) -> bool:
    return _sidecar.health(timeout)


def capabilities(timeout: float = 5.0) -> dict:
    """Return {device, engines:{name:{infer_available,train_available,note}}}.

    Returns an empty/`service_up: False` shape when unreachable.
    """
    try:
        with _client(timeout) as c:
            r = c.get(f"{_base()}/capabilities")
            if r.status_code != 200:
                return {"service_up": False, "engines": {}}
            data = r.json()
            data["service_up"] = True
            return data
    except Exception:
        return {"service_up": False, "engines": {}}


def list_voices(timeout: float = 5.0) -> list[dict]:
    try:
        with _client(timeout) as c:
            r = c.get(f"{_base()}/voices")
            if r.status_code != 200:
                return []
            return r.json()
    except Exception:
        return []


def get_voice(voice_id: str, timeout: float = 5.0) -> dict | None:
    for v in list_voices(timeout=timeout):
        if v.get("id") == voice_id:
            return v
    return None


def delete_voice(voice_id: str, timeout: float = 10.0) -> bool:
    try:
        with _client(timeout) as c:
            return c.delete(f"{_base()}/voices/{voice_id}").status_code == 200
    except Exception:
        return False


def export_voice(voice_id: str, dest: Path, timeout: float = 60.0) -> tuple[Path, str]:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with _client(timeout) as c:
            resp = c.get(f"{_base()}/voices/{voice_id}/export")
            if resp.status_code >= 400:
                raise SvcError(_detail(resp))
            filename = _filename_from_disposition(resp.headers.get("content-disposition")) or f"{voice_id}.svcvoice.zip"
            dest.write_bytes(resp.content)
            return dest, filename
    except SvcError:
        raise
    except Exception as exc:
        raise SvcError(f"导出 SVC 音源失败: {exc}") from exc


def import_voice(archive: Path, timeout: float = 60.0) -> dict:
    if not archive.is_file():
        raise SvcError(f"导入音源包不存在: {archive}")
    try:
        with _client(timeout) as c:
            with archive.open("rb") as fh:
                resp = c.post(
                    f"{_base()}/voices/import",
                    files={"file": (archive.name, fh, "application/zip")},
                )
            if resp.status_code >= 400:
                raise SvcError(_detail(resp))
            return resp.json()
    except SvcError:
        raise
    except Exception as exc:
        raise SvcError(f"导入 SVC 音源失败: {exc}") from exc


def shutdown(timeout: float = 3.0) -> bool:
    """Ask the SVC sidecar to exit. The desktop launcher will restart it."""
    try:
        with _client(timeout) as c:
            return c.post(f"{_base()}/service/shutdown").status_code == 200
    except Exception:
        return False


def convert(input_wav: Path, voice_id: str, dest: Path, transpose: int = 0,
            timeout: float = 60 * 10) -> Path:
    """Upload a vocal wav, run conversion, save the result to `dest`."""
    p = Path(input_wav)
    if not p.is_file():
        raise SvcError(f"待转换音频不存在: {input_wav}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with _client(timeout) as c:
            with open(p, "rb") as fh:
                resp = c.post(
                    f"{_base()}/convert",
                    data={"voice_id": voice_id, "transpose": str(int(transpose))},
                    files={"file": (p.name, fh, "application/octet-stream")},
                )
            if resp.status_code >= 400:
                detail = _detail(resp)
                raise SvcError(f"SVC 转换失败 ({resp.status_code}): {detail}")
            with open(dest, "wb") as out:
                out.write(resp.content)
    except SvcError:
        raise
    except Exception as exc:
        raise SvcError(f"无法连接 SVC 服务: {exc}") from exc
    return dest


def train(samples: list[Path], name: str, engine: str, max_epochs: int = 50,
          timeout: float = 30.0) -> dict:
    """Forward training samples to the sidecar; returns {train_id, voice_id}."""
    with open_uploads(("files", s) for s in samples) as file_field:
        if not file_field:
            raise SvcError("没有可用的样本文件")
        with _client(timeout) as c:
            resp = c.post(
                f"{_base()}/train",
                data={"name": name, "engine": engine, "max_epochs": str(int(max_epochs))},
                files=file_field,
            )
        if resp.status_code >= 400:
            raise SvcError(_detail(resp))
        return resp.json()


def train_status(train_id: str, timeout: float = 5.0) -> dict | None:
    try:
        with _client(timeout) as c:
            r = c.get(f"{_base()}/train/{train_id}")
            if r.status_code != 200:
                return None
            return r.json()
    except Exception:
        return None
