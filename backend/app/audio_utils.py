"""Small helpers around ffmpeg for transcoding and probing.

The ffmpeg/ffprobe binaries are resolved in this order:
1. Explicit ``APP_FFMPEG_EXE`` / ``APP_FFPROBE_EXE`` env vars.
2. A binary on PATH (e.g. the Docker image installs ffmpeg via apt).
3. The static binary vendored by the ``static-ffmpeg`` pip package, so a local
   dev setup is fully project-contained with no system install.
"""
from __future__ import annotations

import functools
import glob
import os
import re
import shutil
import subprocess
from pathlib import Path


def _vendored(tool: str) -> str | None:
    """Locate a binary bundled inside the static_ffmpeg package, if installed."""
    try:
        import static_ffmpeg

        base = Path(static_ffmpeg.__file__).parent / "bin"
        matches = glob.glob(str(base / "*" / tool))
        for m in matches:
            if os.path.isfile(m) and os.access(m, os.X_OK):
                return m
    except Exception:
        pass
    return None


@functools.lru_cache(maxsize=2)
def _resolve(tool: str, env_var: str) -> str:
    explicit = os.environ.get(env_var)
    if explicit and os.path.isfile(explicit):
        return explicit
    system = shutil.which(tool)
    if system:
        return system
    vend = _vendored(tool)
    if vend:
        return vend
    return tool


def _ffmpeg_exe() -> str:
    return _resolve("ffmpeg", "APP_FFMPEG_EXE")


def wav_to_mp3(wav_path: str | Path, mp3_path: str | Path, bitrate: str = "192k") -> None:
    """Transcode a WAV file to MP3 using ffmpeg."""
    cmd = [
        _ffmpeg_exe(),
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(wav_path),
        "-codec:a",
        "libmp3lame",
        "-b:a",
        bitrate,
        str(mp3_path),
    ]
    subprocess.run(cmd, check=True)


def transcode(src: str | Path, dest: str | Path) -> None:
    """Re-encode `src` to `dest`, letting ffmpeg infer the codec from `dest`'s
    extension (mp3/flac/wav/opus/aac/ogg)."""
    cmd = [
        _ffmpeg_exe(),
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(src),
        str(dest),
    ]
    subprocess.run(cmd, check=True)


def decode_to_wav(
    input_path: str | Path,
    out_wav: str | Path,
    samplerate: int = 44100,
    channels: int = 2,
) -> None:
    """Decode any input audio to 16-bit PCM WAV using our resolved ffmpeg.

    This avoids relying on demucs' own AudioFile (which needs ffmpeg on PATH).
    """
    cmd = [
        _ffmpeg_exe(),
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-ac",
        str(channels),
        "-ar",
        str(samplerate),
        "-acodec",
        "pcm_s16le",
        str(out_wav),
    ]
    subprocess.run(cmd, check=True)


def read_wav(path: str | Path):
    """Read a 16-bit PCM WAV into a float32 ndarray shaped (channels, length).

    Returns (data, samplerate). Uses only the stdlib + numpy, no ffmpeg.
    """
    import wave

    import numpy as np

    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        samplerate = wf.getframerate()
        sampwidth = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())

    if sampwidth != 2:
        raise ValueError(f"仅支持 16-bit PCM WAV，当前 sampwidth={sampwidth}")
    arr = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    arr = arr.reshape(-1, channels).T  # (channels, length)
    return arr, samplerate


def write_wav(path: str | Path, data, samplerate: int) -> None:
    """Write a float32 ndarray shaped (channels, length) to 16-bit PCM WAV."""
    import wave

    import numpy as np

    arr = np.asarray(data, dtype="float32")
    if arr.ndim == 1:
        arr = arr[None, :]
    arr = np.clip(arr, -1.0, 1.0)
    interleaved = (arr.T.reshape(-1) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(arr.shape[0])
        wf.setsampwidth(2)
        wf.setframerate(int(samplerate))
        wf.writeframes(interleaved.tobytes())


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)")


def probe_duration(path: str | Path) -> float | None:
    """Return duration in seconds, parsed from ffmpeg output, or None."""
    try:
        out = subprocess.run(
            [_ffmpeg_exe(), "-i", str(path)],
            capture_output=True,
            text=True,
        )
        match = _DURATION_RE.search(out.stderr)
        if not match:
            return None
        h, m, s = match.groups()
        return int(h) * 3600 + int(m) * 60 + float(s)
    except Exception:
        return None


# ---------- numpy mixing primitives (shared with tasks._apply_vocal_mode) ----------


def ensure_stereo(arr):
    import numpy as np

    arr = np.asarray(arr, dtype="float32")
    if arr.ndim == 1:
        arr = arr[None, :]
    if arr.shape[0] == 1:
        arr = np.repeat(arr, 2, axis=0)
    return arr


def match_length(a, b):
    n = min(a.shape[1], b.shape[1])
    return a[:, :n], b[:, :n]


def soft_limit(arr):
    """Tanh soft limiter: only engages once the peak exceeds ~0.98."""
    import numpy as np

    peak = float(np.max(np.abs(arr))) if arr.size else 0.0
    if peak <= 0.98:
        return arr
    limited = np.tanh(arr * 1.15) / np.tanh(1.15)
    peak2 = float(np.max(np.abs(limited))) if limited.size else 0.0
    if peak2 > 0.98:
        limited = limited * (0.98 / peak2)
    return limited.astype("float32")


def _atempo_chain(tempo: float) -> list[str]:
    """ffmpeg atempo only accepts 0.5–2.0 per filter; chain to reach any factor."""
    tempo = max(0.25, min(4.0, float(tempo)))
    parts: list[str] = []
    remaining = tempo
    while remaining > 2.0:
        parts.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        parts.append("atempo=0.5")
        remaining /= 0.5
    parts.append(f"atempo={remaining:.6f}")
    return parts


def time_stretch_pitch(
    src: str | Path,
    dest: str | Path,
    semitones: float = 0.0,
    tempo: float = 1.0,
    samplerate: int = 44100,
) -> None:
    """Pitch-shift (semitones, duration preserved) and/or time-stretch (tempo,
    pitch preserved) via ffmpeg filters, writing to ``dest``.

    Pitch: asetrate resamples the grid (changes both pitch+speed), aresample
    restores the sample rate, then atempo compensates the speed back so only the
    pitch changes. Tempo is an extra atempo factor applied on top.
    """
    if abs(semitones) < 1e-6 and abs(tempo - 1.0) < 1e-6:
        transcode(src, dest)
        return

    filters: list[str] = []
    if abs(semitones) >= 1e-6:
        ratio = 2.0 ** (semitones / 12.0)
        filters.append(f"asetrate={int(samplerate * ratio)}")
        filters.append(f"aresample={samplerate}")
        # Undo the speed change from asetrate (1/ratio), then apply user tempo.
        filters += _atempo_chain(tempo / ratio)
    else:
        filters += _atempo_chain(tempo)

    cmd = [
        _ffmpeg_exe(),
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-filter:a",
        ",".join(filters),
        str(dest),
    ]
    subprocess.run(cmd, check=True)


def _fx_val(effects, key: str, default):
    """Read an effect field from a pydantic model or a plain dict."""
    if isinstance(effects, dict):
        return effects.get(key, default)
    return getattr(effects, key, default)


def build_effect_filters(effects) -> list[str]:
    """Translate a ClipEffects (model or dict) into ffmpeg filter fragments.

    Order: EQ -> Compressor -> Reverb -> Delay. Returns [] when nothing is on.
    """
    if effects is None:
        return []
    filters: list[str] = []

    if _fx_val(effects, "eq_enabled", False):
        for freq, gain in (
            (100, float(_fx_val(effects, "eq_low_db", 0.0))),
            (1000, float(_fx_val(effects, "eq_mid_db", 0.0))),
            (8000, float(_fx_val(effects, "eq_high_db", 0.0))),
        ):
            if abs(gain) >= 0.1:
                filters.append(f"equalizer=f={freq}:t=q:w=1:g={gain:.2f}")

    if _fx_val(effects, "comp_enabled", False):
        amount = max(0.0, min(1.0, float(_fx_val(effects, "comp_amount", 0.5))))
        ratio = 2.0 + amount * 6.0            # 2..8
        threshold = 0.5 - amount * 0.4        # 0.5..0.1 (linear)
        filters.append(
            f"acompressor=threshold={threshold:.3f}:ratio={ratio:.2f}:attack=20:release=250"
        )

    if _fx_val(effects, "reverb_enabled", False):
        amount = max(0.0, min(1.0, float(_fx_val(effects, "reverb_amount", 0.3))))
        # Multi-tap aecho approximating a room; decays scale with amount.
        d1 = 0.4 * amount
        d2 = 0.3 * amount
        d3 = 0.2 * amount
        filters.append(
            f"aecho=0.8:0.9:40|60|90:{d1:.3f}|{d2:.3f}|{d3:.3f}"
        )

    if _fx_val(effects, "delay_enabled", False):
        delay_ms = max(20.0, min(1500.0, float(_fx_val(effects, "delay_ms", 250.0))))
        fb = max(0.0, min(0.95, float(_fx_val(effects, "delay_feedback", 0.3))))
        filters.append(f"aecho=0.8:0.9:{delay_ms:.0f}:{fb:.3f}")

    return filters


def apply_clip_fx(
    src: str | Path,
    dest: str | Path,
    semitones: float = 0.0,
    effects=None,
    samplerate: int = 44100,
) -> None:
    """Apply per-clip pitch shift and/or an effect chain in a single ffmpeg pass.

    Combines the pitch filters (same asetrate/aresample/atempo scheme as
    ``time_stretch_pitch``, tempo fixed at 1.0 for clips) with the effect
    filters from ``build_effect_filters``. If nothing applies, plain transcode.
    """
    filters: list[str] = []
    if abs(semitones) >= 1e-6:
        ratio = 2.0 ** (semitones / 12.0)
        filters.append(f"asetrate={int(samplerate * ratio)}")
        filters.append(f"aresample={samplerate}")
        filters += _atempo_chain(1.0 / ratio)

    filters += build_effect_filters(effects)

    if not filters:
        transcode(src, dest)
        return

    cmd = [
        _ffmpeg_exe(),
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-filter:a",
        ",".join(filters),
        str(dest),
    ]
    subprocess.run(cmd, check=True)


def mix_tracks(
    inputs: list[dict],
    dest: str | Path,
    samplerate: int = 44100,
) -> None:
    """Sum multiple audio tracks into one file.

    Each input dict: ``{"path": str, "gain": float}`` plus optional timeline
    fields ``offset_sec`` (clip start on the timeline), ``clip_start_sec`` and
    ``clip_end_sec`` (trim window within the source; 0 end = to the end). Skip
    muted tracks before calling. Tracks are decoded to WAV, trimmed, placed at
    their offset over a canvas sized to the furthest clip end (gaps zero-filled),
    summed at their linear gain, soft-limited, then written to ``dest`` (codec
    inferred from the extension).
    """
    import tempfile

    import numpy as np

    if not inputs:
        raise ValueError("mix_tracks 需要至少一条音轨")

    decoded: list = []
    with tempfile.TemporaryDirectory() as tmp:
        tmpd = Path(tmp)
        for i, item in enumerate(inputs):
            wav = tmpd / f"in_{i}.wav"
            decode_to_wav(item["path"], wav, samplerate=samplerate, channels=2)
            data, _ = read_wav(wav)
            data = ensure_stereo(data)
            clip_start = max(0, int(float(item.get("clip_start_sec", 0.0)) * samplerate))
            clip_end = int(float(item.get("clip_end_sec", 0.0)) * samplerate)
            if clip_end > clip_start:
                data = data[:, clip_start:clip_end]
            elif clip_start > 0:
                data = data[:, clip_start:]
            offset = max(0, int(float(item.get("offset_sec", 0.0)) * samplerate))
            pan = max(-1.0, min(1.0, float(item.get("pan", 0.0))))
            decoded.append((data, float(item.get("gain", 1.0)), offset, pan))

        length = max((off + d.shape[1]) for d, _, off, _ in decoded)
        mix = np.zeros((2, length), dtype="float32")
        for data, gain, offset, pan in decoded:
            clip_len = data.shape[1]
            if clip_len == 0:
                continue
            # 等功率声像：pan -1..1 -> 左右增益。
            angle = (pan + 1.0) * 0.25 * np.pi  # 0..pi/2
            lg = float(np.cos(angle))
            rg = float(np.sin(angle))
            seg = data * gain
            mix[0, offset:offset + clip_len] += seg[0] * lg
            mix[1, offset:offset + clip_len] += seg[1] * rg

        mix = soft_limit(mix)
        mixed_wav = tmpd / "mixed.wav"
        write_wav(mixed_wav, mix, samplerate)

        dest = Path(dest)
        if dest.suffix.lower() == ".mp3":
            wav_to_mp3(mixed_wav, dest)
        elif dest.suffix.lower() == ".wav":
            shutil.copyfile(mixed_wav, dest)
        else:
            transcode(mixed_wav, dest)
