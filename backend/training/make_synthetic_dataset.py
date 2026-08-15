"""Generate a tiny synthetic 10-stem dataset in Demucs' wav layout.

This is ONLY for validating the training pipeline end-to-end (a "smoke" run)
without needing the real, license-gated MoisesDB. The audio is meaningless
(per-stem tones + noise); the point is that the shapes/layout are exactly what
Demucs' ``get_wav_datasets`` expects::

    <out>/train/<track>/mixture.wav
    <out>/train/<track>/<source>.wav   (one per canonical source)
    <out>/valid/<track>/...

Usage::

    python make_synthetic_dataset.py --out /tmp/ds10 --train 6 --valid 2 --seconds 6
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

CANONICAL = [
    "lead_vocals",
    "backing_vocals",
    "drums",
    "bass",
    "acoustic_guitar",
    "electric_guitar",
    "piano",
    "synth",
    "strings",
    "other",
]

SAMPLE_RATE = 44100
CHANNELS = 2


def _make_track(dest: Path, seconds: float, rng: np.random.Generator) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    n = int(seconds * SAMPLE_RATE)
    t = np.linspace(0.0, seconds, n, endpoint=False, dtype="float32")
    mixture = np.zeros((n, CHANNELS), dtype="float32")
    for i, name in enumerate(CANONICAL):
        # Each source: a distinct tone + a little noise, low amplitude.
        freq = 110.0 * (i + 1)
        tone = 0.05 * np.sin(2 * np.pi * freq * t).astype("float32")
        noise = (0.01 * rng.standard_normal(n)).astype("float32")
        mono = tone + noise
        stereo = np.stack([mono, mono], axis=1)  # (n, 2)
        sf.write(str(dest / f"{name}.wav"), stereo, SAMPLE_RATE)
        mixture += stereo
    sf.write(str(dest / "mixture.wav"), mixture, SAMPLE_RATE)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="输出数据集根目录")
    ap.add_argument("--train", type=int, default=6, help="train 轨数")
    ap.add_argument("--valid", type=int, default=2, help="valid 轨数")
    ap.add_argument("--seconds", type=float, default=6.0, help="每首时长(秒)")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    out = Path(args.out)
    for split, count in (("train", args.train), ("valid", args.valid)):
        for k in range(count):
            _make_track(out / split / f"song{k:03d}", args.seconds, rng)
    print(f"生成完成 -> {out}")
    print(f"  train: {args.train} 轨, valid: {args.valid} 轨, 每轨 {args.seconds}s, 源 = {CANONICAL}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
