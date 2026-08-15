"""Demucs-backed separation engine (default, free, local).

Works with any Demucs model and exposes exactly the canonical stems the loaded
model can produce (see mapping.py):
- Stock ``htdemucs_6s`` -> lead_vocals(=vocals), drums, bass, piano, other.
- A custom-trained 10-source model whose sources use canonical names -> all 10.

The ``other`` stem is produced as a *residual* (full mix minus the individually
exported sources), so model sources we don't map to a named stem (e.g. the 6s
``guitar``) and any unselected sources are folded into ``other`` instead of being
dropped -- the exported stems always sum back to the original mix.

Route A (cascade): when ``cascade_vocal_split`` is enabled, the vocals stem is
further split into lead + backing vocals via a karaoke model (see cascade.py),
so backing_vocals becomes available even on the stock 6-stem model.

Audio decode/encode goes through our own ffmpeg resolver (static-ffmpeg); we use
the low-level demucs.pretrained + demucs.apply API (always present).
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from ..audio_utils import decode_to_wav, read_wav, wav_to_mp3, write_wav
from ..config import load_runtime_settings, settings
from .base import EngineError, ProgressCb, SeparationEngine
from .mapping import canonical_from_sources, known_sources_for

# 进程级模型缓存：Demucs 模型从磁盘反序列化 + 搬运到设备约 1-3s/次。
# solo pool 单进程消费，缓存安全；避免每个任务、乃至 vocal 模式每条 track 重复加载。
# key: (model_str, model_repo, device) -> 已 eval + to(device) 的 model。
_MODEL_CACHE: dict = {}


class DemucsEngine(SeparationEngine):
    name = "demucs"

    def __init__(
        self,
        model: str | None = None,
        model_repo: str | None = None,
        cascade: bool | None = None,
        karaoke_model: str | None = None,
    ) -> None:
        rs = load_runtime_settings()
        self.model = model or settings.demucs_model
        self.model_repo = model_repo if model_repo is not None else settings.demucs_model_repo
        self.cascade = rs.cascade_vocal_split if cascade is None else cascade
        self.karaoke_model = karaoke_model or rs.karaoke_model

    # -- capabilities (lightweight, no model load) -------------------------

    def _configured_sources(self) -> list[str]:
        override = settings.demucs_sources.strip()
        if override:
            return [s.strip() for s in override.split(",") if s.strip()]
        return known_sources_for(self.model)

    def supported_stems(self) -> set[str]:
        sources = self._configured_sources()
        supported = set(canonical_from_sources(sources).keys())
        if self.cascade and ("vocals" in sources or "lead_vocals" in sources):
            supported.add("lead_vocals")
            supported.add("backing_vocals")
        return supported

    # -- separation --------------------------------------------------------

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
            raise EngineError("当前 Demucs 引擎不支持所选的任何分轨类型")

        as_mp3 = str(output_format).lower() == "mp3"

        progress_cb(5, "加载模型")
        try:
            import torch
            from demucs.apply import apply_model
        except Exception as exc:  # pragma: no cover - import-time env issue
            raise EngineError(f"无法加载 Demucs/torch: {exc}") from exc

        device = self._pick_device()
        try:
            model = self._load_model_cached(device)
        except Exception as exc:
            raise EngineError(f"初始化 Demucs 模型失败: {exc}") from exc

        samplerate = int(getattr(model, "samplerate", 44100))
        channels = int(getattr(model, "audio_channels", 2))
        source_names = list(getattr(model, "sources", []))

        progress_cb(15, "正在分离音轨")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                tmp_wav = str(Path(tmp) / "input.wav")
                decode_to_wav(audio_path, tmp_wav, samplerate=samplerate, channels=channels)
                data, _ = read_wav(tmp_wav)

                wav = torch.from_numpy(data)
                ref = wav.mean(0)
                std = ref.std() + 1e-8
                wav = (wav - ref.mean()) / std

                out = self._apply(model, wav, device, apply_model)
                out = out * std + ref.mean()
                out_np = out.cpu().numpy()
        except EngineError:
            raise
        except Exception as exc:
            raise EngineError(f"音轨分离失败: {exc}") from exc

        progress_cb(75, "导出音频文件")
        out_path = Path(out_dir)
        out_path.mkdir(parents=True, exist_ok=True)
        name_to_idx = {name: i for i, name in enumerate(source_names)}
        canon_map = canonical_from_sources(source_names)

        cascade_targets = {"lead_vocals", "backing_vocals"}
        use_cascade = (
            self.cascade
            and bool(cascade_targets & set(targets))
            and "vocals" in name_to_idx
        )

        results: dict[str, str] = {}
        claimed_idx: set[int] = set()
        # 1) Direct stems straight from the model sources.
        for stem_id in targets:
            if stem_id == "other":
                continue  # handled as a residual below
            if use_cascade and stem_id in cascade_targets:
                if "vocals" in name_to_idx:
                    claimed_idx.add(name_to_idx["vocals"])
                continue
            src = canon_map.get(stem_id)
            if not src or src not in name_to_idx:
                continue
            claimed_idx.add(name_to_idx[src])
            results[stem_id] = self._export(out_np[name_to_idx[src]], stem_id, out_path, samplerate, as_mp3)

        # 2) Cascade: split the vocals source into lead + backing.
        if use_cascade:
            self._cascade_vocals(
                out_np[name_to_idx["vocals"]], targets, out_path, samplerate, results, as_mp3
            )

        # 3) "其余/other" 作为残差：混音(所有源之和) 减去已单独导出的源。
        #    这样模型未映射的源（如 6s 的 guitar）以及未被单独选中的成分都会
        #    并入“其余”，保证分轨之和≈原始混音、不丢任何音频。
        if "other" in targets:
            residual = out_np.sum(axis=0)
            for idx in claimed_idx:
                residual = residual - out_np[idx]
            results["other"] = self._export(residual, "other", out_path, samplerate, as_mp3)

        if not results:
            raise EngineError("未能生成任何分轨文件")

        total = max(len(results), 1)
        for i, _ in enumerate(results):
            progress_cb(min(75 + int(20 * (i + 1) / total), 99), "导出音频文件")
        progress_cb(100, "完成")
        return results

    # -- helpers -----------------------------------------------------------

    def _export(self, arr, stem_id: str, out_path: Path, samplerate: int, as_mp3: bool = False) -> str:
        wav_file = out_path / f"{stem_id}.wav"
        write_wav(wav_file, arr, samplerate)
        if not as_mp3:
            return str(wav_file)
        mp3_file = out_path / f"{stem_id}.mp3"
        try:
            wav_to_mp3(wav_file, mp3_file)
            wav_file.unlink(missing_ok=True)
            return str(mp3_file)
        except Exception:
            return str(wav_file)

    def _cascade_vocals(self, vocals_arr, targets, out_path: Path, samplerate, results, as_mp3: bool = False) -> None:
        from .cascade import VocalCascade

        with tempfile.TemporaryDirectory() as tmp:
            voc_wav = str(Path(tmp) / "vocals.wav")
            write_wav(voc_wav, vocals_arr, samplerate)
            split: dict[str, str] = {}
            try:
                split = VocalCascade(self.karaoke_model).split(voc_wav, tmp)
            except Exception:
                split = {}

            for stem_id in ("lead_vocals", "backing_vocals"):
                if stem_id not in targets:
                    continue
                if stem_id in split:
                    data, _ = read_wav(split[stem_id])
                    results[stem_id] = self._export(data, stem_id, out_path, samplerate, as_mp3)
                elif stem_id == "lead_vocals":
                    # Degrade gracefully: cascade unavailable -> full vocals = lead.
                    results[stem_id] = self._export(vocals_arr, stem_id, out_path, samplerate, as_mp3)

    def _load_model_cached(self, device: str):
        """加载并缓存模型（按 模型+仓库+设备）。命中缓存则复用，跳过磁盘反序列化。"""
        key = (self.model, self.model_repo or "", device)
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached
        model = self._load_model()
        model.eval()
        model.to(device)
        _MODEL_CACHE[key] = model
        return model

    def _load_model(self):
        model_str = self.model
        is_path = (
            os.sep in model_str
            or model_str.endswith((".th", ".pt", ".ckpt"))
            or os.path.exists(model_str)
        )
        if is_path:
            from demucs.states import load_model

            return load_model(model_str)
        from demucs.pretrained import get_model

        repo = Path(self.model_repo) if self.model_repo else None
        return get_model(model_str, repo=repo)

    def _apply(self, model, wav, device, apply_model):
        """Run apply_model, retrying on CPU if an accelerator path fails."""
        import torch

        try:
            with torch.no_grad():
                return apply_model(
                    model, wav[None], device=device, split=True, overlap=0.25, progress=False
                )[0]
        except Exception:
            if device != "cpu":
                model.to("cpu")
                with torch.no_grad():
                    return apply_model(
                        model, wav[None], device="cpu", split=True, overlap=0.25, progress=False
                    )[0]
            raise

    @staticmethod
    def _pick_device() -> str:
        try:
            import torch

            if torch.cuda.is_available():
                return "cuda"
            if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                return "mps"
        except Exception:
            pass
        return "cpu"
