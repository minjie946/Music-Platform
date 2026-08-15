"""Shared plumbing for the local AI sidecar clients (ACE-Step, SVC, ...).

Each sidecar is a localhost REST service with the same basic needs: a normalized
base URL, an httpx client, a `/health` liveness probe, multipart uploads with
guaranteed file-handle cleanup, and best-effort error extraction. Concrete
clients (the per-vendor "adapters") layer their own request/response conventions
on top of this base.
"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterable, Iterator

import httpx

UploadItem = tuple[str, str | Path | None]
HttpxFile = tuple[str, tuple[str, object, str]]


class BaseSidecarClient:
    """Common HTTP plumbing shared by the sidecar adapters."""

    def __init__(
        self,
        name: str,
        base_url: Callable[[], str] | str,
        *,
        trust_env: bool = False,
        auth: Callable[[], dict] | None = None,
    ) -> None:
        self.name = name
        self._base_url = base_url
        # Local sidecars: by default ignore HTTP(S)_PROXY so corporate proxies
        # can't turn localhost health checks into 502s.
        self.trust_env = trust_env
        self._auth = auth

    def base(self) -> str:
        url = self._base_url() if callable(self._base_url) else self._base_url
        return url.rstrip("/")

    def auth_headers(self) -> dict:
        return self._auth() if self._auth else {}

    def client(self, timeout: float) -> httpx.Client:
        return httpx.Client(timeout=timeout, trust_env=self.trust_env)

    def health(self, timeout: float = 3.0) -> bool:
        try:
            with self.client(timeout) as c:
                return c.get(f"{self.base()}/health").status_code == 200
        except Exception:
            return False


@contextmanager
def open_uploads(
    items: Iterable[UploadItem],
    content_type: str = "application/octet-stream",
) -> Iterator[list[HttpxFile]]:
    """Open `(field, path)` pairs as httpx multipart files, closing every handle
    on exit. Missing/empty paths are skipped so callers can decide what an empty
    result means (e.g. fall back to a JSON request)."""
    handles: list = []
    files: list[HttpxFile] = []
    try:
        for field, path in items:
            if not path:
                continue
            p = Path(path)
            if not p.is_file():
                continue
            fh = open(p, "rb")
            handles.append(fh)
            files.append((field, (p.name, fh, content_type)))
        yield files
    finally:
        for fh in handles:
            try:
                fh.close()
            except Exception:
                pass


def error_detail(resp: httpx.Response) -> str:
    """Best-effort human-readable error from a failed sidecar response."""
    try:
        body = resp.json()
    except Exception:
        return resp.text[:300]
    if isinstance(body, dict):
        return str(body.get("detail") or body.get("error") or body)
    return str(body)


def filename_from_disposition(value: str | None) -> str:
    if not value:
        return ""
    for part in value.split(";"):
        part = part.strip()
        if part.lower().startswith("filename="):
            return part.split("=", 1)[1].strip().strip('"')
    return ""
