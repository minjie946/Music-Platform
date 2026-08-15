import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchGenerationCapabilities,
  fetchSvcVoices,
  formatInput,
  sendGeneratedToSeparation,
  uploadGenerationAudio,
} from "../api";
import { useGenerationJob } from "../hooks/useGenerationJob";
import { useInitJob } from "../hooks/useInitJob";
import type { GenerationParams, JobStatus } from "../types";
import { GenerateSetup } from "./GenerateSetup";
import { GenHistoryList } from "./GenHistoryList";
import { Hint } from "./Hint";
import { ProgressBar } from "./ProgressBar";
import { Select } from "./Select";
import { LoraSelect } from "./LoraSelect";

interface Props {
  onSeparate: (job: JobStatus) => void;
  onGoToSvc?: () => void;
  onEdit?: (tracks: import("./EditorPanel").EditorTrack[]) => void;
}

const LANGS = [
  { v: "en", l: "英语 English" },
  { v: "zh", l: "中文" },
  { v: "ja", l: "日语 日本語" },
  { v: "ko", l: "韩语 한국어" },
  { v: "es", l: "西班牙语" },
  { v: "fr", l: "法语" },
];

const FORMATS = ["wav", "flac", "mp3", "opus", "aac"];
const FFMPEG_REQUIRED_FORMATS = new Set(["mp3", "opus", "aac"]);

// 时长上限固定 4分30秒（270s），与电脑硬件无关；不指定时由 ACE-Step 随机。
const MAX_DURATION_SEC = 270;
const DURATION_PRESETS = [60, 120, 180, 240];

const MODES = [
  { v: "text2music", l: "文生音乐（默认）" },
  { v: "cover", l: "翻唱 / 风格改写（上传源音频）" },
  { v: "repaint", l: "局部重绘（上传源音频）" },
  { v: "complete", l: "续写（上传源音频）" },
];

interface DetectingGenerationServiceProps {
  isFetching: boolean;
  isError: boolean;
  failureCount: number;
  error: unknown;
}

function errorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "请求生成服务状态失败";
}

function DetectingGenerationService({
  isFetching,
  isError,
  failureCount,
  error,
}: DetectingGenerationServiceProps) {
  const retrying = isFetching && failureCount > 0;
  const stage = isError
    ? {
      title: "生成服务暂未响应",
      detail: errorMessage(error),
      progress: 28,
      tone: "text-red-300",
    }
    : retrying
      ? {
        title: "正在重新连接后端 API",
        detail: `第 ${failureCount + 1} 次检测生成能力，请确认本地后端仍在运行。`,
        progress: 36,
        tone: "text-amber-300",
      }
      : isFetching
        ? {
          title: "正在读取生成服务状态",
          detail: "请求后端 /generation/capabilities，等待返回 ACE-Step、模型与硬件状态。",
          progress: 48,
          tone: "text-brand-300",
        }
        : {
          title: "等待生成服务检测结果",
          detail: "后端正在整理生成能力信息。",
          progress: 62,
          tone: "text-gray-300",
        };

  const checks = [
    { label: "本地后端 API", state: isError ? "异常" : retrying ? "重试中" : "检测中" },
    { label: "ACE-Step 服务状态", state: "等待后端返回" },
    { label: "模型与硬件信息", state: "等待后端返回" },
  ];

  return (
    <main className="flex-1 min-h-0 flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-3xl border border-gray-800 bg-gray-900/70 px-7 py-8 text-center shadow-2xl shadow-black/30">
        <div className="relative mx-auto mb-5 h-16 w-16">
          <div className="absolute inset-0 rounded-full border-4 border-gray-800" />
          <div className="absolute inset-0 rounded-full border-4 border-brand-500 border-r-transparent animate-spin" />
          <div className="absolute inset-3 flex items-center justify-center rounded-full bg-gray-950 text-2xl">
            🎼
          </div>
        </div>
        <h2 className="text-base font-semibold text-gray-100">正在检测生成服务…</h2>
        <p className="mt-2 text-sm text-gray-400">只展示当前检测阶段，不再循环播放虚拟步骤。</p>

        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between text-xs text-gray-400">
            <span className={stage.tone}>{stage.title}</span>
            <span className="font-mono">{stage.progress}%</span>
          </div>
          <ProgressBar value={stage.progress} />
        </div>

        <div className="mt-5 overflow-hidden rounded-xl border border-gray-800 bg-black/25 p-3 text-left text-xs leading-5">
          <div className={`font-medium ${stage.tone}`}>{stage.title}</div>
          <div className="mt-1 text-gray-500">{stage.detail}</div>
          <div className="mt-3 space-y-1 font-mono text-[11px]">
            {checks.map((check, index) => (
              <div key={check.label} className="flex items-center justify-between gap-3">
                <span className={index === 0 ? stage.tone : "text-gray-500"}>{check.label}</span>
                <span className={index === 0 ? stage.tone : "text-gray-600"}>{check.state}</span>
              </div>
            ))}
          </div>
          {isError && (
            <div className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-[11px] text-red-200">
              如果这里持续停留，请先查看日志面板里的 Launcher/API 日志。
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

const DEFAULTS: GenerationParams = {
  title: "",
  prompt: "",
  lyrics: "",
  instrumental: false,
  lora_id: "",
  sample_query: "",
  audio_duration: 240,
  bpm: null,
  key_scale: "",
  time_signature: "",
  vocal_language: "en",
  inference_steps: 8,
  guidance_scale: 7.0,
  batch_size: 1,
  thinking: false,
  use_format: false,
  audio_format: "wav",
  model: null,
  use_random_seed: true,
  seed: -1,
  task_type: "text2music",
  infer_method: "ode",
  shift: 3.0,
  use_adg: false,
  cfg_interval_start: 0.0,
  cfg_interval_end: 1.0,
  lm_temperature: 0.85,
  lm_cfg_scale: 2.5,
  lm_top_p: 0.9,
  lm_top_k: null,
  lm_repetition_penalty: 1.0,
  use_cot_caption: true,
  use_cot_language: true,
  constrained_decoding: true,
  instruction: "",
  repainting_start: 0.0,
  repainting_end: null,
  audio_cover_strength: 1.0,
  src_audio_token: "",
  reference_audio_token: "",
  vocal_mode: false,
  voice_id: "",
  svc_engine: "",
  svc_transpose: 0,
};

const GEN_CONFIG_STORAGE_KEY = "music-gui:generation-config:v1";
const GEN_ADVANCED_STORAGE_KEY = "music-gui:generation-advanced:v1";
const NON_PERSISTED_FIELDS = new Set<keyof GenerationParams>([
  "title",
  "prompt",
  "lyrics",
  "sample_query",
  "src_audio_token",
  "reference_audio_token",
]);

function loadGenerationParams(): GenerationParams {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(GEN_CONFIG_STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<GenerationParams>;
    return {
      ...DEFAULTS,
      ...saved,
      title: "",
      prompt: "",
      lyrics: "",
      sample_query: "",
      src_audio_token: "",
      reference_audio_token: "",
    };
  } catch {
    return DEFAULTS;
  }
}

function persistGenerationParams(params: GenerationParams) {
  if (typeof window === "undefined") return;
  const saved: Record<string, unknown> = {};
  (Object.keys(params) as Array<keyof GenerationParams>).forEach((key) => {
    if (!NON_PERSISTED_FIELDS.has(key)) saved[key] = params[key];
  });
  window.localStorage.setItem(GEN_CONFIG_STORAGE_KEY, JSON.stringify(saved));
}

function loadAdvancedOpen(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(GEN_ADVANCED_STORAGE_KEY) === "1";
}

function compactPath(path: string): string {
  if (!path) return "未设置";
  if (path.length <= 58) return path;
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length >= 3) return `…/${parts.slice(-3).join("/")}`;
  return `…${path.slice(-55)}`;
}

export function GeneratePanel({ onSeparate, onGoToSvc, onEdit }: Props) {
  const [p, setP] = useState<GenerationParams>(() => loadGenerationParams());
  const [advanced, setAdvanced] = useState(() => loadAdvancedOpen());
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [separatingTrack, setSeparatingTrack] = useState<string | null>(null);
  const { job, starting, error, start } = useGenerationJob();

  // SVC voices for the vocal-mode picker (only fetched lazily; cheap).
  const { data: voices } = useQuery({
    queryKey: ["svc-voices"],
    queryFn: fetchSvcVoices,
    refetchInterval: 20000,
  });
  const readyVoices = (voices ?? []).filter((v) => v.ready);

  const {
    data: caps,
    refetch: refetchCaps,
    isFetching: capsFetching,
    isError: capsIsError,
    failureCount: capsFailureCount,
    error: capsError,
  } = useQuery({
    queryKey: ["gen-capabilities"],
    queryFn: fetchGenerationCapabilities,
    refetchInterval: 15000,
  });

  // Soft reload: re-run /v1/init with the saved model selection so model/config
  // changes take effect without restarting the ACE-Step process.
  const reload = useInitJob(() => refetchCaps());
  const reloading =
    reload.starting ||
    reload.job?.state === "queued" ||
    reload.job?.state === "running";

  useEffect(() => {
    persistGenerationParams(p);
  }, [p]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(GEN_ADVANCED_STORAGE_KEY, advanced ? "1" : "0");
  }, [advanced]);

  // Clamp batch to machine ceiling; duration is independent of hardware and
  // only bounded by the fixed 270s cap.
  useEffect(() => {
    if (!caps) return;
    setP((prev) => ({
      ...prev,
      batch_size: Math.min(prev.batch_size, caps.max_batch_size || 1),
      audio_duration:
        prev.audio_duration == null
          ? prev.audio_duration
          : Math.min(prev.audio_duration, MAX_DURATION_SEC),
      model: prev.model ?? caps.recommended_dit ?? null,
      audio_format:
        !caps.ffmpeg_available && FFMPEG_REQUIRED_FORMATS.has(prev.audio_format)
          ? "wav"
          : prev.audio_format,
      thinking: caps.recommended_lm ? prev.thinking : false,
      use_format: caps.recommended_lm ? prev.use_format : false,
    }));
  }, [caps]);

  const set = <K extends keyof GenerationParams>(k: K, v: GenerationParams[K]) =>
    setP((prev) => ({ ...prev, [k]: v }));

  const [srcName, setSrcName] = useState("");
  const [refName, setRefName] = useState("");
  const [uploadingSrc, setUploadingSrc] = useState(false);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [helperBusy, setHelperBusy] = useState<"format" | "sample" | null>(null);
  const [helperMsg, setHelperMsg] = useState<string | null>(null);

  // Selected DiT model determines which knobs apply (base vs turbo).
  const selectedModel = (p.model ?? caps?.recommended_dit ?? "").toLowerCase();
  const isBase = !!selectedModel && !selectedModel.includes("turbo");
  const stepsMax = isBase ? 200 : 20;
  const defaultCustomDuration = Math.min(240, MAX_DURATION_SEC);
  const durationEnabled = p.audio_duration != null;

  const applySample = (r: {
    caption?: string;
    lyrics?: string;
    bpm?: number;
    key_scale?: string;
    time_signature?: string;
    duration?: number;
    vocal_language?: string;
  }) =>
    setP((prev) => ({
      ...prev,
      prompt: r.caption ?? prev.prompt,
      lyrics: r.lyrics ?? prev.lyrics,
      bpm: r.bpm ?? prev.bpm,
      key_scale: r.key_scale ?? prev.key_scale,
      time_signature: r.time_signature ?? prev.time_signature,
      audio_duration:
        prev.audio_duration == null ? prev.audio_duration : r.duration ?? prev.audio_duration,
      vocal_language: r.vocal_language ?? prev.vocal_language,
    }));

  const handleFormat = async () => {
    setHelperBusy("format");
    setHelperMsg(null);
    try {
      const paramObj: Record<string, unknown> = {
        bpm: p.bpm,
        language: p.vocal_language,
      };
      if (p.audio_duration != null) paramObj.duration = p.audio_duration;
      const r = await formatInput({
        prompt: p.prompt,
        lyrics: p.lyrics,
        param_obj: paramObj,
      });
      applySample(r);
    } catch (e: any) {
      setHelperMsg(e?.response?.data?.detail ?? "润色失败，请稍后再试");
    } finally {
      setHelperBusy(null);
    }
  };

  const handleAudio = async (file: File | undefined, kind: "src" | "ref") => {
    if (!file) return;
    const setUploading = kind === "src" ? setUploadingSrc : setUploadingRef;
    const setName = kind === "src" ? setSrcName : setRefName;
    const field = kind === "src" ? "src_audio_token" : "reference_audio_token";
    setUploading(true);
    setHelperMsg(null);
    try {
      const { token, filename } = await uploadGenerationAudio(file);
      set(field, token);
      setName(filename);
    } catch (e: any) {
      setHelperMsg(e?.response?.data?.detail ?? "音频上传失败");
    } finally {
      setUploading(false);
    }
  };

  const isEditing = p.task_type !== "text2music";

  // LM availability + a single derived "LM 增强" on/off the consolidated group uses.
  const lmAvailable = !!(caps?.recommended_lm || caps?.loaded_lm);
  const lmEnabled = lmAvailable && (p.thinking || p.use_format);
  // Example for the one-liner box, kept consistent with the chosen vocal language.
  const sampleExample =
    p.vocal_language === "zh"
      ? "例如：一首适合安静夜晚的温柔民谣"
      : p.vocal_language === "ja"
        ? "例：静かな夜に合う優しいバラード"
        : p.vocal_language === "ko"
          ? "예: 조용한 밤에 어울리는 부드러운 발라드"
          : "e.g. a soft acoustic ballad for a quiet evening";

  const available = !!caps?.available;
  const canSubmit = useMemo(
    () =>
      available &&
      !starting &&
      !reloading &&
      !uploadingSrc &&
      !uploadingRef &&
      (isEditing ? !!p.src_audio_token : true) &&
      (p.vocal_mode ? !!p.voice_id : true) &&
      !!(p.prompt || p.lyrics || p.sample_query || (isEditing && p.src_audio_token)),
    [
      available,
      starting,
      reloading,
      uploadingSrc,
      uploadingRef,
      isEditing,
      p.src_audio_token,
      p.prompt,
      p.lyrics,
      p.sample_query,
      p.vocal_mode,
      p.voice_id,
    ],
  );

  const running = job?.state === "queued" || job?.state === "running";

  // Reason shown under the (disabled) primary CTA so users know what's missing.
  const submitHint = useMemo(() => {
    if (!available) return reload.job?.stage ? `模型加载中 ${reload.job.progress ?? 0}%` : "生成服务尚未就绪";
    if (reloading) return `模型重新加载中 ${reload.job?.progress ?? 0}%`;
    if (uploadingSrc || uploadingRef) return "音频上传中…";
    if (isEditing && !p.src_audio_token) return "请先上传源音频";
    if (p.vocal_mode && !p.voice_id) return "请选择一个 SVC 音源";
    if (!(p.prompt || p.lyrics || p.sample_query)) return "请至少填写描述、歌词或一句话简述";
    return "";
  }, [available, reloading, reload.job?.progress, reload.job?.stage, uploadingSrc, uploadingRef, isEditing, p.src_audio_token, p.vocal_mode, p.voice_id, p.prompt, p.lyrics, p.sample_query]);

  // Short cost preview ("约 N 首 · 时长") next to the CTA.
  const submitPreview = useMemo(() => {
    const count = `${p.batch_size} 首`;
    const dur = durationEnabled ? `${p.audio_duration}s` : "默认时长";
    return `${count} · ${dur}`;
  }, [p.batch_size, p.audio_duration, durationEnabled]);

  const handleSeparate = async (jobId: string, index: number) => {
    setSeparatingTrack(`${jobId}:${index}`);
    try {
      const sepJob = await sendGeneratedToSeparation(jobId, index);
      onSeparate(sepJob);
    } catch {
      /* surfaced via separation panel */
    } finally {
      setSeparatingTrack(null);
    }
  };

  // Still detecting the generation service: full-screen loading on tab switch.
  if (!caps) {
    return (
      <DetectingGenerationService
        isFetching={capsFetching}
        isError={capsIsError}
        failureCount={capsFailureCount}
        error={capsError}
      />
    );
  }

  // First-time setup (pick models/workspace) and unsupported hardware still need
  // the dedicated full setup screen. A returning user who is merely loading the
  // cached model gets the form below with a compact loader banner (L4) so they
  // can prepare inputs while the model loads.
  const hwUnsupported =
    !caps.service_up && caps.device === "cpu" && caps.reason.includes("CPU");
  const firstTime = !caps.model_configured;
  const needsFullSetup = !caps.available && (firstTime || hwUnsupported);

  if (needsFullSetup) {
    return (
      <main className="relative flex-1 min-h-0 overflow-hidden border-t border-gray-800 lg:flex">
        <div
          className={[
            "min-h-0 shrink-0 overflow-hidden border-r border-gray-800 bg-gray-950/30 transition-[width] duration-300",
            leftCollapsed ? "w-0 border-r-0" : "w-full lg:w-[560px]",
          ].join(" ")}
        >
          <div className="h-full overflow-y-auto">
            <GenerateSetup caps={caps} onReady={() => refetchCaps()} />
          </div>
        </div>
        <button
          type="button"
          onClick={() => setLeftCollapsed((v) => !v)}
          className={[
            "absolute top-1/2 z-20 hidden h-12 w-7 -translate-y-1/2 items-center justify-center border border-gray-700 bg-gray-900 text-gray-400 shadow-lg shadow-black/40 transition hover:border-brand-500 hover:text-white lg:flex",
            leftCollapsed ? "left-0 rounded-r-lg border-l-0" : "left-[560px] -translate-x-full rounded-l-lg border-r-0",
          ].join(" ")}
          title={leftCollapsed ? "展开生成参数" : "收起生成参数"}
        >
          {leftCollapsed ? "›" : "‹"}
        </button>
        <div className="min-w-0 flex-1 px-5 pb-5 pt-3">
          <div className="h-full overflow-hidden flex flex-col">
            <GenHistoryList
              onSeparate={handleSeparate}
              separatingTrack={separatingTrack}
            />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex-1 min-h-0 overflow-hidden border-t border-gray-800 lg:flex">
      {/* ---------- left: form ---------- */}
      <div
        className={[
          "min-h-0 shrink-0 overflow-hidden border-r border-gray-800 bg-gray-950/30 transition-[width] duration-300",
          leftCollapsed ? "w-0 border-r-0" : "w-full lg:w-[560px]",
        ].join(" ")}
      >
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {/* L4: model still loading — show a compact loader banner above the
                form so users can prepare prompt/lyrics while waiting. */}
            {!available && (
              <div className="mb-4">
                <GenerateSetup caps={caps} onReady={() => refetchCaps()} compact />
              </div>
            )}
            {/* capability banner (only once ready) */}
            {available && (
              <div
                className={[
                  "mb-4 rounded-lg border px-3 py-2 text-xs",
                  available
                    ? "border-emerald-700 bg-emerald-900/20 text-emerald-300"
                    : "border-amber-700 bg-amber-900/20 text-amber-300",
                ].join(" ")}
              >
                {caps ? (
                  <>
                    <div className="font-medium">
                      {available ? "✓ 音乐生成可用" : "音乐生成当前不可用"}
                    </div>
                    <div className="mt-1 text-gray-400">
                      设备 {caps.device.toUpperCase()}
                      {caps.gpu_name && ` · ${caps.gpu_name}`}
                      {caps.vram_gb > 0 && ` · 显存 ${caps.vram_gb}GB`}
                      {caps.ram_gb > 0 && ` · 内存 ${caps.ram_gb}GB`}
                    </div>
                    <div className="text-gray-500">
                      推荐模型 {caps.recommended_dit}
                      {caps.recommended_lm ? ` + ${caps.recommended_lm}` : "（仅 DiT）"}
                    </div>
                    <div className="mt-1 text-[11px] text-gray-500">
                      性能模式：
                      {caps.performance_mode === "conservative"
                        ? "保守模式（稳定优先）"
                        : caps.performance_mode === "standard"
                          ? "标准模式（LM 0.6B）"
                          : "高质量模式（可能触发 macOS 内存压力）"}
                    </div>
                    {!available && caps.reason && (
                      <div className="mt-1 text-amber-200/90">{caps.reason}</div>
                    )}
                    {available && (
                      <div className="mt-2 border-t border-emerald-800/50 pt-2">
                        <div className="text-gray-400">
                          已加载 {caps.loaded_dit || caps.selected_dit || "—"}
                          {caps.loaded_lm ? ` + ${caps.loaded_lm}` : ""}
                        </div>
                        <div className="mt-1 space-y-0.5 text-[11px] text-gray-500">
                          <div
                            className="flex items-center gap-1 break-all"
                            title={`模型根目录：${caps.checkpoints_dir || "未设置"}`}
                          >
                            <span aria-hidden="true">📁</span>
                            <span>模型根目录：{compactPath(caps.checkpoints_dir)}</span>
                          </div>
                          <div
                            className="flex items-center gap-1 break-all"
                            title={`DiT 模型地址：${caps.loaded_dit_path || "未加载"}`}
                          >
                            <span aria-hidden="true">🧠</span>
                            <span>DiT：{compactPath(caps.loaded_dit_path)}</span>
                          </div>
                          {(caps.loaded_lm || caps.loaded_lm_path) && (
                            <div
                              className="flex items-center gap-1 break-all"
                              title={`LM 模型地址：${caps.loaded_lm_path || "未加载"}`}
                            >
                              <span aria-hidden="true">💬</span>
                              <span>LM：{compactPath(caps.loaded_lm_path)}</span>
                            </div>
                          )}
                        </div>
                        {reloading ? (
                          <div className="mt-1">
                            <div className="flex justify-between text-[11px] text-gray-400 mb-1">
                              <span>{reload.job?.stage || "重新加载模型…"}</span>
                              <span>{reload.job?.progress ?? 0}%</span>
                            </div>
                            <ProgressBar value={reload.job?.progress ?? 0} />
                          </div>
                        ) : (
                          <button
                            onClick={() => reload.start()}
                            className="mt-1 text-[11px] text-brand-300 hover:text-brand-200 underline underline-offset-2"
                          >
                            ⟳ 重新加载模型（应用设置里的模型/配置，无需重启进程）
                          </button>
                        )}
                        {reload.error && (
                          <div className="mt-1 text-[11px] text-red-400">{reload.error}</div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  "正在检测硬件与生成服务…"
                )}
              </div>
            )}

            <div className="mb-3">
              <label className="block text-sm text-gray-300 mb-1">生成模式</label>
              <Select
                value={p.instrumental ? "instrumental" : p.task_type}
                onChange={(v) =>
                  v === "instrumental"
                    ? setP((prev) => ({ ...prev, task_type: "text2music", instrumental: true }))
                    : setP((prev) => ({ ...prev, task_type: v, instrumental: false }))
                }
                ariaLabel="生成模式"
                options={[
                  ...MODES.map((m) => ({ value: m.v, label: m.l })),
                  { value: "instrumental", label: "纯音乐（无人声 · 器乐）" },
                ]}
              />
            </div>

            <div className="mb-3">
              <label className="block text-sm text-gray-300 mb-1">
                音乐风格 LoRA
                <Hint text="可选的风格适配器。未下载的可在下拉里点「下载」，下载后即可选用；与当前 DiT 基座不匹配的会标注并禁用。切换 LoRA 会在下次生成时自动加载。" />
              </label>
              <LoraSelect
                value={p.lora_id}
                onChange={(id) => set("lora_id", id)}
              />
            </div>

            <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3">
              <label className={["flex items-center justify-between text-sm text-gray-200", p.instrumental ? "opacity-50" : ""].join(" ")}>
                <span className="flex items-center">
                  人声模式（用你的音色演唱）
                  <Hint text="开启后：生成完成会自动分离出人声与伴奏，把人声转换成所选 SVC 音色，再与伴奏混音输出。" />
                  {p.instrumental && <span className="ml-1 text-[11px] text-brand-300">· 纯音乐不可用</span>}
                </span>
                <input
                  type="checkbox"
                  checked={p.vocal_mode && !p.instrumental}
                  disabled={p.instrumental}
                  onChange={(e) => set("vocal_mode", e.target.checked)}
                  className="h-4 w-4 accent-brand-500"
                />
              </label>

              {p.vocal_mode && !p.instrumental && (
                <div className="mt-3 space-y-3">
                  {readyVoices.length === 0 ? (
                    <div className="rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-2 text-xs text-amber-300">
                      暂无可用的 SVC 音源。
                      <button
                        type="button"
                        onClick={() => onGoToSvc?.()}
                        className="ml-1 underline hover:text-amber-100"
                      >
                        去训练音源
                      </button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">选择音源</label>
                        <Select
                          value={p.voice_id}
                          ariaLabel="选择音源"
                          placeholder="— 请选择 —"
                          onChange={(v) => {
                            const found = readyVoices.find((x) => x.id === v);
                            set("voice_id", v);
                            set("svc_engine", found?.engine ?? "");
                          }}
                          options={readyVoices.map((v) => ({
                            value: v.id,
                            label: `${v.name}（${v.engine}）`,
                          }))}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          升降调（半音）{p.svc_transpose > 0 ? `+${p.svc_transpose}` : p.svc_transpose}
                          <Hint text="对转换后的人声整体移调；男声→女声常用 +12，反之 -12。0 = 不变。" />
                        </label>
                        <input
                          type="range"
                          min={-12}
                          max={12}
                          step={1}
                          value={p.svc_transpose}
                          onChange={(e) => set("svc_transpose", Number(e.target.value))}
                          className="w-full"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {isEditing && (
              <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3">
                <label className="block text-sm text-gray-300 mb-1">
                  源音频（必填）{srcName && <span className="text-emerald-400"> · {srcName}</span>}
                </label>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(e) => handleAudio(e.target.files?.[0], "src")}
                  className="w-full text-xs text-gray-400 file:mr-3 file:rounded-md file:border-0 file:bg-gray-800 file:px-3 file:py-1.5 file:text-gray-200"
                />
                {uploadingSrc && <p className="mt-1 text-[11px] text-gray-500">上传中…</p>}
                {p.task_type === "repaint" && (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">重绘起点（秒）</label>
                      <input
                        type="number"
                        min={0}
                        value={p.repainting_start}
                        onChange={(e) => set("repainting_start", Number(e.target.value))}
                        className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">重绘终点（秒，-1=末尾）</label>
                      <input
                        type="number"
                        value={p.repainting_end ?? ""}
                        placeholder="留空 = 默认"
                        onChange={(e) =>
                          set("repainting_end", e.target.value === "" ? null : Number(e.target.value))
                        }
                        className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                      />
                    </div>
                  </div>
                )}
                <div className="mt-3">
                  <label className="block text-xs text-gray-400 mb-1">
                    改写强度 {p.audio_cover_strength.toFixed(2)}（越小越接近原曲）
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={p.audio_cover_strength}
                    onChange={(e) => set("audio_cover_strength", Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>
            )}

            <div className="mb-2 mt-1 text-[11px] font-medium uppercase tracking-wider text-gray-500">内容</div>
            <label className="block text-sm text-gray-300 mb-1">歌名（可选，作为下载文件名）</label>
            <input
              value={p.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="例如：晚风（留空则用 track_1）"
              className="w-full mb-3 rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100 focus:border-brand-500 outline-none"
            />

            <label className="block text-sm text-gray-300 mb-1">风格 / 描述（Prompt，建议用风格标签/技术词）</label>
            <textarea
              value={p.prompt}
              onChange={(e) => set("prompt", e.target.value)}
              rows={4}
              placeholder="例如：upbeat pop, female vocal, guitar, 120bpm"
              className="w-full mb-3 rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100 focus:border-brand-500 outline-none resize-y min-h-[96px]"
            />

            <label className="block text-sm text-gray-300 mb-1">
              歌词（Lyrics，可选）
              {p.instrumental && <span className="ml-1 text-brand-300">· 纯音乐模式已禁用</span>}
            </label>
            <textarea
              value={p.lyrics}
              onChange={(e) => set("lyrics", e.target.value)}
              disabled={p.instrumental}
              rows={10}
              placeholder={p.instrumental ? "纯音乐模式：不使用歌词" : "[Verse]\n...\n[Chorus]\n..."}
              className="w-full mb-2 rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100 focus:border-brand-500 outline-none font-mono resize-y min-h-[200px] disabled:opacity-50"
            />

            <div className="mb-4 flex items-center gap-2">
              <button
                onClick={handleFormat}
                disabled={!available || helperBusy !== null || (!p.prompt && !p.lyrics)}
                className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-50"
                title="立即用 LM 润色（format）当前描述与歌词，结果会直接写回上面的输入框"
              >
                {helperBusy === "format" ? "润色中…" : "✨ 一键润色（LM format）"}
              </button>
              {helperMsg && <span className="text-xs text-red-400">{helperMsg}</span>}
            </div>

            <div className="mb-2 mt-1 text-[11px] font-medium uppercase tracking-wider text-gray-500">输出</div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="flex items-center justify-between text-sm text-gray-300 mb-1">
                  <span>时长 {durationEnabled ? `${p.audio_duration}s` : "默认（不指定）"}</span>
                  <span className="flex items-center gap-1 text-xs text-gray-400">
                    自定义
                    <input
                      type="checkbox"
                      checked={durationEnabled}
                      onChange={(e) =>
                        set("audio_duration", e.target.checked ? defaultCustomDuration : null)
                      }
                      className="accent-brand-500"
                    />
                  </span>
                </label>
                {durationEnabled ? (
                  <>
                    <input
                      type="range"
                      min={10}
                      max={MAX_DURATION_SEC}
                      step={5}
                      value={p.audio_duration ?? defaultCustomDuration}
                      onChange={(e) => set("audio_duration", Number(e.target.value))}
                      className="w-full"
                    />
                    <p className="mt-1 text-[11px] text-gray-500">最长 4分30秒（270s）</p>
                  </>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {DURATION_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => set("audio_duration", preset)}
                        className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 transition hover:border-brand-500 hover:text-white"
                      >
                        {preset}s
                      </button>
                    ))}
                    <span className="self-center text-[11px] text-gray-500">不指定则由 ACE-Step 随机决定，或勾选「自定义」</span>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">语言</label>
                <Select
                  value={p.vocal_language}
                  ariaLabel="语言"
                  disabled={p.instrumental}
                  onChange={(v) => set("vocal_language", v)}
                  options={LANGS.map((l) => ({ value: l.v, label: l.l }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-sm text-gray-300 mb-1">
                  生成数量
                </label>
                {(caps?.max_batch_size ?? 1) <= 1 ? (
                  <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 text-sm text-gray-400">
                    1 首
                    <span className="ml-1 text-[11px] text-gray-500">· 受当前内存/性能模式限制</span>
                  </div>
                ) : (
                  <input
                    type="number"
                    min={1}
                    max={caps?.max_batch_size ?? 1}
                    value={p.batch_size}
                    onChange={(e) => set("batch_size", Number(e.target.value))}
                    className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                  />
                )}
              </div>
              <div>
                <label className="block text-sm text-gray-300 mb-1">输出格式</label>
                <Select
                  value={p.audio_format}
                  ariaLabel="输出格式"
                  onChange={(v) => set("audio_format", v)}
                  options={FORMATS.map((f) => {
                    const disabled = !caps.ffmpeg_available && FFMPEG_REQUIRED_FORMATS.has(f);
                    return {
                      value: f,
                      disabled,
                      label: `${f.toUpperCase()}${disabled ? "（需要 FFmpeg）" : ""}`,
                    };
                  })}
                />
                {!caps.ffmpeg_available && (
                  <p className="mt-1 text-[11px] text-amber-300">
                    未检测到 FFmpeg，已禁用 MP3/OPUS/AAC，请使用 WAV 或 FLAC。
                  </p>
                )}
              </div>
            </div>

            {/* Consolidated LM group (F2): one master switch + two sub-options. */}
            <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3">
              <label className="flex items-center justify-between text-sm text-gray-200">
                <span className="flex items-center">
                  使用 LM 增强
                  <Hint text="开启后由 5Hz LM 参与生成：可润色文案、或进行深度思考以提升质量。关闭则仅用 DiT 直接生成，更快。" />
                </span>
                <input
                  type="checkbox"
                  checked={lmEnabled}
                  disabled={!lmAvailable}
                  onChange={(e) => {
                    if (e.target.checked) {
                      set("use_format", true);
                    } else {
                      set("use_format", false);
                      set("thinking", false);
                    }
                  }}
                  className="h-4 w-4 accent-brand-500"
                />
              </label>
              {!lmAvailable ? (
                <p className="mt-2 text-[11px] text-gray-500">
                  当前为 macOS 保守模式，默认不加载 LM；如需更高质量，可在设置里选择 LM 后重新初始化。
                </p>
              ) : (
                lmEnabled && (
                  <div className="mt-3 space-y-2">
                    <label className="flex items-center gap-2 text-xs text-gray-300">
                      <input
                        type="checkbox"
                        checked={p.use_format}
                        onChange={(e) => set("use_format", e.target.checked)}
                        className="accent-brand-500"
                      />
                      仅润色文案（format，自动优化描述/歌词）
                    </label>
                    <label className="flex items-center gap-2 text-xs text-gray-300">
                      <input
                        type="checkbox"
                        checked={p.thinking}
                        onChange={(e) => set("thinking", e.target.checked)}
                        className="accent-brand-500"
                      />
                      深度思考（thinking，质量更好、稍慢）
                    </label>
                    <div className="pt-1">
                      <label className="block text-xs text-gray-400 mb-1">
                        一句话简述（可选，给 LM 的自然语言意图；留空则用上面的描述）
                      </label>
                      <input
                        value={p.sample_query}
                        onChange={(e) => set("sample_query", e.target.value)}
                        placeholder={sampleExample}
                        className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100 focus:border-brand-500 outline-none"
                      />
                    </div>
                  </div>
                )
              )}
            </div>

            <button
              onClick={() => setAdvanced((v) => !v)}
              className="text-xs text-gray-400 hover:text-gray-200 mb-2"
            >
              {advanced ? "▾ 收起高级参数" : "▸ 展开高级参数"}
            </button>

            {advanced && (
              <div className="space-y-3 mb-3 rounded-lg border border-gray-800 p-3">
                {caps && caps.models.length > 0 && (
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">
                      DiT 模型
                      <Hint text="负责把文本/语义生成音频的主扩散模型。turbo 速度快、质量稳；base/SFT/XL 质量更高但更慢、更吃显存。本次生成临时使用，不改变已加载模型。" />
                    </label>
                    <Select
                      value={p.model ?? caps.recommended_dit}
                      ariaLabel="DiT 模型"
                      onChange={(v) => set("model", v)}
                      options={caps.models.map((m) => ({
                        value: m.name,
                        label: `${m.name}${m.is_default ? "（默认）" : ""}`,
                      }))}
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">
                      推理步数（≤{stepsMax}）
                      <Hint text="扩散去噪迭代次数。步数越多通常越精细但越慢。Turbo 模型推荐约 8 步，Base 模型推荐 32-64 步。" />
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={stepsMax}
                      value={p.inference_steps}
                      onChange={(e) => set("inference_steps", Number(e.target.value))}
                      className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">
                      BPM
                      <Hint text="每分钟拍数，控制歌曲速度（30-300）。留空则由模型/LM 自动决定。" />
                    </label>
                    <input
                      type="number"
                      min={30}
                      max={300}
                      value={p.bpm ?? ""}
                      onChange={(e) =>
                        set("bpm", e.target.value === "" ? null : Number(e.target.value))
                      }
                      className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">
                      调式（Key）
                      <Hint text="歌曲的调性与音阶，例如 C Major、Am。留空则自动决定。" />
                    </label>
                    <input
                      value={p.key_scale}
                      onChange={(e) => set("key_scale", e.target.value)}
                      placeholder="C Major / Am"
                      className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">
                      拍号
                      <Hint text="节拍单位，填 2/3/4/6 分别对应 2/4、3/4、4/4、6/8 拍。留空则自动决定。" />
                    </label>
                    <input
                      value={p.time_signature}
                      onChange={(e) => set("time_signature", e.target.value)}
                      placeholder="4"
                      className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="checkbox"
                    checked={p.use_random_seed}
                    onChange={(e) => set("use_random_seed", e.target.checked)}
                  />
                  随机种子
                  <Hint text="开启则每次用随机种子，结果各不相同；关闭后可手动指定种子，固定种子+相同参数可复现同一首作品。" />
                </label>
                {!p.use_random_seed && (
                  <input
                    type="number"
                    value={p.seed}
                    onChange={(e) => set("seed", Number(e.target.value))}
                    className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                  />
                )}

                <div>
                  <label className="block text-sm text-gray-300 mb-1">
                    扩散推理方法
                    <Hint text="采样器类型：ODE（Euler，确定性、更快）；SDE（带随机性，变化更多但略慢）。" />
                  </label>
                  <Select
                    value={p.infer_method}
                    ariaLabel="扩散推理方法"
                    onChange={(v) => set("infer_method", v)}
                    options={[
                      { value: "ode", label: "ODE（Euler，更快）" },
                      { value: "sde", label: "SDE（随机，更有变化）" },
                    ]}
                  />
                </div>

                {/* base-only DiT knobs */}
                {isBase && (
                  <div className="space-y-3 rounded-lg border border-gray-800/80 p-3">
                    <div className="text-xs font-medium text-gray-400">Base 模型参数</div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          引导强度 {p.guidance_scale.toFixed(1)}
                          <Hint text="CFG guidance scale：越大越严格贴合描述，但过高可能失真；越小越自由。仅对 Base 模型有效。" />
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={15}
                          step={0.5}
                          value={p.guidance_scale}
                          onChange={(e) => set("guidance_scale", Number(e.target.value))}
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          时间步偏移 shift {p.shift.toFixed(1)}
                          <Hint text="时间步偏移因子（1.0-5.0），调节去噪进度分布，影响细节与风格强度。仅对 Base 模型有效。" />
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={5}
                          step={0.1}
                          value={p.shift}
                          onChange={(e) => set("shift", Number(e.target.value))}
                          className="w-full"
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-gray-300">
                      <input
                        type="checkbox"
                        checked={p.use_adg}
                        onChange={(e) => set("use_adg", e.target.checked)}
                      />
                      自适应双引导（ADG）
                      <Hint text="Adaptive Dual Guidance：自适应调节引导强度，有助于平衡贴合度与自然度。仅对 Base 模型有效。" />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          CFG 起点
                          <Hint text="在去噪过程的哪个比例开始施加 CFG 引导（0-1）。" />
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={p.cfg_interval_start}
                          onChange={(e) => set("cfg_interval_start", Number(e.target.value))}
                          className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          CFG 终点
                          <Hint text="在去噪过程的哪个比例停止施加 CFG 引导（0-1）。" />
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={p.cfg_interval_end}
                          onChange={(e) => set("cfg_interval_end", Number(e.target.value))}
                          className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* LM sampling knobs (only meaningful when thinking) */}
                {p.thinking && (
                  <div className="space-y-3 rounded-lg border border-gray-800/80 p-3">
                    <div className="text-xs font-medium text-gray-400">LM 采样参数（thinking）</div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          温度 {p.lm_temperature.toFixed(2)}
                          <Hint text="LM 采样温度：越高越有创意/随机，越低越稳定保守。默认 0.85。" />
                        </label>
                        <input
                          type="range"
                          min={0.1}
                          max={1.5}
                          step={0.05}
                          value={p.lm_temperature}
                          onChange={(e) => set("lm_temperature", Number(e.target.value))}
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          CFG {p.lm_cfg_scale.toFixed(1)}
                          <Hint text="LM 的 CFG 比例（>1 启用）。越大越贴合提示词，越小越发散。默认 2.5。" />
                        </label>
                        <input
                          type="range"
                          min={1}
                          max={5}
                          step={0.1}
                          value={p.lm_cfg_scale}
                          onChange={(e) => set("lm_cfg_scale", Number(e.target.value))}
                          className="w-full"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          top_p
                          <Hint text="核采样阈值：只在累计概率前 p 的候选中采样。越小越保守。默认 0.9。" />
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={p.lm_top_p}
                          onChange={(e) => set("lm_top_p", Number(e.target.value))}
                          className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-2 py-2 text-sm text-gray-100"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          top_k
                          <Hint text="只在概率最高的前 k 个候选中采样。留空/0 表示禁用。" />
                        </label>
                        <input
                          type="number"
                          min={0}
                          value={p.lm_top_k ?? ""}
                          placeholder="禁用"
                          onChange={(e) =>
                            set("lm_top_k", e.target.value === "" ? null : Number(e.target.value))
                          }
                          className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-2 py-2 text-sm text-gray-100"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-400 mb-1">
                          重复惩罚
                          <Hint text="抑制 LM 重复输出的强度。1.0 为不惩罚，略大于 1 可减少重复。" />
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={2}
                          step={0.05}
                          value={p.lm_repetition_penalty}
                          onChange={(e) => set("lm_repetition_penalty", Number(e.target.value))}
                          className="w-full rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-2 py-2 text-sm text-gray-100"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-gray-300">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={p.use_cot_caption}
                          onChange={(e) => set("use_cot_caption", e.target.checked)}
                        />
                        CoT 增强描述
                        <Hint text="让 LM 通过思维链推理重写/增强你的描述（caption），通常能提升音乐质量。" />
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={p.use_cot_language}
                          onChange={(e) => set("use_cot_language", e.target.checked)}
                        />
                        CoT 检测语言
                        <Hint text="让 LM 通过思维链自动检测歌词的人声语言，避免发音/语言不匹配。" />
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={p.constrained_decoding}
                          onChange={(e) => set("constrained_decoding", e.target.checked)}
                        />
                        约束解码
                        <Hint text="启用基于 FSM 的约束解码，让 LM 输出更结构化、稳定，减少格式错误。" />
                      </label>
                    </div>
                  </div>
                )}

                {/* optional style-transfer reference audio (any mode) */}
                <div>
                  <label className="block text-sm text-gray-300 mb-1">
                    风格参考音频（可选）
                    <Hint text="上传一段音频作为风格参考，模型会迁移其风格/音色到生成结果。可与任意生成模式叠加使用。" />
                    {refName && <span className="text-emerald-400"> · {refName}</span>}
                  </label>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(e) => handleAudio(e.target.files?.[0], "ref")}
                    className="w-full text-xs text-gray-400 file:mr-3 file:rounded-md file:border-0 file:bg-gray-800 file:px-3 file:py-1.5 file:text-gray-200"
                  />
                  {uploadingRef && <p className="mt-1 text-[11px] text-gray-500">上传中…</p>}
                </div>
              </div>
            )}
          </div>

          {/* sticky footer: always-visible primary generate CTA (F1) */}
          <div className="shrink-0 border-t border-gray-800 bg-gray-950/85 px-5 py-3 backdrop-blur">
            {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
            <div className="mb-2 flex items-center justify-between text-[11px] text-gray-500">
              <span className={submitHint ? "text-amber-300/90" : "text-emerald-300/80"}>
                {submitHint || "已就绪，可开始生成"}
              </span>
              <span className="tabular-nums text-gray-400">{submitPreview}</span>
            </div>
            <button
              onClick={() => start(p)}
              disabled={!canSubmit}
              title={submitHint || undefined}
              className={[
                "w-full rounded-xl px-4 py-3 text-sm font-medium transition",
                canSubmit
                  ? "bg-brand-600 hover:bg-brand-500 text-white"
                  : "bg-gray-800 text-gray-500 cursor-not-allowed",
              ].join(" ")}
            >
              {reloading ? "正在重新加载模型…" : starting || running ? "生成中…" : "🎵 生成音乐"}
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setLeftCollapsed((v) => !v)}
        className={[
          "absolute top-1/2 z-20 hidden h-12 w-7 -translate-y-1/2 items-center justify-center border border-gray-700 bg-gray-900 text-gray-400 shadow-lg shadow-black/40 transition hover:border-brand-500 hover:text-white lg:flex",
          leftCollapsed ? "left-0 rounded-r-lg border-l-0" : "left-[560px] -translate-x-full rounded-l-lg border-r-0",
        ].join(" ")}
        title={leftCollapsed ? "展开生成参数" : "收起生成参数"}
      >
        {leftCollapsed ? "›" : "‹"}
      </button>

      {/* ---------- right: current result + history ---------- */}
      <div className="min-w-0 flex-1 px-5 pb-5 pt-3">
        <div className="h-full overflow-hidden flex flex-col">
          <GenHistoryList
            currentJob={job}
            currentBatchSize={p.batch_size}
            currentParams={p as unknown as Record<string, unknown>}
            onSeparate={handleSeparate}
            onSendToEditor={onEdit ? (track) => onEdit([track]) : undefined}
            separatingTrack={separatingTrack}
          />
        </div>
      </div>
    </main>
  );
}
