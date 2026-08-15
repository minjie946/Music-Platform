import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import {
  generationTrackDownloadUrl,
  generationTrackStreamUrl,
} from "../api";
import type { GenTrack } from "../types";
import { useDownloadCenter } from "./DownloadCenter";
import { fmtDuration, fmtSize } from "../utils/format";

interface Props {
  jobId: string;
  track: GenTrack;
  onSeparate?: (index: number) => void;
  onEdit?: (index: number) => void;
  separating?: boolean;
  streamUrl?: string;
  downloadUrl?: string;
  title?: string;
}

export function GenTrackCard({
  jobId,
  track,
  onSeparate,
  onEdit,
  separating = false,
  streamUrl,
  downloadUrl,
  title,
}: Props) {
  const { startDownload } = useDownloadCenter();
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(track.duration_sec ?? 0);

  useEffect(() => {
    if (!containerRef.current) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#4A4F5C",
      progressColor: "#5B54E6",
      cursorColor: "#B9B2F7",
      height: 48,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      url: streamUrl ?? generationTrackStreamUrl(jobId, track.index),
    });
    wsRef.current = ws;
    ws.on("ready", () => {
      setReady(true);
      setDuration(ws.getDuration());
    });
    ws.on("timeupdate", (t) => setCurrent(t));
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [jobId, streamUrl, track.index]);

  return (
    <div className="rounded-xl bg-gray-900/55 p-4 ring-1 ring-white/10">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium text-gray-100">{title ?? `音轨 ${track.index}`}</div>
          <div className="text-xs text-gray-500">
            {fmtSize(track.size_bytes)}
            {track.seed && ` · seed ${track.seed}`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onSeparate && (
            <button
              onClick={() => onSeparate(track.index)}
              disabled={separating}
              className="text-xs rounded-lg bg-gray-800/80 px-3 py-1.5 text-gray-200 hover:bg-gray-700 hover:text-white transition disabled:opacity-50"
            >
              {separating ? "发送中…" : "→ 分离"}
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(track.index)}
              className="text-xs rounded-lg bg-gray-800/80 px-3 py-1.5 text-gray-200 hover:bg-gray-700 hover:text-white transition"
            >
              → 编辑
            </button>
          )}
          <button
            type="button"
            disabled={downloading}
            onClick={async () => {
              const url = downloadUrl ?? generationTrackDownloadUrl(jobId, track.index);
              setDownloading(true);
              try {
                await startDownload(
                  url,
                  title ?? track.filename ?? `track_${track.index}.wav`,
                );
              } finally {
                setDownloading(false);
              }
            }}
            className="text-xs rounded-lg bg-gray-800/80 px-3 py-1.5 text-gray-200 hover:bg-gray-700 hover:text-white transition"
          >
            {downloading ? "下载中…" : "下载"}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => wsRef.current?.playPause()}
          disabled={!ready}
          className={[
            "shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition",
            ready ? "bg-brand-600 hover:bg-brand-500 text-white" : "bg-gray-800 text-gray-600",
          ].join(" ")}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <div ref={containerRef} className="flex-1 min-w-0" />
        <div className="shrink-0 text-xs text-gray-400 tabular-nums w-20 text-right">
          {fmtDuration(current)} / {fmtDuration(duration)}
        </div>
      </div>
    </div>
  );
}
