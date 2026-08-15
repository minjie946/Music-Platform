"""本地开源人声处理引擎：Autotune（音高校正）与 Harmony（一键叠声）。

依赖 librosa + scipy 做音高检测与保 formant 的移调（psola 风格），
比纯 ffmpeg 重采样移调音质更好、无“花栗鼠”效应。
所有函数在无人声/静音输入时安全退化（直接拷贝）。
"""

from __future__ import annotations

from pathlib import Path

from .audio_utils import (
    decode_to_wav,
    ensure_stereo,
    read_wav,
    soft_limit,
    write_wav,
)

# 中文调名 -> 主音半音（相对 C=0）与音阶类型。
_NOTE_TO_SEMITONE = {
    "C": 0, "G": 7, "D": 2, "A": 9, "E": 4, "B": 11, "F": 5,
}
# 大调 / 小调（自然小调）音级（相对主音的半音集合）。
_MAJOR = [0, 2, 4, 5, 7, 9, 11]
_MINOR = [0, 2, 3, 5, 7, 8, 10]


def parse_key(key: str) -> tuple[int, list[int]]:
    """解析中文调名（如 "B 小调"/"C 大调"）-> (主音半音, 允许的音级半音集合)。"""
    k = (key or "").strip()
    tonic = 0
    for name, semi in _NOTE_TO_SEMITONE.items():
        if k.upper().startswith(name):
            tonic = semi
            break
    scale = _MINOR if "小" in k else _MAJOR
    allowed = sorted({(tonic + s) % 12 for s in scale})
    return tonic, allowed


def _nearest_scale_midi(midi: float, allowed: list[int]) -> float:
    """把一个（浮点）MIDI 音高吸附到最近的音阶内音高。"""
    import numpy as np

    base = int(np.floor(midi))
    candidates = []
    for octave in range(-1, 2):
        for pc in allowed:
            # 找到与 base 同区附近、pitch class 为 pc 的 midi 值
            cand = (base - (base % 12)) + pc + 12 * octave
            candidates.append(cand)
    candidates = np.array(candidates, dtype="float64")
    return float(candidates[np.argmin(np.abs(candidates - midi))])


def apply_autotune(
    src: str | Path,
    dest: str | Path,
    key: str = "C 大调",
    response_ms: float = 44.0,
    naturalness: float = 6.0,
    samplerate: int = 44100,
) -> None:
    """把 src 的人声按目标调性做音高校正，写到 dest。

    - key: 目标调性；检测到的每一帧音高吸附到该调音阶最近音。
    - response_ms: 校正强度平滑窗（越小越“硬”越电音，越大越柔和）。
    - naturalness: 0..100，越大越保留原始音高微差（越自然）。
    """
    import numpy as np
    import librosa

    wav_tmp = str(dest) + ".in.wav"
    decode_to_wav(src, wav_tmp, samplerate=samplerate, channels=1)
    data, sr = read_wav(wav_tmp)
    Path(wav_tmp).unlink(missing_ok=True)
    y = data[0].astype("float64")
    if y.size == 0 or float(np.max(np.abs(y))) < 1e-4:
        write_wav(dest, ensure_stereo(data), sr)
        return

    _tonic, allowed = parse_key(key)
    fmin = librosa.note_to_hz("C2")
    fmax = librosa.note_to_hz("C6")
    frame_length = 2048
    hop = 512
    # pyin 提供逐帧基频 + voiced 概率。
    f0, voiced, _prob = librosa.pyin(
        y, fmin=fmin, fmax=fmax, sr=sr, frame_length=frame_length, hop_length=hop
    )

    # 每帧目标音高与当前音高之差（半音）。
    n = len(f0)
    shift_semi = np.zeros(n, dtype="float64")
    natural = max(0.0, min(1.0, naturalness / 100.0))
    for i in range(n):
        if not voiced[i] or not np.isfinite(f0[i]) or f0[i] <= 0:
            continue
        midi = librosa.hz_to_midi(f0[i])
        target = _nearest_scale_midi(midi, allowed)
        correction = target - midi
        # naturalness 越高，越少纠正（保留人声微起伏）。
        shift_semi[i] = correction * (1.0 - natural * 0.5)

    # 平滑校正曲线：response_ms 越大窗口越长（越柔）。
    win = max(1, int((response_ms / 1000.0) * sr / hop))
    if win > 1:
        kernel = np.ones(win) / win
        shift_semi = np.convolve(shift_semi, kernel, mode="same")

    # 用较大的重叠块做 pitch shift（块内取中心帧的校正量），
    # 汉宁窗重叠相加，避免逐小帧 pitch_shift 的边界噪声。
    block = 4096
    step = block // 2
    out = np.zeros(len(y), dtype="float64")
    window = np.hanning(block)
    norm = np.zeros(len(y), dtype="float64")
    for start in range(0, len(y), step):
        end = min(start + block, len(y))
        seg = y[start:end]
        if seg.size < 32:
            break
        # 该块中心对应的帧索引，取其校正量。
        frame_idx = min(n - 1, (start + seg.size // 2) // hop)
        s = shift_semi[frame_idx] if n > 0 else 0.0
        if abs(s) < 1e-3:
            shifted = seg
        else:
            shifted = librosa.effects.pitch_shift(seg, sr=sr, n_steps=s)
            shifted = shifted[: seg.size]
        w = window[: seg.size]
        out[start:end] += shifted * w
        norm[start:end] += w

    norm[norm < 1e-6] = 1.0
    out = out / norm

    peak = float(np.max(np.abs(out)))
    if peak > 1e-6:
        out = out / peak * float(np.max(np.abs(y)))
    stereo = ensure_stereo(np.asarray(out, dtype="float32")[None, :])
    write_wav(dest, soft_limit(stereo), sr)


# 叠声预设 -> 叠加的和声音程（半音）。
_HARMONY_INTERVALS = {
    "harmony": [-12, 4, 7],   # 低八度 + 三度 + 五度
    "double": [0, 0],          # 轻微加倍（配合微延迟制造厚度）
    "wide": [-5, 5],           # 左右四度加宽
}


def apply_harmony(
    src: str | Path,
    dest: str | Path,
    preset: str = "harmony",
    intensity: float = 100.0,
    samplerate: int = 44100,
) -> None:
    """为 src 人声生成并叠加和声声部，写到 dest（保 formant 移调）。

    intensity 0..100 控制叠声相对主唱的音量。
    """
    import numpy as np
    import librosa

    wav_tmp = str(dest) + ".in.wav"
    decode_to_wav(src, wav_tmp, samplerate=samplerate, channels=2)
    data, sr = read_wav(wav_tmp)
    Path(wav_tmp).unlink(missing_ok=True)
    data = ensure_stereo(data)
    if data.size == 0 or float(np.max(np.abs(data))) < 1e-4:
        write_wav(dest, data, sr)
        return

    intervals = _HARMONY_INTERVALS.get(preset, _HARMONY_INTERVALS["harmony"])
    amt = max(0.0, min(1.0, intensity / 100.0))
    mono = data.mean(axis=0).astype("float64")

    mix = data.astype("float64").copy()
    voices = max(1, len(intervals))
    per_voice_gain = amt * 0.6 / voices
    for idx, semi in enumerate(intervals):
        if abs(semi) < 1e-3:
            shifted = mono.copy()
        else:
            shifted = librosa.effects.pitch_shift(mono, sr=sr, n_steps=float(semi))
        shifted = shifted[: mono.shape[0]]
        if preset == "wide":
            # 不同声部分置左右声道加宽立体声。
            if idx % 2 == 0:
                mix[0, : shifted.shape[0]] += shifted * per_voice_gain
                mix[1, : shifted.shape[0]] += shifted * per_voice_gain * 0.3
            else:
                mix[0, : shifted.shape[0]] += shifted * per_voice_gain * 0.3
                mix[1, : shifted.shape[0]] += shifted * per_voice_gain
        else:
            mix[0, : shifted.shape[0]] += shifted * per_voice_gain
            mix[1, : shifted.shape[0]] += shifted * per_voice_gain

    out = soft_limit(np.asarray(mix, dtype="float32"))
    write_wav(dest, out, sr)
