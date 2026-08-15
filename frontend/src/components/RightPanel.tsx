import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type WaveSurfer from "wavesurfer.js";
import { deleteSeparationHistory, downloadAllUrl, fetchSeparationHistory } from "../api";
import type { JobStatus } from "../types";
import { stemToEditorTrack, type EditorTrack } from "./EditorPanel";
import { useConfirmModal, useToast } from "./AppFeedback";
import { useDownloadCenter } from "./DownloadCenter";
import { ProgressBar } from "./ProgressBar";
import { StemCard } from "./StemCard";
import { fmtDate } from "../utils/format";

interface Props {
  job: JobStatus | null;
  onEdit?: (tracks: EditorTrack[]) => void;
}

function SeparationDetail({
  job,
  compact = false,
  onEdit,
}: {
  job: JobStatus;
  compact?: boolean;
  onEdit?: (tracks: EditorTrack[]) => void;
}) {
  const { startDownload } = useDownloadCenter();
  const wsMap = useRef<Map<string, WaveSurfer>>(new Map());
  const [allPlaying, setAllPlaying] = useState(false);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const register = useCallback((id: string, ws: WaveSurfer | null) => {
    if (ws) wsMap.current.set(id, ws);
    else {
      wsMap.current.delete(id);
      if (wsMap.current.size === 0) setAllPlaying(false);
    }
  }, []);

  const togglePlayAll = useCallback(() => {
    const list = Array.from(wsMap.current.values());
    if (list.length === 0) return;
    if (allPlaying) {
      list.forEach((w) => w.pause());
      setAllPlaying(false);
    } else {
      // Sync every track to the same position so they play together.
      const t = list[0].getCurrentTime();
      list.forEach((w) => {
        try {
          w.setTime(t);
        } catch {
          /* ignore */
        }
        w.play();
      });
      setAllPlaying(true);
    }
  }, [allPlaying]);

  const running = job.state === "queued" || job.state === "running";

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          <h3 className={["font-semibold text-gray-100 truncate", compact ? "text-base" : "text-lg"].join(" ")}>
            {job.original_filename}
          </h3>
          <p className="text-xs text-gray-500">
            引擎：{job.engine} · {fmtDate(job.created_at)} · 任务 {job.id.slice(0, 8)}
          </p>
        </div>
        {job.state === "done" && job.stems.length > 0 && (
          <div className="shrink-0 flex items-center gap-2">
            <button
              onClick={togglePlayAll}
              className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-100 hover:border-brand-400 hover:text-white transition"
            >
              {allPlaying ? "⏸ 全部暂停" : "▶ 一键播放"}
            </button>
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(job.stems.map((s) => stemToEditorTrack(job.id, s)))}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-100 hover:border-brand-400 hover:text-white transition"
              >
                → 编辑
              </button>
            )}
            <button
              type="button"
              disabled={downloadingAll}
              onClick={async () => {
                const base = (job.original_filename || "stems").replace(/\.[^/.]+$/, "");
                setDownloadingAll(true);
                try {
                  await startDownload(
                    downloadAllUrl(job.id),
                    `${base}_stems.zip`,
                  );
                } finally {
                  setDownloadingAll(false);
                }
              }}
              className="rounded-lg bg-brand-600 hover:bg-brand-500 px-4 py-2 text-sm font-medium text-white transition"
            >
              {downloadingAll ? "下载中…" : "一键下载全部"}
            </button>
          </div>
        )}
      </div>

      {running && (
        <div className="mb-5">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>{job.stage || "处理中"}</span>
            <span>{job.progress}%</span>
          </div>
          <ProgressBar value={job.progress} />
        </div>
      )}

      {job.state === "failed" && (
        <div className="rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300">
          处理失败：{job.error ?? "未知错误"}
        </div>
      )}

      <div className="min-h-0 space-y-3 pr-1">
        {job.stems.map((s) => (
          <StemCard key={s.stem} jobId={job.id} stem={s} onRegister={register} />
        ))}
        {running && job.stems.length === 0 && (
          <div className="space-y-3">
            {job.requested_stems.map((id) => (
              <div
                key={id}
                className="h-20 rounded-xl border border-gray-800 bg-gray-900/40 animate-pulse"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function RightPanel({ job, onEdit }: Props) {
  const qc = useQueryClient();
  const { confirm, confirmNode } = useConfirmModal();
  const { showToast, toastNode } = useToast();
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["separation-history"],
    queryFn: fetchSeparationHistory,
    refetchInterval: 30000,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const history = useMemo(
    () =>
      [...(data ?? [])]
        .filter((item) => item.id !== job?.id)
        .sort((a, b) => (b.created_at || b.updated_at) - (a.created_at || a.updated_at)),
    [data, job?.id],
  );
  const records = useMemo(
    () => (job ? [job, ...history] : history),
    [history, job],
  );

  useEffect(() => {
    if (job?.id) setSelectedId(job.id);
  }, [job?.id]);

  useEffect(() => {
    if (!selectedId && records.length > 0) {
      setSelectedId(records[0].id);
      return;
    }
    if (selectedId && records.length > 0 && !records.some((item) => item.id === selectedId)) {
      setSelectedId(records[0].id);
    }
  }, [records, selectedId]);

  useEffect(() => {
    if (job?.state === "done") refetch();
  }, [job?.state, refetch]);

  const selected = records.find((item) => item.id === selectedId) ?? records[0] ?? null;

  const handleDelete = async (item: JobStatus) => {
    const ok = await confirm({
      title: "删除分离记录",
      description: `确定删除「${item.original_filename || "未命名音频"}」的全部分轨文件？此操作不可恢复。`,
      confirmText: "删除",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteSeparationHistory(item.id);
      if (selectedId === item.id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["separation-history"] });
      showToast("分离记录已删除", "success");
    } catch {
      showToast("删除分离记录失败，请稍后重试", "error");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {confirmNode}
      {toastNode}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">工作台</h2>
          <p className="text-xs text-gray-500">当前分离任务置顶，历史记录按时间倒序排列。</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 disabled:opacity-50"
        >
          {isFetching ? "刷新中…" : "刷新"}
        </button>
      </div>

      {records.length === 0 && !isLoading && !isError && (
        <div className="flex min-h-[220px] flex-col items-center justify-center text-gray-600">
          <div className="text-5xl mb-3">🎚️</div>
          <p>上传音乐并选择分轨类型后，结果会显示在这里</p>
          <p className="mt-1 text-xs text-gray-500">历史分离记录也会展示在工作台中。</p>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[260px_1fr]">
        <div className="min-h-0 overflow-y-auto rounded-xl border border-gray-800 bg-gray-950/30 p-3">
          <div className="mb-3 text-sm font-medium text-gray-200">分离记录</div>
          {isLoading && records.length === 0 && <div className="text-xs text-gray-500">加载中…</div>}
          {isError && <div className="text-xs text-red-400">读取历史失败，请稍后重试。</div>}
          {!isLoading && !isError && records.length === 0 && (
            <div className="text-xs text-gray-500">还没有历史分离记录。</div>
          )}
          <div className="space-y-2">
            {records.map((item) => {
              const active = item.id === selected?.id;
              const isCurrent = item.id === job?.id;
              const running = item.state === "queued" || item.state === "running";
              return (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={[
                    "w-full rounded-lg border px-3 py-2 text-left transition",
                    active
                      ? "border-brand-600 bg-brand-950/30"
                      : "border-gray-800 bg-gray-900/50 hover:border-gray-600",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-medium text-gray-100">
                      {item.original_filename || "未命名音频"}
                    </div>
                    {isCurrent && (
                      <span className="shrink-0 rounded-full border border-brand-700 px-1.5 py-0.5 text-[10px] text-brand-300">
                        当前
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {running ? item.stage || "处理中" : fmtDate(item.created_at)}
                    {" · "}
                    {item.stems.length || item.requested_stems.length} 个分轨
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto rounded-xl border border-gray-800 bg-gray-950/30 p-4">
          {selected ? (
            <div className="flex min-h-0 flex-col">
              {selected.state === "done" && (
                <div className="mb-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleDelete(selected)}
                    className="rounded-lg border border-red-800/70 px-3 py-1.5 text-xs text-red-300 transition hover:bg-red-950/40 hover:text-red-200"
                  >
                    删除分离记录
                  </button>
                </div>
              )}
              <SeparationDetail job={selected} onEdit={onEdit} />
            </div>
          ) : (
            <div className="flex h-full min-h-[220px] flex-col items-center justify-center text-gray-600">
              <div className="text-4xl mb-3">🎧</div>
              <p>选择左侧历史记录查看分离详情</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
