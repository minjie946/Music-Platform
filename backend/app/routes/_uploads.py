"""Helpers for persisting multipart uploads without blocking the event loop.

FastAPI's `UploadFile.read()` is awaitable, but the matching disk write is plain
synchronous IO. Streaming chunks straight to `open().write()` inside an async
route blocks the event loop for the whole upload, so the actual file write is
pushed onto the threadpool here.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import UploadFile
from starlette.concurrency import run_in_threadpool

_CHUNK_SIZE = 1024 * 256


async def save_upload(file: UploadFile, dest: Path) -> Path:
    """Stream an UploadFile to `dest`, writing to disk off the event loop."""
    with open(dest, "wb") as out:
        while True:
            chunk = await file.read(_CHUNK_SIZE)
            if not chunk:
                break
            await run_in_threadpool(out.write, chunk)
    return dest
