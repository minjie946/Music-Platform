"""Lead/backing vocal cascade splitter.

Takes an already-isolated vocals stem and splits it into lead and backing
vocals using a karaoke model run through the `audio-separator` package.

This is route A: it lets the stock 6-stem Demucs model still deliver a
主唱/伴唱 split without training a custom model.

The exact karaoke model is configurable (``RuntimeSettings.karaoke_model``).
Karaoke models output two stems; audio-separator labels them ``(Vocals)`` and
``(Instrumental)``. For a karaoke model fed an isolated vocal, ``(Vocals)`` is
the lead and ``(Instrumental)`` is the backing/harmony layer.
"""
from __future__ import annotations

from pathlib import Path

from .base import EngineError


class VocalCascade:
    def __init__(self, model_filename: str) -> None:
        self.model_filename = model_filename

    def split(self, vocals_wav: str, out_dir: str) -> dict[str, str]:
        """Return {"lead_vocals": wav_path, "backing_vocals": wav_path}.

        Raises EngineError if the optional dependency or model is unavailable;
        the caller degrades gracefully.
        """
        try:
            from audio_separator.separator import Separator
        except Exception as exc:  # package not installed
            raise EngineError(
                "级联需要 audio-separator，请先 pip install audio-separator"
            ) from exc

        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)

        try:
            separator = Separator(output_dir=str(out))
            separator.load_model(model_filename=self.model_filename)
            produced = separator.separate(vocals_wav)
        except Exception as exc:
            raise EngineError(f"主唱/伴唱级联分离失败: {exc}") from exc

        # `produced` is a list of output file paths (absolute or relative to out_dir).
        paths = [p if Path(p).is_absolute() else str(out / p) for p in produced]
        return self._classify(paths)

    @staticmethod
    def _classify(paths: list[str]) -> dict[str, str]:
        result: dict[str, str] = {}
        leftovers: list[str] = []
        for p in paths:
            low = Path(p).name.lower()
            if any(k in low for k in ("(vocals)", "_vocals", "lead")):
                result.setdefault("lead_vocals", p)
            elif any(k in low for k in ("(instrumental)", "_instrumental", "back", "harmon")):
                result.setdefault("backing_vocals", p)
            else:
                leftovers.append(p)

        # Fallback: if labels were ambiguous, assign by order (first=lead).
        for p in leftovers:
            if "lead_vocals" not in result:
                result["lead_vocals"] = p
            elif "backing_vocals" not in result:
                result["backing_vocals"] = p
        return result
