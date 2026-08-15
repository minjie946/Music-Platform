import axios from "axios";
import type {
  EditRequest,
  EditTrackSpec,
  EngineCapabilities,
  GenerationCapabilities,
  GenerationParams,
  GenHistoryItem,
  JobStatus,
  LoraItem,
  LoraListResponse,
  MidiNote,
  RuntimeSettingsOut,
  RuntimeLog,
  SvcCapabilities,
  SvcTrainStatus,
  SvcVoice,
} from "./types";

const http = axios.create({ baseURL: "/api" });
let apiPrefix = "/api";

export function isDesktopRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function apiUrl(path: string): string {
  return `${apiPrefix}${path}`;
}

export function filenameFromDisposition(header: string | null): string {
  if (!header) return "";
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
    } catch {
      return encoded;
    }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1] ?? "";
}

export async function downloadFile(url: string, fallbackFilename = "download"): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `下载失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("content-disposition")) || fallbackFilename;
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
    link.remove();
  }, 0);
}

export async function initializeApiBaseUrl(): Promise<void> {
  if (!isDesktopRuntime()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const baseUrl = (await invoke("get_api_base_url")) as string;
    apiPrefix = `${baseUrl.replace(/\/$/, "")}/api`;
    http.defaults.baseURL = apiPrefix;
  } catch (error) {
    console.error("Failed to initialize desktop backend URL", error);
  }
}

export interface DesktopBootProgress {
  progress: number;
  stage: string;
  detail: string;
}

export interface DesktopResourceUsage {
  app_cpu_percent: number;
  app_memory_bytes: number;
  used_memory_bytes: number;
  total_memory_bytes: number;
  used_memory_percent: number;
  top_processes: DesktopResourceProcess[];
}

export interface DesktopResourceProcess {
  pid: number;
  parent_pid: number;
  name: string;
  cpu_percent: number;
  memory_bytes: number;
  command: string;
  can_terminate: boolean;
  group: string;
  session: string;
}

export interface DesktopTerminateProcessResult {
  message: string;
  pids: number[];
  process_groups: number[];
}

export interface InitGuardDetail {
  type: "memory_guard" | "duplicate_guard";
  message: string;
  required_gb: number;
  available_gb: number;
  total_gb: number;
  can_continue: boolean;
  suggested_mode: "conservative" | "standard" | "quality";
  suggested_dit: string;
  suggested_lm: string;
}

export async function fetchDesktopBootProgress(): Promise<DesktopBootProgress | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("get_boot_progress")) as DesktopBootProgress;
  } catch {
    return null;
  }
}

export async function fetchDesktopResourceUsage(): Promise<DesktopResourceUsage | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("get_resource_usage")) as DesktopResourceUsage;
  } catch {
    return null;
  }
}

export async function terminateDesktopResourceProcess(pid: number): Promise<DesktopTerminateProcessResult | null> {
  if (!isDesktopRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke("terminate_resource_process", { pid })) as DesktopTerminateProcessResult;
}

export async function listenDesktopBootProgress(
  onProgress: (payload: DesktopBootProgress) => void,
): Promise<() => void> {
  if (!isDesktopRuntime()) return () => { };
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<DesktopBootProgress>("boot-progress", (event) => {
      onProgress(event.payload);
    });
  } catch {
    return () => { };
  }
}

// ---------- Directory browser ----------

export interface BrowseDirResult {
  path: string;
  cancelled: boolean;
}

export async function browseDirectory(
  title = "选择目录",
): Promise<BrowseDirResult> {
  const { data } = await http.post<BrowseDirResult>("/settings/browse-directory", {
    title,
  });
  return data;
}

// ---------- Separation ----------

export async function fetchCapabilities(
  engine?: string,
): Promise<EngineCapabilities> {
  const { data } = await http.get<EngineCapabilities>("/engine/capabilities", {
    params: engine ? { engine } : undefined,
  });
  return data;
}

export async function createJob(
  file: File,
  stems: string[],
  engine?: string,
  outputFormat: string = "wav",
): Promise<JobStatus> {
  const form = new FormData();
  form.append("file", file);
  form.append("stems", JSON.stringify(stems));
  if (engine) form.append("engine", engine);
  form.append("output_format", outputFormat);
  const { data } = await http.post<JobStatus>("/jobs", form);
  return data;
}

export async function fetchJob(jobId: string): Promise<JobStatus> {
  const { data } = await http.get<JobStatus>(`/jobs/${jobId}`);
  return data;
}

export async function fetchSeparationHistory(): Promise<JobStatus[]> {
  const { data } = await http.get<JobStatus[]>("/jobs/history");
  return data;
}

export async function deleteSeparationHistory(jobId: string): Promise<void> {
  await http.delete(`/jobs/history/${jobId}`);
}

export async function fetchSettings(): Promise<RuntimeSettingsOut> {
  const { data } = await http.get<RuntimeSettingsOut>("/settings");
  return data;
}

export async function saveSettings(payload: {
  default_engine?: string;
  lalal_api_key?: string;
  cascade_vocal_split?: boolean;
  karaoke_model?: string;
  workspace_dir?: string;
  acestep_checkpoints_dir?: string;
  generation_output_dir?: string;
  history_output_dir?: string;
  separation_output_dir?: string;
  acestep_tmp_dir?: string;
  gen_dit_model?: string;
  gen_lm_model?: string;
  generation_performance_mode?: "conservative" | "standard" | "quality";
  svc_models_dir?: string;
  vendor_dir?: string;
  resources_dir?: string;
  migrate_existing_data?: boolean;
  cleanup_old_temp_cache?: boolean;
}): Promise<RuntimeSettingsOut> {
  const { data } = await http.put<RuntimeSettingsOut>("/settings", payload);
  return data;
}

export async function fetchRuntimeLog(
  name: RuntimeLog["name"],
  lines = 300,
): Promise<RuntimeLog> {
  const { data } = await http.get<RuntimeLog>(`/logs/${name}`, {
    params: { lines },
  });
  return data;
}

export function runtimeLogEventsUrl(name: RuntimeLog["name"]): string {
  return apiUrl(`/logs/${name}/events`);
}

export function stemDownloadUrl(jobId: string, stemId: string): string {
  return apiUrl(`/stems/${jobId}/${stemId}?download=true`);
}

export function stemStreamUrl(jobId: string, stemId: string): string {
  return apiUrl(`/stems/${jobId}/${stemId}`);
}

export function downloadAllUrl(jobId: string): string {
  return apiUrl(`/jobs/${jobId}/download-all`);
}

export function jobEventsUrl(jobId: string): string {
  return apiUrl(`/jobs/${jobId}/events`);
}

// ---------- Music generation (ACE-Step) ----------

export async function fetchGenerationCapabilities(): Promise<GenerationCapabilities> {
  const { data } = await http.get<GenerationCapabilities>("/generation/capabilities");
  return data;
}

export async function fetchLoras(): Promise<LoraListResponse> {
  const { data } = await http.get<LoraListResponse>("/generation/loras");
  return data;
}

export async function downloadLora(id: string): Promise<LoraItem> {
  const { data } = await http.post<LoraItem>("/generation/loras/download", { id });
  return data;
}

export async function createGeneration(params: GenerationParams): Promise<JobStatus> {
  const payload = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null),
  );
  const { data } = await http.post<JobStatus>("/generation", payload);
  return data;
}

export async function initializeGeneration(opts?: {
  dit_model?: string;
  lm_model?: string;
  force_memory_guard?: boolean;
}): Promise<JobStatus> {
  const { data } = await http.post<JobStatus>(
    "/generation/initialize",
    opts ?? null,
  );
  return data;
}

export async function startGenerationService(): Promise<{
  ok: boolean;
  service_up: boolean;
  starting: boolean;
  log?: string;
}> {
  const { data } = await http.post("/generation/service/start");
  return data;
}

export async function stopGenerationService(): Promise<{
  ok: boolean;
  service_up: boolean;
}> {
  const { data } = await http.post("/generation/service/stop");
  return data;
}

export async function restartGenerationService(): Promise<{
  ok: boolean;
  service_up: boolean;
  starting?: boolean;
  log?: string;
}> {
  const { data } = await http.post("/generation/service/restart");
  return data;
}

export async function restartSvcService(): Promise<{
  ok: boolean;
  service_up: boolean;
  restarting: boolean;
  reason?: string;
}> {
  const { data } = await http.post("/svc/service/restart");
  return data;
}

export async function fetchGenerationJob(jobId: string): Promise<JobStatus> {
  const { data } = await http.get<JobStatus>(`/generation/${jobId}`);
  return data;
}

export function generationEventsUrl(jobId: string): string {
  return apiUrl(`/generation/${jobId}/events`);
}

export function generationTrackStreamUrl(jobId: string, index: number): string {
  return apiUrl(`/generation/${jobId}/track/${index}`);
}

export function generationTrackDownloadUrl(jobId: string, index: number): string {
  return apiUrl(`/generation/${jobId}/track/${index}?download=true`);
}

export async function fetchGenerationHistory(): Promise<GenHistoryItem[]> {
  const { data } = await http.get<GenHistoryItem[]>("/generation/history");
  return data;
}

export function historyFileStreamUrl(jobId: string, name: string): string {
  return apiUrl(`/generation/history/${jobId}/file?name=${encodeURIComponent(name)}`);
}

export function historyFileDownloadUrl(jobId: string, name: string): string {
  return apiUrl(`/generation/history/${jobId}/file?name=${encodeURIComponent(name)}&download=true`);
}

export function historyParamsDownloadUrl(jobId: string): string {
  return apiUrl(`/generation/history/${jobId}/params?download=true`);
}

export async function deleteGenerationHistory(jobId: string): Promise<void> {
  await http.delete(`/generation/history/${jobId}`);
}

export async function renameGenerationHistory(
  jobId: string,
  title: string,
): Promise<GenHistoryItem> {
  const { data } = await http.patch<GenHistoryItem>(
    `/generation/history/${jobId}/rename`,
    { title },
  );
  return data;
}

export async function uploadGenerationAudio(
  file: File,
): Promise<{ token: string; filename: string }> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await http.post<{ token: string; filename: string }>(
    "/generation/upload",
    form,
  );
  return data;
}

export interface FormatInputResult {
  caption?: string;
  lyrics?: string;
  bpm?: number;
  key_scale?: string;
  time_signature?: string;
  duration?: number;
  vocal_language?: string;
}

export async function formatInput(payload: {
  prompt?: string;
  lyrics?: string;
  param_obj?: Record<string, unknown>;
}): Promise<FormatInputResult> {
  const { data } = await http.post<FormatInputResult>(
    "/generation/format-input",
    payload,
  );
  return data;
}

export async function createRandomSample(
  sampleType = "simple_mode",
): Promise<FormatInputResult> {
  const { data } = await http.post<FormatInputResult>("/generation/random-sample", {
    sample_type: sampleType,
  });
  return data;
}

// ---------- SVC (voice conversion) ----------

export async function fetchSvcCapabilities(): Promise<SvcCapabilities> {
  const { data } = await http.get<SvcCapabilities>("/svc/capabilities");
  return data;
}

export async function fetchSvcVoices(): Promise<SvcVoice[]> {
  const { data } = await http.get<SvcVoice[]>("/svc/voices");
  return data;
}

export async function deleteSvcVoice(voiceId: string): Promise<void> {
  await http.delete(`/svc/voices/${voiceId}`);
}

export function svcVoiceExportUrl(voiceId: string): string {
  return apiUrl(`/svc/voices/${voiceId}/export`);
}

export async function importSvcVoice(file: File): Promise<SvcVoice> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await http.post<SvcVoice>("/svc/voices/import", form);
  return data;
}

export async function previewSvcVoice(
  voiceId: string,
  file: File,
  transpose = 0,
): Promise<Blob> {
  const form = new FormData();
  form.append("file", file);
  form.append("transpose", String(transpose));
  const { data } = await http.post(`/svc/voices/${voiceId}/preview`, form, {
    responseType: "blob",
  });
  return data;
}

export async function trainSvc(
  files: File[],
  opts: { name: string; engine: string; max_epochs?: number },
): Promise<SvcTrainStatus> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  form.append("name", opts.name);
  form.append("engine", opts.engine);
  form.append("max_epochs", String(opts.max_epochs ?? 50));
  const { data } = await http.post<SvcTrainStatus>("/svc/train", form);
  return data;
}

export async function fetchSvcTrainStatus(
  trainId: string,
): Promise<SvcTrainStatus> {
  const { data } = await http.get<SvcTrainStatus>(`/svc/train/${trainId}`);
  return data;
}

export async function sendGeneratedToSeparation(
  jobId: string,
  index: number,
): Promise<JobStatus> {
  const { data } = await http.post<JobStatus>(
    `/generation/${jobId}/to-separation`,
    null,
    { params: { index } },
  );
  return data;
}

// ---------- Music editor (multi-track mix + pitch/tempo) ----------

export async function createEdit(req: EditRequest): Promise<JobStatus> {
  const { data } = await http.post<JobStatus>("/edit", req);
  return data;
}

export interface MelodyRequest {
  backing?: EditTrackSpec | null;
  duration_sec?: number;
  key_name?: string | null;
  bpm?: number | null;
  seed?: number | null;
  syllables?: number | null;
  program?: number;
}

export interface MelodyResult {
  bpm: number;
  key_name: string;
  program: number;
  notes: MidiNote[];
}

export async function generateMelody(req: MelodyRequest): Promise<MelodyResult> {
  const { data } = await http.post<MelodyResult>("/edit/melody", req);
  return data;
}

export async function uploadEditTrack(
  file: File,
): Promise<{ upload_name: string; label: string }> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await http.post<{ upload_name: string; label: string }>(
    "/edit/upload",
    form,
  );
  return data;
}

export async function fetchEditJob(jobId: string): Promise<JobStatus> {
  const { data } = await http.get<JobStatus>(`/edit/${jobId}`);
  return data;
}

export function editEventsUrl(jobId: string): string {
  return apiUrl(`/edit/${jobId}/events`);
}

export function editResultUrl(jobId: string, download = false): string {
  return apiUrl(`/edit/${jobId}/result${download ? "?download=true" : ""}`);
}
