"""本地旋律生成引擎（全开源，无需联网/大模型）。

流程：分析伴奏音频的 BPM 与调性（librosa）→ 按调内音阶用带节奏的
随机游走生成一条旋律线（list[MidiNote]）。用于编辑器「旋律灵感 / 伴奏配人声演唱」。
"""

from __future__ import annotations

import random
from pathlib import Path

from .audio_utils import decode_to_wav, read_wav

# 大调 / 自然小调音级（相对主音的半音）。
_MAJOR = [0, 2, 4, 5, 7, 9, 11]
_MINOR = [0, 2, 3, 5, 7, 8, 10]
_PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def analyze_audio(src: str | Path, samplerate: int = 44100) -> dict:
    """估计音频的 BPM 与调性。返回 {bpm, tonic(0-11), mode('major'|'minor'), key_name}。"""
    import numpy as np
    import librosa

    wav_tmp = str(src) + ".analyze.wav"
    decode_to_wav(src, wav_tmp, samplerate=samplerate, channels=1)
    try:
        data, sr = read_wav(wav_tmp)
    finally:
        Path(wav_tmp).unlink(missing_ok=True)
    y = data[0].astype("float32")

    if y.size < sr // 2:
        return {"bpm": 120.0, "tonic": 0, "mode": "major", "key_name": "C 大调"}

    # BPM
    try:
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
    except Exception:  # noqa: BLE001
        bpm = 120.0
    if not (40 <= bpm <= 240):
        bpm = 120.0

    # 调性：用 chroma 的平均能量与大/小调模板做相关，取最佳主音+调式。
    tonic, mode = _estimate_key(y, sr)
    key_name = f"{_PITCH_CLASSES[tonic]} {'大调' if mode == 'major' else '小调'}"
    return {"bpm": round(bpm, 1), "tonic": tonic, "mode": mode, "key_name": key_name}


def _estimate_key(y, sr) -> tuple[int, str]:
    """Krumhansl 风格：chroma 均值与 12 个旋转的大/小调模板相关，取最大。"""
    import numpy as np
    import librosa

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    profile = chroma.mean(axis=1)
    if float(profile.sum()) <= 1e-6:
        return 0, "major"
    profile = profile / profile.sum()

    major_tpl = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor_tpl = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    major_tpl = major_tpl / major_tpl.sum()
    minor_tpl = minor_tpl / minor_tpl.sum()

    best = (-1.0, 0, "major")
    for tonic in range(12):
        maj = np.corrcoef(profile, np.roll(major_tpl, tonic))[0, 1]
        mino = np.corrcoef(profile, np.roll(minor_tpl, tonic))[0, 1]
        if maj > best[0]:
            best = (maj, tonic, "major")
        if mino > best[0]:
            best = (mino, tonic, "minor")
    return best[1], best[2]


def generate_melody_notes(
    bpm: float,
    tonic: int,
    mode: str,
    duration_sec: float,
    seed: int | None = None,
    syllables: int | None = None,
) -> list[dict]:
    """按调性/速度生成一条旋律线，返回 [{pitch,start_sec,dur_sec,velocity}, ...]。

    - 时值以八分/四分音符为主，落在拍点上，贴合 BPM。
    - 音高在该调音阶内做带引力的随机游走（倾向回到主音/三度/五度）。
    - syllables 若给定（歌词音节数），生成对应数量的音符，便于“配唱”对齐。
    """
    rng = random.Random(seed)
    scale = _MAJOR if mode == "major" else _MINOR
    beat = 60.0 / max(40.0, min(240.0, bpm))
    # 可用音高：主音上下一个八度内的音阶音（MIDI）。
    base = 60 + tonic  # 以中央 C 区为中心
    pitches: list[int] = []
    for octave in (-12, 0, 12):
        for s in scale:
            pitches.append(base + octave + s)
    pitches = sorted(p for p in pitches if 48 <= p <= 84)

    # 稳定音（主/三/五）索引，用于引力。
    stable_pcs = {tonic % 12, (tonic + scale[2]) % 12, (tonic + scale[4]) % 12}

    notes: list[dict] = []
    t = 0.0
    idx = pitches.index(min(pitches, key=lambda p: abs(p - (base + scale[4]))))
    count = 0
    max_notes = syllables if syllables and syllables > 0 else None
    durations = [beat * 0.5, beat, beat, beat * 1.5]  # 偏向八分/四分

    while t < duration_sec - 1e-3:
        if max_notes is not None and count >= max_notes:
            break
        # 随机游走：小步移动，稳定音处更可能停留/跳到主音。
        step = rng.choice([-2, -1, -1, 0, 1, 1, 2])
        idx = max(0, min(len(pitches) - 1, idx + step))
        pitch = pitches[idx]
        # 若临近乐句末，吸附到稳定音。
        remaining = duration_sec - t
        dur = rng.choice(durations)
        if remaining < beat * 1.5 or (pitch % 12) not in stable_pcs and rng.random() < 0.25:
            # 靠拢最近的稳定音
            cand = min(pitches, key=lambda p: (abs(p - pitch), (p % 12) not in stable_pcs))
            pitch = cand
            idx = pitches.index(cand)
        dur = min(dur, remaining)
        if dur <= 1e-3:
            break
        notes.append(
            {
                "pitch": int(pitch),
                "start_sec": round(t, 4),
                "dur_sec": round(dur * 0.92, 4),  # 留一点断音间隙
                "velocity": rng.randint(80, 110),
            }
        )
        t += dur
        count += 1

    return notes


def generate_melody(
    src: str | Path | None,
    duration_sec: float,
    key_name: str | None = None,
    bpm: float | None = None,
    seed: int | None = None,
    syllables: int | None = None,
) -> dict:
    """综合入口：有伴奏则先分析，否则用给定/默认 key+bpm，返回 {bpm,key_name,program,notes}。"""
    analysis = None
    if src is not None:
        try:
            analysis = analyze_audio(src)
        except Exception:  # noqa: BLE001 — 分析失败退回默认
            analysis = None

    if analysis:
        use_bpm = bpm or analysis["bpm"]
        tonic = analysis["tonic"]
        mode = analysis["mode"]
        use_key = analysis["key_name"]
    else:
        use_bpm = bpm or 120.0
        tonic, mode = _key_name_to_tonic_mode(key_name or "C 大调")
        use_key = key_name or "C 大调"

    notes = generate_melody_notes(use_bpm, tonic, mode, duration_sec, seed=seed, syllables=syllables)
    return {"bpm": use_bpm, "key_name": use_key, "program": 0, "notes": notes}


def _key_name_to_tonic_mode(key_name: str) -> tuple[int, str]:
    k = (key_name or "").strip()
    tonic = 0
    for i, pc in enumerate(_PITCH_CLASSES):
        if k.upper().startswith(pc):
            tonic = i
            break
    mode = "minor" if "小" in k else "major"
    return tonic, mode
