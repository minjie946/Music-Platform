import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRecorder } from "../../hooks/useRecorder";
import { fmtDuration } from "../../utils/format";
import {
  analyzeSamples,
  decodeToMono,
  encodeWav,
  finalizeReport,
  type QualityReport,
} from "./audioQuality";
import {
  GROUP_LABEL,
  RECORDING_CLIPS,
  type ClipGroup,
  type RecordingClip,
} from "./recordingScript";

/** 单条录音的本地状态。 */
interface ClipRecording {
  status: "empty" | "analyzing" | "done";
  /** 用于试听的原始录音 URL。 */
  previewUrl?: string;
  /** 训练时提交的单声道 WAV。 */
  wav?: Blob;
  report?: QualityReport;
  error?: string;
}

export interface RecordingSummary {
  /** 达到「可用/合格」的已录制片段（level !== fail）对应的 WAV 文件。 */
  files: File[];
  totalCount: number;
  readyCount: number;
  /** 是否全部片段都已录制且合格（无 fail）。 */
  allReady: boolean;
}

interface RecordingStudioProps {
  /** 录音集合变化时回调，父组件据此决定能否开启训练。 */
  onChange: (summary: RecordingSummary) => void;
  disabled?: boolean;
}

const GROUP_ORDER: ClipGroup[] = ["speech", "singing"];

export function RecordingStudio({ onChange, disabled }: RecordingStudioProps) {
  const [recordings, setRecordings] = useState<Record<string, ClipRecording>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const recorder = useRecorder();
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;

  // 卸载时清理所有 objectURL，避免内存泄漏。
  useEffect(() => {
    return () => {
      Object.values(recordingsRef.current).forEach((r) => {
        if (r.previewUrl) URL.revokeObjectURL(r.previewUrl);
      });
    };
  }, []);

  const summary = useMemo<RecordingSummary>(() => {
    const files: File[] = [];
    let readyCount = 0;
    for (const clip of RECORDING_CLIPS) {
      const rec = recordings[clip.id];
      if (rec?.status === "done" && rec.wav && rec.report && rec.report.level !== "fail") {
        readyCount += 1;
        files.push(new File([rec.wav], `${clip.id}.wav`, { type: "audio/wav" }));
      }
    }
    return {
      files,
      totalCount: RECORDING_CLIPS.length,
      readyCount,
      allReady: readyCount === RECORDING_CLIPS.length,
    };
  }, [recordings]);

  useEffect(() => {
    onChange(summary);
  }, [summary, onChange]);

  const updateClip = useCallback((id: string, patch: Partial<ClipRecording>) => {
    setRecordings((prev) => {
      const old = prev[id];
      if (old?.previewUrl && patch.previewUrl && patch.previewUrl !== old.previewUrl) {
        URL.revokeObjectURL(old.previewUrl);
      }
      return { ...prev, [id]: { ...old, status: "empty", ...patch } };
    });
  }, []);

  const handleStart = useCallback(
    async (clip: RecordingClip) => {
      if (recorder.state === "recording") return;
      setActiveId(clip.id);
      await recorder.start();
    },
    [recorder],
  );

  const handleStop = useCallback(
    async (clip: RecordingClip) => {
      const blob = await recorder.stop();
      setActiveId(null);
      if (!blob) {
        updateClip(clip.id, { status: "empty", error: "没有录到音频，请重试。" });
        return;
      }
      updateClip(clip.id, { status: "analyzing", error: undefined });
      try {
        const { samples, sampleRate } = await decodeToMono(blob);
        const report = finalizeReport(analyzeSamples(samples, sampleRate), clip.minSec);
        const wav = encodeWav(samples, sampleRate);
        const previewUrl = URL.createObjectURL(blob);
        updateClip(clip.id, { status: "done", wav, report, previewUrl, error: undefined });
      } catch {
        updateClip(clip.id, { status: "empty", error: "音频解码失败，请重试录音。" });
      }
    },
    [recorder, updateClip],
  );

  const handleCancel = useCallback(() => {
    recorder.cancel();
    setActiveId(null);
  }, [recorder]);

  const grouped = useMemo(() => {
    const map: Record<ClipGroup, RecordingClip[]> = { speech: [], singing: [] };
    for (const clip of RECORDING_CLIPS) map[clip.group].push(clip);
    return map;
  }, []);

  return (
    <div className="space-y-5">
      {recorder.error && (
        <div className="rounded-lg border border-red-700 bg-red-900/30 px-3 py-2 text-xs text-red-300">
          {recorder.error}
        </div>
      )}
      {GROUP_ORDER.map((group) => (
        <section key={group}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-200">
            {GROUP_LABEL[group]}
            <span className="text-[11px] text-gray-500">
              {groupReadyLabel(grouped[group], recordings)}
            </span>
          </h3>
          <ul className="space-y-2">
            {grouped[group].map((clip) => (
              <ClipRow
                key={clip.id}
                clip={clip}
                rec={recordings[clip.id]}
                isActive={activeId === clip.id}
                recorderState={recorder.state}
                level={recorder.level}
                elapsed={recorder.elapsed}
                disabled={!!disabled}
                onStart={() => handleStart(clip)}
                onStop={() => handleStop(clip)}
                onCancel={handleCancel}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface ClipRowProps {
  clip: RecordingClip;
  rec?: ClipRecording;
  isActive: boolean;
  recorderState: ReturnType<typeof useRecorder>["state"];
  level: number;
  elapsed: number;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}

function ClipRow({
  clip,
  rec,
  isActive,
  recorderState,
  level,
  elapsed,
  disabled,
  onStart,
  onStop,
  onCancel,
}: ClipRowProps) {
  const recording = isActive && recorderState === "recording";
  const busyElsewhere = !isActive && recorderState === "recording";
  const status = rec?.status ?? "empty";

  return (
    <li className={["rounded-lg border px-4 py-3", borderForRec(rec)].join(" ")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot rec={rec} recording={recording} />
            <span className="text-[11px] text-gray-500">{clip.section}</span>
            <span className="text-sm text-gray-100">{clip.title}</span>
            <span className="text-[11px] text-gray-500">建议 ≥ {clip.minSec}s</span>
          </div>
          <ul className="mt-1.5 space-y-0.5">
            {clip.lines.map((line, i) => (
              <li key={i} className="text-xs leading-relaxed text-gray-300">
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-gray-500">提示：{clip.tip}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {recording ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onStop}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
              >
                停止 {fmtDuration(elapsed)}
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-md border border-gray-700 px-2.5 py-1.5 text-xs text-gray-300 hover:border-gray-500"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={disabled || busyElsewhere || status === "analyzing"}
              className={[
                "rounded-md border px-3 py-1.5 text-xs transition",
                disabled || busyElsewhere || status === "analyzing"
                  ? "cursor-not-allowed border-gray-800 text-gray-600"
                  : "border-brand-600 text-brand-300 hover:bg-brand-500/10",
              ].join(" ")}
            >
              {status === "analyzing" ? "分析中…" : status === "done" ? "重录" : "开始录音"}
            </button>
          )}
        </div>
      </div>

      {recording && <LevelMeter level={level} />}

      {rec?.error && <p className="mt-2 text-[11px] text-red-400">{rec.error}</p>}

      {status === "done" && rec?.report && (
        <div className="mt-3 space-y-2">
          <QualityBadge report={rec.report} />
          {rec.report.issues.length > 0 && (
            <ul className="space-y-0.5">
              {rec.report.issues.map((issue, i) => (
                <li
                  key={i}
                  className={[
                    "text-[11px]",
                    issue.level === "fail" ? "text-red-400" : "text-amber-400",
                  ].join(" ")}
                >
                  · {issue.message}
                </li>
              ))}
            </ul>
          )}
          {rec.previewUrl && <audio controls src={rec.previewUrl} className="mt-1 h-8 w-full" />}
        </div>
      )}
    </li>
  );
}

function LevelMeter({ level }: { level: number }) {
  const pct = Math.min(100, Math.round(level * 140));
  return (
    <div className="mt-3">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-75"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-gray-500">正在录音，请对着麦克风朗读/演唱上面的内容…</p>
    </div>
  );
}

function StatusDot({ rec, recording }: { rec?: ClipRecording; recording: boolean }) {
  if (recording) return <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />;
  const level = rec?.status === "done" ? rec.report?.level : undefined;
  const color =
    level === "pass"
      ? "bg-emerald-500"
      : level === "warn"
        ? "bg-amber-500"
        : level === "fail"
          ? "bg-red-500"
          : "bg-gray-600";
  return <span className={`h-2 w-2 rounded-full ${color}`} />;
}

function QualityBadge({ report }: { report: QualityReport }) {
  const label =
    report.level === "pass" ? "合格" : report.level === "warn" ? "可用（有提示）" : "不合格";
  const tone =
    report.level === "pass"
      ? "border-emerald-700 bg-emerald-900/20 text-emerald-300"
      : report.level === "warn"
        ? "border-amber-700 bg-amber-900/20 text-amber-300"
        : "border-red-700 bg-red-900/20 text-red-300";
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5 text-[11px] ${tone}`}>
      <span className="font-medium">{label}</span>
      <span>时长 {report.durationSec.toFixed(1)}s</span>
      <span>峰值 {(report.peak * 100).toFixed(0)}%</span>
      {report.snrDb > 0 && <span>信噪比 ~{report.snrDb.toFixed(0)}dB</span>}
      {report.clipping && <span className="text-red-400">有爆音</span>}
    </div>
  );
}

function borderForRec(rec?: ClipRecording): string {
  const level = rec?.status === "done" ? rec.report?.level : undefined;
  if (level === "pass") return "border-emerald-800/60 bg-emerald-950/10";
  if (level === "warn") return "border-amber-800/60 bg-amber-950/10";
  if (level === "fail") return "border-red-800/60 bg-red-950/10";
  return "border-gray-800 bg-gray-900/40";
}

function groupReadyLabel(
  clips: RecordingClip[],
  recordings: Record<string, ClipRecording>,
): string {
  const ready = clips.filter((c) => {
    const rec = recordings[c.id];
    return rec?.status === "done" && rec.report && rec.report.level !== "fail";
  }).length;
  return `${ready}/${clips.length} 已就绪`;
}
