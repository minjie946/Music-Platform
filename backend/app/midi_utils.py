"""MIDI clip synthesis for the music editor.

MIDI tracks are rendered to audio at export time and then fed into the same
``mix_tracks`` pipeline as ordinary audio clips. We generate a standard ``.mid``
with ``mido`` and render it to WAV via the ``fluidsynth`` command line (mirrors
how ffmpeg is invoked in ``audio_utils``), so there is no Python C-extension /
dynamic-library binding to package.

Binary/asset resolution order (mirrors ``audio_utils._resolve``):
- fluidsynth: ``APP_FLUIDSYNTH_EXE`` -> ``fluidsynth`` on PATH.
- SoundFont:  ``APP_SOUNDFONT`` -> ``backend/assets/soundfont.sf2``.
"""
from __future__ import annotations

import functools
import os
import shutil
import subprocess
from pathlib import Path

from .audio_utils import write_wav

_TICKS_PER_BEAT = 480
_TEMPO_BPM = 120.0
_SEC_PER_BEAT = 60.0 / _TEMPO_BPM


@functools.lru_cache(maxsize=1)
def _fluidsynth_exe() -> str:
    explicit = os.environ.get("APP_FLUIDSYNTH_EXE")
    if explicit and os.path.isfile(explicit):
        return explicit
    system = shutil.which("fluidsynth")
    if system:
        return system
    raise RuntimeError(
        "未找到 fluidsynth：请安装（macOS: brew install fluid-synth）或设置 APP_FLUIDSYNTH_EXE。"
    )


@functools.lru_cache(maxsize=1)
def _soundfont_path() -> str:
    explicit = os.environ.get("APP_SOUNDFONT")
    if explicit and os.path.isfile(explicit):
        return explicit
    bundled = Path(__file__).resolve().parent.parent / "assets" / "soundfont.sf2"
    if bundled.is_file():
        return str(bundled)
    raise RuntimeError(
        "未找到 SoundFont 音色库：请将 .sf2 放到 backend/assets/soundfont.sf2 或设置 APP_SOUNDFONT。"
    )


def _sec_to_ticks(sec: float) -> int:
    return max(0, int(round((sec / _SEC_PER_BEAT) * _TICKS_PER_BEAT)))


def _clip_duration(clip) -> float:
    notes = getattr(clip, "notes", None) or []
    return max((float(n.start_sec) + float(n.dur_sec) for n in notes), default=0.0)


def notes_to_midi_file(clip, dest) -> None:
    """Write a MidiClip to a standard .mid file (single track, 120 BPM)."""
    import mido

    mid = mido.MidiFile(ticks_per_beat=_TICKS_PER_BEAT)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(_TEMPO_BPM), time=0))
    program = max(0, min(127, int(getattr(clip, "program", 0))))
    track.append(mido.Message("program_change", program=program, time=0))

    # Build absolute-tick on/off events, then emit as delta times.
    events: list[tuple[int, int, int, int]] = []  # (tick, kind(1=on,0=off), pitch, velocity)
    for n in getattr(clip, "notes", None) or []:
        pitch = max(0, min(127, int(n.pitch)))
        vel = max(1, min(127, int(n.velocity)))
        on = _sec_to_ticks(float(n.start_sec))
        off = max(on + 1, _sec_to_ticks(float(n.start_sec) + float(n.dur_sec)))
        events.append((on, 1, pitch, vel))
        events.append((off, 0, pitch, 0))
    # Sort by tick, note-off before note-on at the same tick.
    events.sort(key=lambda e: (e[0], e[1]))

    prev = 0
    for tick, kind, pitch, vel in events:
        delta = tick - prev
        prev = tick
        if kind == 1:
            track.append(mido.Message("note_on", note=pitch, velocity=vel, time=delta))
        else:
            track.append(mido.Message("note_off", note=pitch, velocity=0, time=delta))
    mid.save(str(dest))


def render_midi_to_wav(clip, dest_wav, samplerate: int = 44100) -> None:
    """Render a MidiClip to a WAV file via fluidsynth.

    Empty clips (no notes) produce a short silent WAV so downstream mixing has a
    valid input without invoking fluidsynth on an empty score.
    """
    import numpy as np

    dest_wav = Path(dest_wav)
    duration = _clip_duration(clip)
    if not (getattr(clip, "notes", None) or []) or duration <= 0:
        silent = np.zeros((2, max(1, int(samplerate * max(0.1, duration)))), dtype="float32")
        write_wav(dest_wav, silent, samplerate)
        return

    fluidsynth = _fluidsynth_exe()
    soundfont = _soundfont_path()
    midi_path = dest_wav.with_suffix(".mid")
    notes_to_midi_file(clip, midi_path)
    cmd = [
        fluidsynth,
        "-ni",
        "-g",
        "1.0",
        "-r",
        str(samplerate),
        "-F",
        str(dest_wav),
        soundfont,
        str(midi_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
