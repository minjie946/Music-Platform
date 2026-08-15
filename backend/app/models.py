"""Pydantic models for API requests/responses and job state."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class JobState(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"


class StemResult(BaseModel):
    stem: str
    label_zh: str
    label_en: str
    filename: str
    url: str
    size_bytes: int = 0
    duration_sec: float | None = None


class GenTrack(BaseModel):
    index: int
    filename: str
    url: str
    size_bytes: int = 0
    duration_sec: float | None = None
    seed: str = ""


class MidiNote(BaseModel):
    """A single note in a MIDI clip (time relative to the clip start)."""

    pitch: int              # MIDI note number 0..127
    start_sec: float        # onset relative to clip start
    dur_sec: float          # note length in seconds
    velocity: int = 100     # 1..127


class MidiClip(BaseModel):
    """MIDI clip data, rendered to audio by fluidsynth at export time."""

    program: int = 0                                    # GM program 0..127 (0 = grand piano)
    notes: list[MidiNote] = Field(default_factory=list)


class VocalFxSpec(BaseModel):
    """人声效果器（一键叠声）参数。"""

    enabled: bool = False
    preset: str = "harmony"   # harmony | double | wide
    intensity: float = 100.0  # 0..100


class AutotuneSpec(BaseModel):
    """Autotune 音高校正参数。"""

    enabled: bool = False
    key: str = "C 大调"        # 目标调性（中文调名）
    responseMs: float = 44.0  # 校正响应速度：越小越“电音”
    naturalness: float = 6.0  # 0..100：越大越自然


class ReverbDockSpec(BaseModel):
    """底部混响面板参数（距离 + 强度）。"""

    enabled: bool = False
    distance: str = "near"    # near | mid | far
    amount: float = 0.0       # 0..100


class DockEffects(BaseModel):
    """底部常驻效果面板参数（人声效果器 / Autotune / 混响）。"""

    vocalFx: VocalFxSpec = Field(default_factory=VocalFxSpec)
    autotune: AutotuneSpec = Field(default_factory=AutotuneSpec)
    reverb: ReverbDockSpec = Field(default_factory=ReverbDockSpec)


class ClipEffects(BaseModel):
    """Per-lane effect chain, rendered by ffmpeg filters at export time."""

    eq_enabled: bool = False
    eq_low_db: float = 0.0       # ~100Hz shelf/peak gain
    eq_mid_db: float = 0.0       # ~1kHz
    eq_high_db: float = 0.0      # ~8kHz
    reverb_enabled: bool = False
    reverb_amount: float = 0.3   # 0..1 room strength
    comp_enabled: bool = False
    comp_amount: float = 0.5     # 0..1 -> ratio/threshold
    delay_enabled: bool = False
    delay_ms: float = 250.0      # single echo delay
    delay_feedback: float = 0.3  # 0..1
    dock: DockEffects | None = None  # 底部面板：Autotune / 一键叠声 / 混响距离


class EditTrackSpec(BaseModel):
    """One source track for the music editor mixdown."""

    source: str = "separation"      # "separation" | "generation" | "upload" | "midi"
    job_id: str = ""                # source job (separation/generation)
    stem_id: str = ""               # separation source: which stem
    index: int = 0                  # generation source: which track index
    upload_name: str = ""           # upload source: staged filename
    label: str = ""                 # display label (echoed back, optional)
    gain: float = 1.0               # linear gain (UI converts from dB)
    mute: bool = False
    pan: float = 0.0                # -1(左)..0(中)..1(右)
    semitones: float = 0.0          # per-track pitch shift
    offset_sec: float = 0.0         # clip start position on the timeline
    clip_start_sec: float = 0.0     # trim in-point within the source
    clip_end_sec: float = 0.0       # trim out-point (0 = to end)
    effects: ClipEffects = Field(default_factory=ClipEffects)  # per-lane FX chain
    midi: MidiClip | None = None    # present when source == "midi"


class EditRequest(BaseModel):
    """User-facing music-editor mixdown request."""

    tracks: list[EditTrackSpec] = Field(default_factory=list)
    tempo: float = 1.0              # global tempo (speed, pitch preserved)
    master_semitones: float = 0.0   # global pitch shift on the final mix
    output_format: str = "wav"      # wav | mp3
    title: str = ""


class MelodyRequest(BaseModel):
    """旋律生成请求（本地引擎）。"""

    backing: EditTrackSpec | None = None  # 可选：分析该伴奏轨的 key/bpm
    duration_sec: float = 16.0
    key_name: str | None = None           # 无伴奏时使用（中文调名）
    bpm: float | None = None
    seed: int | None = None
    syllables: int | None = None          # 歌词音节数（配唱时按此生成音符数）
    program: int = 0                      # GM 音色（0=大钢琴；人声可选 choir 52 等）


class MelodyResult(BaseModel):
    """旋律生成结果：可直接构造为编辑器的 MIDI 轨。"""

    bpm: float
    key_name: str
    program: int = 0
    notes: list[MidiNote] = Field(default_factory=list)


class JobStatus(BaseModel):
    id: str
    state: JobState
    progress: int = 0
    stage: str = ""
    engine: str = "demucs"
    kind: str = "separation"  # "separation" | "generation"
    requested_stems: list[str] = Field(default_factory=list)
    output_format: str = "wav"  # separation export container: wav | mp3
    original_filename: str = ""
    error: str | None = None
    created_at: float = 0.0
    updated_at: float = 0.0
    stems: list[StemResult] = Field(default_factory=list)
    # Generated audio tracks (kind == "generation").
    tracks: list[GenTrack] = Field(default_factory=list)
    title: str = ""


class StemCapability(BaseModel):
    id: str
    label_zh: str
    label_en: str
    supported: bool
    note: str = ""


class EngineCapabilities(BaseModel):
    engine: str
    stems: list[StemCapability]


class RuntimeSettingsOut(BaseModel):
    default_engine: str
    lalal_api_key_set: bool
    lalal_api_key_masked: str = ""
    cascade_vocal_split: bool = False
    karaoke_model: str = ""
    workspace_dir: str = ""
    acestep_checkpoints_dir: str = ""
    generation_output_dir: str = ""
    history_output_dir: str = ""
    separation_output_dir: str = ""
    acestep_tmp_dir: str = ""
    gen_dit_model: str = ""
    gen_lm_model: str = ""
    generation_performance_mode: str = "conservative"
    svc_models_dir: str = ""
    vendor_dir: str = ""
    resources_dir: str = ""
    # Resolved effective paths (defaults applied) for display.
    effective_checkpoints_dir: str = ""
    effective_generation_dir: str = ""
    effective_history_dir: str = ""
    effective_separation_dir: str = ""
    effective_acestep_tmp_dir: str = ""
    effective_uploads_dir: str = ""
    effective_svc_models_dir: str = ""
    path_migration_summary: list[str] = Field(default_factory=list)


class RuntimeSettingsIn(BaseModel):
    default_engine: str | None = None
    lalal_api_key: str | None = None
    cascade_vocal_split: bool | None = None
    karaoke_model: str | None = None
    workspace_dir: str | None = None
    acestep_checkpoints_dir: str | None = None
    generation_output_dir: str | None = None
    history_output_dir: str | None = None
    separation_output_dir: str | None = None
    acestep_tmp_dir: str | None = None
    gen_dit_model: str | None = None
    gen_lm_model: str | None = None
    generation_performance_mode: str | None = None
    svc_models_dir: str | None = None
    vendor_dir: str | None = None
    resources_dir: str | None = None
    migrate_existing_data: bool | None = None
    cleanup_old_temp_cache: bool | None = None


class InitRequest(BaseModel):
    """Optional model overrides for the initialization (download + load) job."""

    dit_model: str | None = None
    lm_model: str | None = None       # "none" = no LM
    force_memory_guard: bool = False


class GenerationParams(BaseModel):
    """User-facing generation request (maps to ACE-Step /release_task)."""

    title: str = ""                 # optional song name, used as output filename
    prompt: str = ""                # caption / style description
    lyrics: str = ""
    instrumental: bool = False      # pure instrumental (no vocals): force [Instrumental] lyrics
    sample_query: str = ""          # natural-language one-liner (simple mode)
    # Music-generation LoRA to apply for this run ("" = none). Refers to a
    # LoraPreset.id whose adapter must already be downloaded locally.
    lora_id: str = ""
    audio_duration: float | None = None  # seconds, 10-600
    bpm: int | None = None
    key_scale: str = ""
    time_signature: str = ""
    vocal_language: str = "en"
    inference_steps: int = 8
    guidance_scale: float = 7.0
    batch_size: int = 1
    thinking: bool = True           # use 5Hz LM for higher quality
    use_format: bool = False        # let LM enhance caption/lyrics
    audio_format: str = "wav"
    model: str | None = None        # DiT model override
    use_random_seed: bool = True
    seed: int = -1
    task_type: str = "text2music"   # text2music/cover/repaint/complete/lego/extract

    # ----- vocal mode (SVC voice conversion of the generated vocals) -----
    vocal_mode: bool = False        # convert the generated vocals to a trained voice
    voice_id: str = ""              # selected SVC voice model id
    svc_engine: str = ""            # engine of the voice (informational; resolved server-side)
    svc_transpose: int = 0          # semitone shift applied during conversion

    # ----- DiT sampling (base-model knobs; ignored by turbo) -----
    infer_method: str = "ode"       # "ode" (faster) or "sde" (stochastic)
    shift: float = 3.0              # time-step shift factor, 1.0-5.0
    use_adg: bool = False           # adaptive dual guidance
    cfg_interval_start: float = 0.0
    cfg_interval_end: float = 1.0

    # ----- 5Hz LM sampling (only used when thinking / LM active) -----
    lm_temperature: float = 0.85
    lm_cfg_scale: float = 2.5
    lm_top_p: float = 0.9
    lm_top_k: int | None = None
    lm_repetition_penalty: float = 1.0
    use_cot_caption: bool = True
    use_cot_language: bool = True
    constrained_decoding: bool = True

    # ----- editing / reference-audio modes -----
    instruction: str = ""
    repainting_start: float = 0.0
    repainting_end: float | None = None
    audio_cover_strength: float = 1.0
    src_audio_token: str = ""        # staged upload token (repaint/cover/complete)
    reference_audio_token: str = ""  # staged upload token (style transfer)


class GenModelInfo(BaseModel):
    name: str
    is_default: bool = False


class GenModelOption(BaseModel):
    """A selectable generation model (DiT or LM) with a recommendation flag."""

    name: str
    label: str = ""
    recommended: bool = False


class GenHistoryTrack(BaseModel):
    filename: str
    size_bytes: int = 0


class GenHistoryItem(BaseModel):
    job_id: str
    title: str = ""
    created_at: float = 0.0          # epoch seconds (dir mtime)
    tracks: list["GenHistoryTrack"] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)


class SvcVoice(BaseModel):
    id: str
    name: str = ""
    engine: str = ""
    created_at: float = 0.0
    ready: bool = False


class SvcEngineCapability(BaseModel):
    infer_available: bool = False
    train_available: bool = False
    note: str = ""


class SvcCapabilities(BaseModel):
    service_up: bool = False
    device: str = "cpu"
    engines: dict[str, SvcEngineCapability] = Field(default_factory=dict)
    reason: str = ""


class SvcTrainStatus(BaseModel):
    train_id: str
    voice_id: str = ""
    state: str = "queued"            # queued | running | done | failed
    progress: int = 0
    stage: str = ""
    error: str = ""


class GenerationCapabilities(BaseModel):
    available: bool
    reason: str = ""
    service_up: bool = False
    # Model readiness for the init UX.
    model_downloaded: bool = False   # main components present on disk
    model_ready: bool = False        # loaded into memory (ACE-Step initialized)
    initializing: bool = False       # an init job is currently running
    device: str = "cpu"
    gpu_name: str = ""
    vram_gb: float = 0.0
    ram_gb: float = 0.0
    os: str = ""
    arch: str = ""
    recommended_dit: str = ""
    recommended_lm: str | None = None
    max_batch_size: int = 1
    max_duration_sec: int = 270
    models: list[GenModelInfo] = Field(default_factory=list)
    # Selectable model options (with recommended flags) + the current selection.
    dit_options: list[GenModelOption] = Field(default_factory=list)
    lm_options: list[GenModelOption] = Field(default_factory=list)
    selected_dit: str = ""
    selected_lm: str = ""              # "none" = no LM
    loaded_dit: str = ""               # model currently loaded in ACE-Step
    loaded_lm: str = ""
    loaded_dit_path: str = ""
    loaded_lm_path: str = ""
    ffmpeg_available: bool = False
    performance_mode: str = "conservative"
    # True once the user has explicitly chosen/cached a model selection, so the
    # setup screen can skip the picker on subsequent launches.
    model_configured: bool = False
    checkpoints_dir: str = ""
    output_dir: str = ""


class LoraItem(BaseModel):
    """One catalog LoRA plus its local availability/compatibility state."""

    id: str
    name: str
    repo: str
    category: str
    category_label: str = ""
    description: str = ""
    downloaded: bool = False
    compatible: bool = True        # matches the currently loaded/selected DiT base
    download_status: str = "idle"  # idle | downloading | done | failed
    download_loaded: int = 0
    download_total: int = 0
    download_error: str = ""


class LoraListResponse(BaseModel):
    selected_dit: str = ""
    items: list[LoraItem] = Field(default_factory=list)


class LoraDownloadRequest(BaseModel):
    id: str
