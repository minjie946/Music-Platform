import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteGenerationHistory,
  fetchGenerationHistory,
  historyFileDownloadUrl,
  historyFileStreamUrl,
  historyParamsDownloadUrl,
  renameGenerationHistory,
} from "../api";
import type { GenHistoryItem, JobStatus } from "../types";
import { useConfirmModal, useToast } from "./AppFeedback";
import { useDownloadCenter } from "./DownloadCenter";
import { GenTrackCard } from "./GenTrackCard";
import { genToEditorTrack, type EditorTrack } from "./EditorPanel";
import { ProgressBar } from "./ProgressBar";
import { fmtDate } from "../utils/format";

interface Props {
  currentJob?: JobStatus | null;
  currentBatchSize?: number;
  currentParams?: Record<string, unknown>;
  onSeparate?: (jobId: string, index: number) => void;
  onSendToEditor?: (track: EditorTrack) => void;
  separatingTrack?: string | null;
}

type WorkspaceRecord =
  | { key: string; type: "current"; item: JobStatus }
  | { key: string; type: "history"; item: GenHistoryItem };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function textValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

const PARAM_FIELDS: Array<[string, string]> = [
  ["prompt", "提示词"],
  ["lyrics", "歌词"],
  ["sample_query", "简述"],
  ["audio_duration", "时长"],
  ["model", "模型"],
  ["task_type", "任务类型"],
  ["bpm", "BPM"],
  ["key_scale", "调式"],
  ["time_signature", "拍号"],
  ["vocal_language", "语言"],
  ["batch_size", "生成数量"],
  ["seed", "种子"],
  ["audio_format", "格式"],
];

function displayTitle(title: string, maxChars = 15): string {
  const chars = Array.from(title);
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : title;
}

/** Short, glanceable identity tags (model · duration · BPM · language) for a
 *  history item, so two prompt-named tracks are still distinguishable (W1/W3). */
function summaryChips(paramsInput: unknown): string[] {
  const params = asRecord(paramsInput);
  const ace = asRecord(params.acestep ?? params);
  const chips: string[] = [];
  const model = textValue(ace.model);
  if (model) chips.push(model.replace(/^acestep-?/i, "").toUpperCase() || model);
  const duration = textValue(ace.audio_duration);
  if (duration) chips.push(`${duration}s`);
  const bpm = textValue(ace.bpm);
  if (bpm) chips.push(`${bpm} BPM`);
  const lang = textValue(ace.vocal_language);
  if (lang) chips.push(lang.toUpperCase());
  return chips;
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M13.9 3.3a1.4 1.4 0 0 1 2 2l-8.7 8.7-3 .7.7-3 9-8.4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M7 7.5A1.5 1.5 0 0 1 8.5 6h6A1.5 1.5 0 0 1 16 7.5v7a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 7 14.5v-7Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M4 12.5v-7A1.5 1.5 0 0 1 5.5 4h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="m4.5 10.4 3.3 3.3 7.7-8.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="m5.5 5.5 9 9M14.5 5.5l-9 9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M4 6h12M8 6V4.5A1 1 0 0 1 9 4h2a1 1 0 0 1 1 1V6m2 0v9a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SongTitle({
  title,
  fallback,
  editable = true,
  onEdit,
}: {
  title?: string;
  fallback: string;
  editable?: boolean;
  onEdit: () => void;
}) {
  const value = title?.trim() || fallback;
  const isTruncated = Array.from(value).length > 15;
  return (
    <div className="group relative flex min-w-0 items-center gap-1.5">
      <div className="max-w-[15em] truncate font-medium text-gray-100">
        {displayTitle(value)}
      </div>
      {isTruncated && (
        <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden max-w-[320px] rounded-lg border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-200 shadow-xl group-hover:block">
          {value}
        </div>
      )}
      {editable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label="编辑歌曲名称"
          title="编辑歌曲名称"
          className="shrink-0 rounded p-1 text-gray-500 transition hover:bg-gray-800 hover:text-gray-200"
        >
          <EditIcon />
        </button>
      )}
    </div>
  );
}

function TrackSkeletonCard() {
  const bars = [18, 28, 14, 34, 22, 40, 26, 32, 16, 38, 24, 30, 20, 36, 18, 28];
  return (
    <div className="rounded-xl bg-gray-900/55 p-4 ring-1 ring-white/10">
      <div className="mb-3 flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-4 w-24 animate-pulse rounded bg-gray-700/80" />
          <div className="h-3 w-16 animate-pulse rounded bg-gray-800" />
        </div>
        <div className="h-7 w-14 animate-pulse rounded-lg bg-gray-800/80" />
      </div>
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-brand-900/70" />
        <div className="flex h-12 flex-1 items-center gap-1 overflow-hidden rounded-lg bg-gray-950/40 px-2">
          {bars.map((height, i) => (
            <div
              key={`${height}-${i}`}
              className="w-1.5 flex-1 animate-pulse rounded-full bg-gradient-to-t from-brand-700/70 to-brand-300/80"
              style={{ height, animationDelay: `${i * 70}ms` }}
            />
          ))}
        </div>
        <div className="h-3 w-20 shrink-0 animate-pulse rounded bg-gray-800" />
      </div>
    </div>
  );
}

export function GenHistoryList({
  currentJob,
  currentBatchSize = 1,
  currentParams,
  onSeparate,
  onSendToEditor,
  separatingTrack = null,
}: Props) {
  const qc = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [copiedParam, setCopiedParam] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const { confirm, confirmNode } = useConfirmModal();
  const { showToast, toastNode } = useToast();
  const { startDownload } = useDownloadCenter();
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["gen-history"],
    queryFn: fetchGenerationHistory,
    refetchInterval: 30000,
  });

  const items = useMemo(
    () =>
      [...(data ?? [])]
        .filter((item) => item.job_id !== currentJob?.id)
        .sort((a, b) => b.created_at - a.created_at),
    [data, currentJob?.id],
  );

  const records = useMemo<WorkspaceRecord[]>(
    () => [
      ...(currentJob ? [{ key: `current:${currentJob.id}`, type: "current" as const, item: currentJob }] : []),
      ...items.map((item) => ({ key: `history:${item.job_id}`, type: "history" as const, item })),
    ],
    [currentJob, items],
  );

  const selected = records.find((record) => record.key === selectedKey) ?? records[0] ?? null;

  useEffect(() => {
    setParamsExpanded(false);
  }, [selected?.key]);

  useEffect(() => {
    if (currentJob?.id) setSelectedKey(`current:${currentJob.id}`);
  }, [currentJob?.id]);

  useEffect(() => {
    if (!selectedKey && records.length > 0) {
      setSelectedKey(records[0].key);
      return;
    }
    if (selectedKey && records.length > 0 && !records.some((record) => record.key === selectedKey)) {
      setSelectedKey(records[0].key);
    }
  }, [records, selectedKey]);

  const handleDelete = async (jobId: string, title: string) => {
    const ok = await confirm({
      title: "删除生成记录",
      description: `确定删除「${title}」的全部生成文件？此操作不可恢复。`,
      confirmText: "删除",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteGenerationHistory(jobId);
      if (selectedKey === `history:${jobId}`) setSelectedKey(null);
      qc.invalidateQueries({ queryKey: ["gen-history"] });
      showToast("生成记录已删除", "success");
    } catch {
      showToast("删除生成记录失败，请稍后重试", "error");
    }
  };

  const handleSaveRename = async (jobId: string) => {
    const trimmed = editValue.trim();
    if (trimmed) {
      try {
        await renameGenerationHistory(jobId, trimmed);
        qc.invalidateQueries({ queryKey: ["gen-history"] });
      } catch {
        // ignore
      }
    }
    setEditingId(null);
  };

  const handleCopyParam = async (copyId: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedParam(copyId);
      window.setTimeout(() => setCopiedParam(null), 1200);
    } catch {
      setCopiedParam(null);
    }
  };

  const renderParams = (paramsInput: unknown, copyScope: string, showDownloadUrl?: string) => {
    const params = asRecord(paramsInput);
    const ace = asRecord(params.acestep ?? params);
    const svc = asRecord(params.svc);
    const hasAnyParam = PARAM_FIELDS.some(([key]) => !!textValue(ace[key])) || Object.keys(svc).length > 0;
    if (!hasAnyParam) {
      return (
        <div className="rounded-lg bg-gray-950/40 p-3 text-sm text-gray-500">
          暂无可展示的生成参数。
        </div>
      );
    }

    return (
      <div className="rounded-lg bg-gray-950/35 p-3 ring-1 ring-white/5">
        <div className="mb-2 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setParamsExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-gray-300 transition hover:text-gray-100"
            aria-expanded={paramsExpanded}
          >
            <span className="text-gray-500">{paramsExpanded ? "▾" : "▸"}</span>
            生成参数
          </button>
          {showDownloadUrl && paramsExpanded && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await startDownload(
                    showDownloadUrl,
                    `${copyScope.replace(":", "_")}_params.json`,
                  );
                  showToast("参数文件已开始下载", "success");
                } catch {
                  showToast("下载参数失败，请稍后重试", "error");
                }
              }}
              className="text-xs text-brand-300 hover:text-brand-200 hover:underline"
            >
              下载参数
            </button>
          )}
        </div>
        {!paramsExpanded ? (
          <div className="flex flex-wrap gap-1.5">
            {summaryChips(paramsInput).length > 0 ? (
              summaryChips(paramsInput).map((chip) => (
                <span key={chip} className="rounded bg-gray-900/70 px-2 py-0.5 text-[11px] text-gray-300">
                  {chip}
                </span>
              ))
            ) : (
              <span className="text-[11px] text-gray-500">点击展开查看完整参数</span>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {PARAM_FIELDS.map(([key, label]) => {
              const value = textValue(ace[key]);
              if (!value) return null;
              const isLong = key === "lyrics" || key === "prompt" || key === "sample_query";
              const copyable = key === "lyrics" || key === "prompt";
              const copyId = `${copyScope}:${key}`;
              return (
                <div key={key} className={isLong ? "text-xs xl:col-span-2" : "text-xs"}>
                  <div className="mb-0.5 flex items-center justify-between gap-2 text-gray-500">
                    <span>{label}</span>
                    {copyable && (
                      <button
                        type="button"
                        onClick={() => handleCopyParam(copyId, value)}
                        className={[
                          "rounded p-1 transition hover:bg-gray-800",
                          copiedParam === copyId ? "text-emerald-300" : "text-gray-500 hover:text-gray-200",
                        ].join(" ")}
                        title={copiedParam === copyId ? "已复制" : `复制${label}`}
                        aria-label={copiedParam === copyId ? "已复制" : `复制${label}`}
                      >
                        <CopyIcon />
                      </button>
                    )}
                  </div>
                  <div
                    className={[
                      "whitespace-pre-wrap rounded bg-gray-900/55 px-2 py-1 text-gray-200",
                      isLong ? "max-h-36 overflow-auto" : "",
                    ].join(" ")}
                  >
                    {value}
                  </div>
                </div>
              );
            })}
            {Object.keys(svc).length > 0 && (
              <div className="text-xs xl:col-span-2">
                <div className="mb-0.5 text-gray-500">人声模式</div>
                <div className="whitespace-pre-wrap rounded bg-gray-900/55 px-2 py-1 text-gray-200">
                  {textValue(svc)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderCurrentDetail = (job: JobStatus) => {
    const running = job.state === "queued" || job.state === "running";
    const stateLabel = job.state === "done" ? "已完成" : job.state === "failed" ? "失败" : "生成中";
    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-gray-900/45 p-4 ring-1 ring-white/10">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-lg font-semibold leading-6 text-gray-100">
                {job.title || "当前生成歌曲"}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                <span>任务 {job.id.slice(0, 8)}</span>
                {job.stage && <span>· {job.stage}</span>}
              </div>
            </div>
            <span
              className={[
                "shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs leading-none",
                job.state === "failed"
                  ? "bg-red-950/40 text-red-300"
                  : job.state === "done"
                    ? "bg-emerald-950/40 text-emerald-300"
                    : "bg-brand-950/40 text-brand-300",
              ].join(" ")}
            >
              {stateLabel}
            </span>
          </div>

          {running && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-gray-400">
                <span>{job.stage || "生成中"}</span>
                <span className="tabular-nums text-gray-300">{job.progress}%</span>
              </div>
              <ProgressBar value={job.progress} />
            </div>
          )}
        </div>

        {job.state === "failed" && (
          <div className="rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300">
            生成失败：{job.error ?? "未知错误"}
          </div>
        )}

        <div className="space-y-3">
          {(job.tracks ?? []).map((t) => (
            <GenTrackCard
              key={t.index}
              jobId={job.id}
              track={t}
              onSeparate={onSeparate ? (index) => onSeparate(job.id, index) : undefined}
              onEdit={
                onSendToEditor
                  ? (index) =>
                    onSendToEditor(
                      genToEditorTrack(job.id, index, t.filename || `${job.title || "音轨"} ${index}`, undefined, t.duration_sec),
                    )
                  : undefined
              }
              separating={separatingTrack === `${job.id}:${t.index}`}
            />
          ))}
          {running && (job.tracks ?? []).length === 0 && (
            <div className="space-y-3">
              {Array.from({ length: currentBatchSize }).map((_, i) => (
                <TrackSkeletonCard key={i} />
              ))}
            </div>
          )}
        </div>

        {renderParams(currentParams ?? {}, `current:${job.id}`)}
      </div>
    );
  };

  const renderHistoryDetail = (item: GenHistoryItem) => (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold text-gray-100" title={item.title}>{item.title}</h3>
          <div className="text-xs text-gray-500">
            {fmtDate(item.created_at)} · {item.tracks.length} 个文件 · 任务 {item.job_id.slice(0, 8)}
          </div>
        </div>
        <button
          onClick={() => handleDelete(item.job_id, item.title)}
          title="删除该歌曲的全部生成文件"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-red-900/70 px-2.5 py-1 text-xs text-red-300 transition hover:border-red-500 hover:bg-red-950/40"
        >
          <TrashIcon />
          删除
        </button>
      </div>

      <div className="space-y-3">
        {item.tracks.map((t, index) => (
          <GenTrackCard
            key={t.filename}
            jobId={item.job_id}
            track={{
              index: index + 1,
              filename: t.filename,
              url: "",
              size_bytes: t.size_bytes,
              duration_sec: null,
              seed: "",
            }}
            title={t.filename}
            streamUrl={historyFileStreamUrl(item.job_id, t.filename)}
            downloadUrl={historyFileDownloadUrl(item.job_id, t.filename)}
            onSeparate={onSeparate ? (trackIndex) => onSeparate(item.job_id, trackIndex) : undefined}
            onEdit={
              onSendToEditor
                ? (trackIndex) =>
                  onSendToEditor(
                    genToEditorTrack(
                      item.job_id,
                      trackIndex,
                      t.filename,
                      historyFileStreamUrl(item.job_id, t.filename),
                    ),
                  )
                : undefined
            }
            separating={separatingTrack === `${item.job_id}:${index + 1}`}
          />
        ))}
      </div>

      {renderParams(item.params, `history:${item.job_id}`, historyParamsDownloadUrl(item.job_id))}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {confirmNode}
      {toastNode}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">工作台</h2>
          <p className="text-xs text-gray-500">左侧选择歌曲，右侧播放并查看生成参数。</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-50"
        >
          {isFetching ? "刷新中…" : "刷新"}
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-xl bg-gray-950/20 ring-1 ring-white/10 xl:grid-cols-[292px_1fr]">
        <div className="min-h-0 overflow-y-auto border-r border-gray-800/70 p-3">
          <div className="mb-3 text-sm font-medium text-gray-200">歌曲列表</div>
          {isLoading && records.length === 0 && <div className="text-xs text-gray-500">加载中…</div>}
          {isError && <div className="text-xs text-red-400">读取历史记录失败，请稍后重试。</div>}
          {!isLoading && !isError && records.length === 0 && <div className="text-xs text-gray-500">还没有生成记录。</div>}

          <div className="space-y-2">
            {records.map((record) => {
              const active = record.key === selected?.key;
              if (record.type === "current") {
                const job = record.item;
                const running = job.state === "queued" || job.state === "running";
                return (
                  <button
                    key={record.key}
                    onClick={() => setSelectedKey(record.key)}
                    className={[
                      "w-full rounded-lg px-3 py-2 text-left transition",
                      active ? "bg-brand-950/40 ring-1 ring-brand-500/70" : "bg-gray-900/35 hover:bg-gray-900/70",
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-sm font-medium text-gray-100">
                        {displayTitle(job.title || "当前生成歌曲")}
                      </div>
                      <span className="shrink-0 rounded-full bg-brand-950/60 px-1.5 py-0.5 text-[10px] text-brand-300">
                        当前
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      {running ? job.stage || "生成中" : "已完成"} · {(job.tracks ?? []).length || currentBatchSize} 个文件
                    </div>
                  </button>
                );
              }

              const item = record.item;
              return (
                <div
                  key={record.key}
                  onClick={() => setSelectedKey(record.key)}
                  className={[
                    "cursor-pointer rounded-lg px-3 py-2 transition",
                    active ? "bg-brand-950/40 ring-1 ring-brand-500/70" : "bg-gray-900/35 hover:bg-gray-900/70",
                  ].join(" ")}
                >
                  {editingId === item.job_id ? (
                    <div
                      className="flex min-w-0 items-center gap-1 rounded-md bg-gray-950/40 p-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveRename(item.job_id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        autoFocus
                        className="min-w-0 flex-1 rounded border border-brand-500 bg-gray-900 px-2 py-1 text-sm text-gray-100 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveRename(item.job_id)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-800/70 text-emerald-400 transition hover:bg-emerald-950/50 hover:text-emerald-300"
                        aria-label="保存歌曲名称"
                        title="保存"
                      >
                        <CheckIcon />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-700 text-gray-500 transition hover:bg-gray-800 hover:text-gray-300"
                        aria-label="取消编辑歌曲名称"
                        title="取消"
                      >
                        <XIcon />
                      </button>
                    </div>
                  ) : (
                    <SongTitle
                      title={item.title}
                      fallback="历史生成歌曲"
                      onEdit={() => {
                        setEditingId(item.job_id);
                        setEditValue(item.title);
                      }}
                    />
                  )}
                  <div className="mt-1 text-xs text-gray-500">
                    {fmtDate(item.created_at)} · {item.tracks.length} 个文件
                  </div>
                  {summaryChips(item.params).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {summaryChips(item.params).map((chip) => (
                        <span
                          key={chip}
                          className="rounded bg-gray-800/70 px-1.5 py-0.5 text-[10px] text-gray-400"
                        >
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          {selected ? (
            selected.type === "current" ? renderCurrentDetail(selected.item) : renderHistoryDetail(selected.item)
          ) : (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-gray-600">
              <div className="text-5xl mb-3">🎵</div>
              <p>选择左侧歌曲查看播放和参数</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
