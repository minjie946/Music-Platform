import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { stemDownloadUrl, stemStreamUrl } from "../api";
import type { StemResult } from "../types";
import { useDownloadCenter } from "./DownloadCenter";
import { fmtDuration, fmtSize } from "../utils/format";

interface Props {
  jobId: string;
  stem: StemResult;
  onRegister?: (stemId: string, ws: WaveSurfer | null) => void;
}

export function StemCard({ jobId, stem, onRegister }: Props) {
  const { startDownload } = useDownloadCenter();
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(stem.duration_sec ?? 0);

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
      url: stemStreamUrl(jobId, stem.stem),
    });
    wsRef.current = ws;
    ws.on("ready", () => {
      setReady(true);
      setDuration(ws.getDuration());
      onRegister?.(stem.stem, ws);
    });
    ws.on("timeupdate", (t) => setCurrent(t));
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));
    return () => {
      onRegister?.(stem.stem, null);
      ws.destroy();
      wsRef.current = null;
    };
  }, [jobId, stem.stem]);

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium text-gray-100">{stem.label_zh}</div>
          <div className="text-xs text-gray-500">
            {stem.label_en}
            {fmtSize(stem.size_bytes) && ` · ${fmtSize(stem.size_bytes)}`}
          </div>
        </div>
        <button
          type="button"
          disabled={downloading}
          onClick={async () => {
            setDownloading(true);
            try {
              await startDownload(
                stemDownloadUrl(jobId, stem.stem),
                stem.filename || `${stem.stem}.wav`,
              );
            } finally {
              setDownloading(false);
            }
          }}
          className="text-xs rounded-lg border border-gray-600 px-3 py-1.5 text-gray-200 hover:border-brand-400 hover:text-white transition"
        >
          {downloading ? "下载中…" : "下载"}
        </button>
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
