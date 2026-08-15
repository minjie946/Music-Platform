export type JobState = "queued" | "running" | "done" | "failed";

export interface StemResult {
  stem: string;
  label_zh: string;
  label_en: string;
  filename: string;
  url: string;
  size_bytes: number;
  duration_sec: number | null;
}

export interface GenTrack {
  index: number;
  filename: string;
  url: string;
  size_bytes: number;
  duration_sec: number | null;
  seed: string;
}

export interface JobStatus {
  id: string;
  state: JobState;
  progress: number;
  stage: string;
  engine: string;
  kind?: "separation" | "generation" | "edit";
  requested_stems: string[];
  output_format?: string;
  original_filename: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  stems: StemResult[];
  tracks?: GenTrack[];
  title?: string;
}

export interface ClipEffects {
  eq_enabled: boolean;
  eq_low_db: number;
  eq_mid_db: number;
  eq_high_db: number;
  reverb_enabled: boolean;
  reverb_amount: number;
  comp_enabled: boolean;
  comp_amount: number;
  delay_enabled: boolean;
  delay_ms: number;
  delay_feedback: number;
  /** 底部效果 Dock 参数（人声效果器/Autotune/混响距离），可选以兼容旧数据。 */
  dock?: DockEffects;
}

/** 底部常驻效果面板的参数模型。 */
export interface DockEffects {
  vocalFx: { enabled: boolean; preset: string; intensity: number };
  autotune: { enabled: boolean; key: string; responseMs: number; naturalness: number };
  reverb: { enabled: boolean; distance: string; amount: number };
}

export interface MidiNote {
  pitch: number;
  start_sec: number;
  dur_sec: number;
  velocity: number;
}

export interface MidiClip {
  program: number;
  notes: MidiNote[];
}

export interface EditTrackSpec {
  source: "separation" | "generation" | "upload" | "midi";
  job_id: string;
  stem_id: string;
  index: number;
  upload_name: string;
  label: string;
  gain: number;
  mute: boolean;
  /** 声像 -1(左) .. 0(中) .. 1(右)，可选以兼容旧数据。 */
  pan?: number;
  semitones: number;
  offset_sec: number;
  clip_start_sec: number;
  clip_end_sec: number;
  effects: ClipEffects;
  midi?: MidiClip;
}

export interface EditRequest {
  tracks: EditTrackSpec[];
  tempo: number;
  master_semitones: number;
  output_format: "wav" | "mp3";
  title: string;
}

export interface StemCapability {
  id: string;
  label_zh: string;
  label_en: string;
  supported: boolean;
  note: string;
}

export interface EngineCapabilities {
  engine: string;
  stems: StemCapability[];
}

export interface RuntimeSettingsOut {
  default_engine: string;
  lalal_api_key_set: boolean;
  lalal_api_key_masked: string;
  cascade_vocal_split: boolean;
  karaoke_model: string;
  workspace_dir: string;
  acestep_checkpoints_dir: string;
  generation_output_dir: string;
  history_output_dir: string;
  separation_output_dir: string;
  acestep_tmp_dir: string;
  gen_dit_model: string;
  gen_lm_model: string;
  generation_performance_mode: "conservative" | "standard" | "quality";
  svc_models_dir: string;
  vendor_dir: string;
  resources_dir: string;
  effective_checkpoints_dir: string;
  effective_generation_dir: string;
  effective_history_dir: string;
  effective_separation_dir: string;
  effective_acestep_tmp_dir: string;
  effective_uploads_dir: string;
  effective_svc_models_dir: string;
  path_migration_summary: string[];
}

export interface RuntimeLog {
  name: "launcher" | "api" | "worker" | "acestep" | "svc";
  path: string;
  exists: boolean;
  content: string;
}

export interface SvcVoice {
  id: string;
  name: string;
  engine: string;
  created_at: number;
  ready: boolean;
}

export interface SvcEngineCapability {
  infer_available: boolean;
  train_available: boolean;
  note: string;
}

export interface SvcCapabilities {
  service_up: boolean;
  device: string;
  engines: Record<string, SvcEngineCapability>;
  reason: string;
}

export interface SvcTrainStatus {
  train_id: string;
  voice_id: string;
  state: JobState;
  progress: number;
  stage: string;
  error: string;
}

export interface GenModelInfo {
  name: string;
  is_default: boolean;
}

export interface GenModelOption {
  name: string;
  label: string;
  recommended: boolean;
}

export interface GenHistoryTrack {
  filename: string;
  size_bytes: number;
}

export interface GenHistoryItem {
  job_id: string;
  title: string;
  created_at: number;
  tracks: GenHistoryTrack[];
  params: Record<string, unknown>;
}

export interface GenerationCapabilities {
  available: boolean;
  reason: string;
  service_up: boolean;
  model_downloaded: boolean;
  model_ready: boolean;
  initializing: boolean;
  checkpoints_dir: string;
  output_dir: string;
  device: string;
  gpu_name: string;
  vram_gb: number;
  ram_gb: number;
  os: string;
  arch: string;
  recommended_dit: string;
  recommended_lm: string | null;
  max_batch_size: number;
  max_duration_sec: number;
  models: GenModelInfo[];
  dit_options: GenModelOption[];
  lm_options: GenModelOption[];
  selected_dit: string;
  selected_lm: string;
  loaded_dit: string;
  loaded_lm: string;
  loaded_dit_path: string;
  loaded_lm_path: string;
  ffmpeg_available: boolean;
  performance_mode: "conservative" | "standard" | "quality";
  model_configured: boolean;
}

export interface LoraItem {
  id: string;
  name: string;
  repo: string;
  category: string;
  category_label: string;
  description: string;
  downloaded: boolean;
  compatible: boolean;
  download_status: "idle" | "downloading" | "done" | "failed";
  download_loaded: number;
  download_total: number;
  download_error: string;
}

export interface LoraListResponse {
  selected_dit: string;
  items: LoraItem[];
}

export interface GenerationParams {
  title: string;
  prompt: string;
  lyrics: string;
  instrumental: boolean;
  lora_id: string;
  sample_query: string;
  audio_duration: number | null;
  bpm: number | null;
  key_scale: string;
  time_signature: string;
  vocal_language: string;
  inference_steps: number;
  guidance_scale: number;
  batch_size: number;
  thinking: boolean;
  use_format: boolean;
  audio_format: string;
  model: string | null;
  use_random_seed: boolean;
  seed: number;
  task_type: string;
  // DiT sampling (base-only knobs)
  infer_method: string;
  shift: number;
  use_adg: boolean;
  cfg_interval_start: number;
  cfg_interval_end: number;
  // 5Hz LM sampling (only when thinking)
  lm_temperature: number;
  lm_cfg_scale: number;
  lm_top_p: number;
  lm_top_k: number | null;
  lm_repetition_penalty: number;
  use_cot_caption: boolean;
  use_cot_language: boolean;
  constrained_decoding: boolean;
  // editing / reference-audio modes
  instruction: string;
  repainting_start: number;
  repainting_end: number | null;
  audio_cover_strength: number;
  src_audio_token: string;
  reference_audio_token: string;
  // vocal mode (SVC voice conversion of generated vocals)
  vocal_mode: boolean;
  voice_id: string;
  svc_engine: string;
  svc_transpose: number;
}
