"""LALAL.AI-backed separation engine (optional, paid, true 10-stem).

Activated when a LALAL.AI API key is configured in the settings page. Implements
the documented REST flow:
    1. upload file      -> source id
    2. submit split job (one request per requested stem)
    3. poll /check/     -> progress + result urls
    4. download stem tracks

Stem id mapping below reflects LALAL.AI's documented stem parameter names. The
canonical `other` stem has no exact LALAL equivalent and is mapped to the
closest available value; adjust here once you validate against your account.
"""
from __future__ import annotations

import time
from pathlib import Path

import httpx

from ..audio_utils import wav_to_mp3
from .base import EngineError, ProgressCb, SeparationEngine

API_BASE = "https://www.lalal.ai/api"

# Canonical UI stem id -> LALAL.AI stem parameter name.
STEM_TO_LALAL: dict[str, str] = {
    "lead_vocals": "vocals",
    "backing_vocals": "back_vocals",
    "drums": "drum",
    "bass": "bass",
    "acoustic_guitar": "acoustic_guitar",
    "electric_guitar": "electric_guitar",
    "piano": "piano",
    "synth": "synthesizer",
    "strings": "strings",
    "other": "wind",
}

POLL_INTERVAL_SEC = 3.0
POLL_TIMEOUT_SEC = 600.0


class LalalEngine(SeparationEngine):
    name = "lalal"

    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise EngineError("未配置 LALAL.AI API Key")
        self.api_key = api_key

    def supported_stems(self) -> set[str]:
        return set(STEM_TO_LALAL.keys())

    @property
    def _auth_header(self) -> dict[str, str]:
        return {"Authorization": f"license {self.api_key}"}

    def separate(
        self,
        audio_path: str,
        stems: list[str],
        out_dir: str,
        progress_cb: ProgressCb,
        output_format: str = "wav",
    ) -> dict[str, str]:
        targets = self.filter_supported(stems)
        if not targets:
            raise EngineError("LALAL.AI 引擎不支持所选的任何分轨类型")

        as_mp3 = str(output_format).lower() == "mp3"
        out_path = Path(out_dir)
        out_path.mkdir(parents=True, exist_ok=True)
        results: dict[str, str] = {}

        with httpx.Client(timeout=120.0) as client:
            progress_cb(5, "上传文件到 LALAL.AI")
            source_id = self._upload(client, audio_path)

            total = len(targets)
            for idx, stem_id in enumerate(targets):
                base = 10 + int(85 * idx / total)
                span = int(85 / total)
                progress_cb(base, f"分离 {stem_id}")
                url = self._split_and_wait(
                    client,
                    source_id,
                    STEM_TO_LALAL[stem_id],
                    lambda p, base=base, span=span: progress_cb(
                        base + int(span * p / 100), f"分离 {stem_id}"
                    ),
                )
                results[stem_id] = self._download(client, url, out_path, stem_id, as_mp3)

        if not results:
            raise EngineError("LALAL.AI 未返回任何分轨结果")
        progress_cb(100, "完成")
        return results

    def _upload(self, client: httpx.Client, audio_path: str) -> str:
        name = Path(audio_path).name
        headers = {
            **self._auth_header,
            "Content-Disposition": f'attachment; filename="{name}"',
        }
        with open(audio_path, "rb") as fh:
            resp = client.post(f"{API_BASE}/upload/", headers=headers, content=fh.read())
        data = self._json_or_raise(resp)
        if data.get("status") != "success":
            raise EngineError(f"上传失败: {data.get('error', data)}")
        return data["id"]

    def _split_and_wait(
        self, client: httpx.Client, source_id: str, lalal_stem: str, on_progress
    ) -> str:
        import json as _json

        params = _json.dumps([{"id": source_id, "stem": lalal_stem}])
        resp = client.post(
            f"{API_BASE}/split/", headers=self._auth_header, data={"params": params}
        )
        data = self._json_or_raise(resp)
        if data.get("status") != "success":
            raise EngineError(f"提交分离任务失败: {data.get('error', data)}")

        deadline = time.time() + POLL_TIMEOUT_SEC
        while time.time() < deadline:
            time.sleep(POLL_INTERVAL_SEC)
            resp = client.post(
                f"{API_BASE}/check/", headers=self._auth_header, data={"id": source_id}
            )
            data = self._json_or_raise(resp)
            result = data.get("result", {}).get(source_id, {})
            task = result.get("task", {})
            state = task.get("state")
            if state == "success":
                split = result.get("split", {})
                url = split.get("stem_track")
                if not url:
                    raise EngineError("LALAL.AI 未返回分轨下载链接")
                return url
            if state == "error" or state == "cancelled":
                raise EngineError(f"LALAL.AI 处理失败: {task.get('error', state)}")
            try:
                on_progress(float(task.get("progress", 0)))
            except Exception:
                pass
        raise EngineError("LALAL.AI 处理超时")

    def _download(
        self, client: httpx.Client, url: str, out_path: Path, stem_id: str, as_mp3: bool = False
    ) -> str:
        resp = client.get(url)
        resp.raise_for_status()
        suffix = ".wav" if url.lower().endswith(".wav") else ".mp3"
        raw_file = out_path / f"{stem_id}{suffix}"
        raw_file.write_bytes(resp.content)
        if as_mp3 and suffix == ".wav":
            mp3_file = out_path / f"{stem_id}.mp3"
            try:
                wav_to_mp3(raw_file, mp3_file)
                raw_file.unlink(missing_ok=True)
                return str(mp3_file)
            except Exception:
                return str(raw_file)
        return str(raw_file)

    @staticmethod
    def _json_or_raise(resp: httpx.Response) -> dict:
        if resp.status_code != 200:
            raise EngineError(f"LALAL.AI 请求失败 HTTP {resp.status_code}")
        try:
            return resp.json()
        except Exception as exc:
            raise EngineError("LALAL.AI 返回非 JSON 响应") from exc
