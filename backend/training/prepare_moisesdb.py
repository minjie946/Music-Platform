"""Convert MoisesDB into a Demucs "wav" dataset with our 10 canonical stems.

Output layout (what Demucs training expects via ``dset.wav=<out>``)::

    <out>/<track_id>/mixture.wav
    <out>/<track_id>/lead_vocals.wav
    <out>/<track_id>/backing_vocals.wav
    <out>/<track_id>/drums.wav
    <out>/<track_id>/bass.wav
    <out>/<track_id>/acoustic_guitar.wav
    <out>/<track_id>/electric_guitar.wav
    <out>/<track_id>/piano.wav
    <out>/<track_id>/synth.wav
    <out>/<track_id>/strings.wav
    <out>/<track_id>/other.wav

Every track folder contains all 10 stems (silent if a stem is absent) plus the
mixture, which is required by the Demucs wav dataset loader.

Usage::

    pip install moisesdb soundfile numpy
    python prepare_moisesdb.py --moisesdb /path/to/moisesdb_v0.1 --out /path/to/dataset

The MoisesDB sub-source taxonomy is mapped to our canonical stems below. These
matchers are intentionally tolerant (substring based); verify them against your
downloaded copy and tweak SUBTYPE_RULES / STEM_FALLBACK as needed.
"""
from __future__ import annotations

import argparse
import json
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

# (substring-in-trackType, canonical) — first match wins. Checked before the
# per-stem fallback. Lets us split vocals -> lead/backing and guitar -> ac/el.
SUBTYPE_RULES: list[tuple[str, str]] = [
    ("background", "backing_vocals"),
    ("backing", "backing_vocals"),
    ("bgv", "backing_vocals"),
    ("lead", "lead_vocals"),
    ("acoustic guitar", "acoustic_guitar"),
    ("electric guitar", "electric_guitar"),
    ("distorted", "electric_guitar"),
    ("clean electric", "electric_guitar"),
    ("synth", "synth"),
    ("organ", "synth"),
    ("electric piano", "synth"),
]

# Top-level MoisesDB stem name -> canonical fallback (when no subtype rule hits).
STEM_FALLBACK: dict[str, str] = {
    "vocals": "lead_vocals",
    "drums": "drums",
    "percussion": "other",
    "bass": "bass",
    "guitar": "electric_guitar",
    "piano": "piano",
    "other_keys": "synth",
    "bowed_strings": "strings",
    "strings": "strings",
    "wind": "other",
    "other": "other",
    "other_plucked": "other",
}


def classify(stem_name: str, track_type: str | None) -> str:
    tt = (track_type or "").lower()
    for needle, canon in SUBTYPE_RULES:
        if needle in tt:
            return canon
    return STEM_FALLBACK.get(stem_name, "other")


def iter_sources(track_dir: Path):
    """Yield (canonical_stem, wav_path) for every source file in a track.

    Handles both data.json schemas seen in the wild: ``stems`` as a dict of
    {stem: [sources]} or as a list of {stemName/name, tracks/sources:[...]}.
    """
    data = json.loads((track_dir / "data.json").read_text("utf-8"))
    stems = data.get("stems", data.get("tracks", {}))

    def emit(stem_name: str, source: dict):
        sid = source.get("id") or source.get("file") or source.get("filename")
        if not sid:
            return None
        track_type = source.get("trackType") or source.get("type") or source.get("track_type")
        # File typically at <track>/<stem>/<id>.wav
        candidates = [
            track_dir / stem_name / f"{sid}.wav",
            track_dir / stem_name / f"{sid}",
            track_dir / f"{sid}.wav",
        ]
        for c in candidates:
            if c.exists():
                return classify(stem_name, track_type), c
        return None

    if isinstance(stems, dict):
        for stem_name, sources in stems.items():
            for source in sources or []:
                if isinstance(source, dict):
                    res = emit(stem_name, source)
                    if res:
                        yield res
    elif isinstance(stems, list):
        for entry in stems:
            stem_name = entry.get("stemName") or entry.get("name") or "other"
            for source in entry.get("tracks") or entry.get("sources") or []:
                res = emit(stem_name, source)
                if res:
                    yield res


def load_audio(path: Path) -> np.ndarray:
    """Load as float32 (channels, samples) at SAMPLE_RATE/CHANNELS."""
    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)  # (samples, ch)
    audio = audio.T  # (ch, samples)
    if audio.shape[0] == 1:
        audio = np.repeat(audio, CHANNELS, axis=0)
    elif audio.shape[0] > CHANNELS:
        audio = audio[:CHANNELS]
    if sr != SAMPLE_RATE:
        try:
            import librosa

            audio = librosa.resample(audio, orig_sr=sr, target_sr=SAMPLE_RATE)
        except Exception as exc:  # pragma: no cover
            raise SystemExit(
                f"采样率 {sr} != {SAMPLE_RATE} 且无法重采样，请 pip install librosa: {exc}"
            )
    return audio


def process_track(track_dir: Path, out_dir: Path) -> bool:
    buckets: dict[str, np.ndarray] = {}
    max_len = 0
    for canon, wav_path in iter_sources(track_dir):
        try:
            audio = load_audio(wav_path)
        except Exception as exc:
            print(f"  跳过 {wav_path.name}: {exc}")
            continue
        max_len = max(max_len, audio.shape[1])
        if canon in buckets:
            a, b = buckets[canon], audio
            n = max(a.shape[1], b.shape[1])
            a = np.pad(a, ((0, 0), (0, n - a.shape[1])))
            b = np.pad(b, ((0, 0), (0, n - b.shape[1])))
            buckets[canon] = a + b
        else:
            buckets[canon] = audio

    if not buckets:
        return False

    dest = out_dir / track_dir.name
    dest.mkdir(parents=True, exist_ok=True)

    mixture = np.zeros((CHANNELS, max_len), dtype="float32")
    for canon in CANONICAL:
        audio = buckets.get(canon)
        if audio is None:
            audio = np.zeros((CHANNELS, max_len), dtype="float32")
        elif audio.shape[1] < max_len:
            audio = np.pad(audio, ((0, 0), (0, max_len - audio.shape[1])))
        sf.write(str(dest / f"{canon}.wav"), audio.T, SAMPLE_RATE)
        mixture[:, : audio.shape[1]] += audio[:, :max_len]

    sf.write(str(dest / "mixture.wav"), mixture.T, SAMPLE_RATE)
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--moisesdb", required=True, help="MoisesDB 根目录 (含各 track 文件夹)")
    ap.add_argument("--out", required=True, help="输出 Demucs wav 数据集目录")
    ap.add_argument("--limit", type=int, default=0, help="仅处理前 N 个 track (调试)")
    args = ap.parse_args()

    root = Path(args.moisesdb)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    tracks = [d for d in sorted(root.iterdir()) if d.is_dir() and (d / "data.json").exists()]
    if args.limit:
        tracks = tracks[: args.limit]
    print(f"发现 {len(tracks)} 个 track，开始转换 -> {out_dir}")

    ok = 0
    for i, track_dir in enumerate(tracks, 1):
        print(f"[{i}/{len(tracks)}] {track_dir.name}")
        if process_track(track_dir, out_dir):
            ok += 1
    print(f"完成：成功 {ok}/{len(tracks)}。源 = {CANONICAL}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
