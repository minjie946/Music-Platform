import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import type { EditorTrack } from "./EditorPanel";
import { EffectsPanel, hasActiveEffects } from "./EffectsPanel";
import { Select } from "./Select";

// dB <-> linear gain (UI shows dB, backend takes linear).
export function gainToDb(gain: number): number {
  if (gain <= 0) return -60;
  return Math.max(-60, Math.round(20 * Math.log10(gain)));
}
export function dbToGain(db: number): number {
  if (db <= -60) return 0;
  return Number((10 ** (db / 20)).toFixed(4));
}

const HEADER_W = 184; // px, fixed lane-header column
const SNAP_SEC = 0.25; // drag snap grid
const LANE_H = 76; // px, clip lane height
const MIN_CLIP_SEC = 0.1; // minimum visible clip length after trimming

/** Visible clip length in seconds (accounts for trim window). */
function visibleLen(t: EditorTrack): number {
  const end = t.clip_end_sec > 0 ? t.clip_end_sec : t.durationSec || 0;
  return Math.max(0, end - t.clip_start_sec);
}

// Common General MIDI programs for the 4-A instrument picker.
const GM_PROGRAMS: { value: number; label: string }[] = [
  { value: 0, label: "大钢琴" },
  { value: 4, label: "电钢琴" },
  { value: 24, label: "尼龙吉他" },
  { value: 27, label: "电吉他" },
  { value: 33, label: "电贝斯" },
  { value: 48, label: "弦乐合奏" },
  { value: 56, label: "小号" },
  { value: 73, label: "长笛" },
  { value: 80, label: "合成主音" },
];
function gmLabel(program: number): string {
  return GM_PROGRAMS.find((p) => p.value === program)?.label ?? `Program ${program}`;
}

interface Props {
  tracks: EditorTrack[];
  pxPerSec: number;
  currentSec: number;
  isEffectivelyMuted: (t: EditorTrack) => boolean;
  onOffsetChange: (uid: string, offsetSec: number) => void;
  onPatch: (uid: string, patch: Partial<EditorTrack>) => void;
  onPatchLane: (laneId: string, patch: Partial<EditorTrack>) => void;
  onRemoveLane: (laneId: string) => void;
  onDuplicate: (uid: string) => void;
  onSplit: (uid: string) => void;
  onSeek: (sec: number) => void;
  onEditMidi: (uid: string) => void;
  register: (uid: string, ws: WaveSurfer | null) => void;
}

function LaneClip({
  track,
  pxPerSec,
  muted,
  onOffsetChange,
  onPatch,
  onDuplicate,
  onSplit,
  onEditMidi,
  register,
}: {
  track: EditorTrack;
  pxPerSec: number;
  muted: boolean;
  onOffsetChange: (uid: string, offsetSec: number) => void;
  onPatch: (uid: string, patch: Partial<EditorTrack>) => void;
  onDuplicate: (uid: string) => void;
  onSplit: (uid: string) => void;
  onEditMidi: (uid: string) => void;
  register: (uid: string, ws: WaveSurfer | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const moveRef = useRef<{ startX: number; startOffset: number } | null>(null);
  const trimRef = useRef<
    | {
      edge: "left" | "right";
      startX: number;
      startOffset: number;
      startClipStart: number;
      startClipEnd: number;
    }
    | null
  >(null);

  const dur = track.durationSec || 0;
  const vis = visibleLen(track);
  const width = Math.max(12, vis * pxPerSec);
  const left = Math.max(0, track.offset_sec * pxPerSec);
  // Full-width inner waveform, shifted left so the visible window shows the trim region.
  const innerWidth = Math.max(width, dur * pxPerSec);
  const innerShift = -track.clip_start_sec * pxPerSec;
  const isMidi = track.source === "midi";

  useEffect(() => {
    if (!containerRef.current || !track.previewUrl) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "#4A4F5C",
      progressColor: "#5B54E6",
      cursorColor: "#B9B2F7",
      height: 44,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      fillParent: true,
      interact: false,
      url: track.previewUrl,
    });
    wsRef.current = ws;
    ws.on("ready", () => {
      register(track.uid, ws);
      const d = ws.getDuration();
      if (d && Math.abs(d - (track.durationSec || 0)) > 0.05) {
        onPatch(track.uid, { durationSec: d });
      }
    });
    return () => {
      register(track.uid, null);
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.previewUrl, track.uid]);

  // --- clip move (body drag) ---
  const onBodyDown = (e: React.PointerEvent) => {
    moveRef.current = { startX: e.clientX, startOffset: track.offset_sec };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onBodyMove = (e: React.PointerEvent) => {
    const d = moveRef.current;
    if (!d) return;
    const next = Math.max(0, Math.round((d.startOffset + (e.clientX - d.startX) / pxPerSec) / SNAP_SEC) * SNAP_SEC);
    onOffsetChange(track.uid, next);
  };
  const endBody = (e: React.PointerEvent) => {
    if (!moveRef.current) return;
    moveRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  // --- trim (edge drag) ---
  const onTrimDown = (edge: "left" | "right") => (e: React.PointerEvent) => {
    e.stopPropagation();
    trimRef.current = {
      edge,
      startX: e.clientX,
      startOffset: track.offset_sec,
      startClipStart: track.clip_start_sec,
      startClipEnd: track.clip_end_sec > 0 ? track.clip_end_sec : dur,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onTrimMove = (e: React.PointerEvent) => {
    const d = trimRef.current;
    if (!d) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - d.startX) / pxPerSec;
    if (d.edge === "right") {
      let end = d.startClipEnd + deltaSec;
      end = Math.min(dur, Math.max(d.startClipStart + MIN_CLIP_SEC, Math.round(end / SNAP_SEC) * SNAP_SEC));
      onPatch(track.uid, { clip_end_sec: end });
    } else {
      let start = d.startClipStart + deltaSec;
      start = Math.max(0, Math.min(d.startClipEnd - MIN_CLIP_SEC, Math.round(start / SNAP_SEC) * SNAP_SEC));
      const newOffset = Math.max(0, d.startOffset + (start - d.startClipStart));
      onPatch(track.uid, { clip_start_sec: start, offset_sec: newOffset });
    }
  };
  const endTrim = (e: React.PointerEvent) => {
    if (!trimRef.current) return;
    trimRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      onPointerDown={onBodyDown}
      onPointerMove={onBodyMove}
      onPointerUp={endBody}
      onPointerCancel={endBody}
      className={[
        "group absolute top-2 cursor-grab select-none overflow-hidden rounded-lg border active:cursor-grabbing",
        muted ? "border-white/5 bg-white/[0.03] opacity-50" : "border-brand-500/40 bg-brand-600/10",
      ].join(" ")}
      style={{ left, width, height: LANE_H - 16 }}
      title={`${track.label} · 起始 ${track.offset_sec.toFixed(2)}s · 时长 ${vis.toFixed(2)}s`}
    >
      <div className="pointer-events-none absolute left-1.5 top-1 z-10 max-w-[calc(100%-56px)] truncate text-[11px] font-medium text-gray-200">
        {track.label}
      </div>

      {/* hover actions: duplicate / split */}
      <div className="absolute right-1 top-0.5 z-20 flex gap-1 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate(track.uid);
          }}
          className="rounded bg-black/40 px-1 text-[10px] text-gray-200 hover:bg-black/70"
          title="复制片段"
        >
          复制
        </button>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onSplit(track.uid);
          }}
          className="rounded bg-black/40 px-1 text-[10px] text-gray-200 hover:bg-black/70"
          title="在播放头处分割"
        >
          分割
        </button>
      </div>

      {/* waveform (full width, shifted to reveal trim window) — or MIDI placeholder */}
      {isMidi ? (
        <div className="absolute inset-0 flex flex-col justify-end gap-0.5 px-1.5 pb-1 pt-4">
          <span className="pointer-events-none truncate text-[10px] font-medium text-brand-200">
            🎹 {gmLabel(track.midi?.program ?? 0)}
          </span>
          <div className="flex items-center justify-between gap-1">
            <span className="pointer-events-none text-[10px] text-gray-400">
              {track.midi?.notes?.length ?? 0} 音符
            </span>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onEditMidi(track.uid);
              }}
              className="rounded bg-black/40 px-1.5 text-[10px] text-brand-200 hover:bg-black/70"
              title="编辑音符（钢琴卷帘）"
            >
              编辑
            </button>
          </div>
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 overflow-hidden pt-4">
          <div style={{ width: innerWidth, transform: `translateX(${innerShift}px)` }} className="h-full">
            <div ref={containerRef} className="h-full w-full" />
          </div>
        </div>
      )}

      {/* trim handles */}
      <div
        onPointerDown={onTrimDown("left")}
        onPointerMove={onTrimMove}
        onPointerUp={endTrim}
        onPointerCancel={endTrim}
        className="absolute left-0 top-0 z-30 h-full w-1.5 cursor-ew-resize bg-white/20 opacity-0 group-hover:opacity-100"
      />
      <div
        onPointerDown={onTrimDown("right")}
        onPointerMove={onTrimMove}
        onPointerUp={endTrim}
        onPointerCancel={endTrim}
        className="absolute right-0 top-0 z-30 h-full w-1.5 cursor-ew-resize bg-white/20 opacity-0 group-hover:opacity-100"
      />
    </div>
  );
}

export function Timeline({
  tracks,
  pxPerSec,
  currentSec,
  isEffectivelyMuted,
  onOffsetChange,
  onPatch,
  onPatchLane,
  onRemoveLane,
  onDuplicate,
  onSplit,
  onSeek,
  onEditMidi,
  register,
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null);

  const totalSec = useMemo(() => {
    const end = tracks.reduce((m, t) => Math.max(m, t.offset_sec + visibleLen(t)), 0);
    return Math.max(30, Math.ceil(end) + 4);
  }, [tracks]);

  const laneWidth = totalSec * pxPerSec;
  const ticks = useMemo(() => {
    const arr: number[] = [];
    for (let s = 0; s <= totalSec; s += 1) arr.push(s);
    return arr;
  }, [totalSec]);

  // Group clips by laneId, preserving first-seen order.
  const lanes = useMemo(() => {
    const order: string[] = [];
    const byLane = new Map<string, EditorTrack[]>();
    for (const t of tracks) {
      if (!byLane.has(t.laneId)) {
        byLane.set(t.laneId, []);
        order.push(t.laneId);
      }
      byLane.get(t.laneId)!.push(t);
    }
    return order.map((laneId) => ({ laneId, clips: byLane.get(laneId)! }));
  }, [tracks]);

  const seekFromClientX = (clientX: number) => {
    const el = areaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const sec = Math.max(0, (clientX - rect.left + el.scrollLeft) / pxPerSec);
    onSeek(sec);
  };

  const playheadLeft = HEADER_W + currentSec * pxPerSec;

  return (
    <div ref={areaRef} className="relative min-h-0 flex-1 overflow-auto rounded-2xl border border-white/5 bg-[#0B0B0F]">
      <div style={{ width: HEADER_W + laneWidth }}>
        {/* Ruler */}
        <div className="flex border-b border-white/5">
          <div
            className="sticky left-0 z-20 shrink-0 border-r border-white/5 bg-[#0B0B0F] px-3 py-2 text-xs text-gray-500"
            style={{ width: HEADER_W }}
          >
            时间线（秒）
          </div>
          <div
            className="relative h-8 cursor-pointer"
            style={{ width: laneWidth }}
            onPointerDown={(e) => seekFromClientX(e.clientX)}
          >
            {ticks.map((s) => (
              <div key={s} className="absolute top-0 h-full border-l border-white/5" style={{ left: s * pxPerSec }}>
                {s % 5 === 0 && (
                  <span className="absolute left-1 top-1 text-[10px] tabular-nums text-gray-600">{s}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Lanes */}
        {lanes.map(({ laneId, clips }) => {
          const head = clips[0];
          const db = gainToDb(head.gain);
          return (
            <div key={laneId} className="flex border-b border-white/5">
              <LaneHeader track={head} db={db} onPatch={onPatch} onPatchLane={onPatchLane} onRemoveLane={onRemoveLane} />
              <div
                className="relative"
                style={{ width: laneWidth, height: LANE_H }}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) seekFromClientX(e.clientX);
                }}
              >
                {ticks.map((s) =>
                  s % 5 === 0 ? (
                    <div
                      key={s}
                      className="pointer-events-none absolute top-0 h-full border-l border-white/[0.03]"
                      style={{ left: s * pxPerSec }}
                    />
                  ) : null,
                )}
                {clips.map((c) => (
                  <LaneClip
                    key={c.uid}
                    track={c}
                    pxPerSec={pxPerSec}
                    muted={isEffectivelyMuted(c)}
                    onOffsetChange={onOffsetChange}
                    onPatch={onPatch}
                    onDuplicate={onDuplicate}
                    onSplit={onSplit}
                    onEditMidi={onEditMidi}
                    register={register}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Playhead */}
      <div
        className="pointer-events-none absolute top-0 z-40 w-px bg-brand-400"
        style={{ left: playheadLeft, height: "100%" }}
      >
        <div className="absolute -left-1 -top-0 h-2 w-2 rounded-full bg-brand-400" />
      </div>
    </div>
  );
}

function LaneHeader({
  track,
  db,
  onPatch,
  onPatchLane,
  onRemoveLane,
}: {
  track: EditorTrack;
  db: number;
  onPatch: (uid: string, patch: Partial<EditorTrack>) => void;
  onPatchLane: (laneId: string, patch: Partial<EditorTrack>) => void;
  onRemoveLane: (laneId: string) => void;
}) {
  const [fxRect, setFxRect] = useState<DOMRect | null>(null);
  const fxOn = hasActiveEffects(track.effects);
  return (
    <div
      className="sticky left-0 z-20 shrink-0 border-r border-white/5 bg-[#0B0B0F] px-3 py-2"
      style={{ width: HEADER_W, height: LANE_H }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-gray-100">{track.label}</div>
          <div className="text-[10px] text-gray-500">
            {track.source === "separation"
              ? "分轨"
              : track.source === "generation"
                ? "生成"
                : track.source === "midi"
                  ? "MIDI"
                  : "上传"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onPatchLane(track.laneId, { mute: !track.mute })}
            className={[
              "rounded border px-1.5 py-0.5 text-[10px] transition",
              track.mute
                ? "border-red-500/50 bg-red-500/15 text-red-300"
                : "border-white/10 text-gray-400 hover:bg-white/5",
            ].join(" ")}
          >
            静
          </button>
          <button
            type="button"
            onClick={() => onPatchLane(track.laneId, { solo: !track.solo })}
            className={[
              "rounded border px-1.5 py-0.5 text-[10px] transition",
              track.solo
                ? "border-brand-500/60 bg-brand-600/20 text-white"
                : "border-white/10 text-gray-400 hover:bg-white/5",
            ].join(" ")}
          >
            独
          </button>
          <button
            type="button"
            onClick={(e) =>
              setFxRect((r) => (r ? null : (e.currentTarget as HTMLElement).getBoundingClientRect()))
            }
            className={[
              "rounded border px-1.5 py-0.5 text-[10px] transition",
              fxOn
                ? "border-brand-500/60 bg-brand-600/20 text-white"
                : "border-white/10 text-gray-400 hover:bg-white/5",
            ].join(" ")}
            title="效果器"
          >
            FX
          </button>
          {(track.source === "upload" || track.source === "midi") && (
            <button
              type="button"
              onClick={() => onRemoveLane(track.laneId)}
              className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-gray-500 hover:border-red-500/50 hover:text-red-300"
            >
              ×
            </button>
          )}
        </div>
      </div>
      {fxRect && (
        <EffectsPanel
          anchorRect={fxRect}
          effects={track.effects}
          onChange={(patch) => onPatchLane(track.laneId, { effects: { ...track.effects, ...patch } })}
          onClose={() => setFxRect(null)}
        />
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="w-8 shrink-0 text-[10px] text-gray-500">音量</span>
        <input
          type="range"
          min={-60}
          max={6}
          step={1}
          value={db}
          onChange={(e) => onPatchLane(track.laneId, { gain: dbToGain(Number(e.target.value)) })}
          className="h-1 flex-1 accent-brand-500"
        />
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="w-8 shrink-0 text-[10px] text-gray-500">声像</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.1}
          value={track.pan ?? 0}
          onChange={(e) => onPatchLane(track.laneId, { pan: Number(e.target.value) })}
          className="h-1 flex-1 accent-brand-500"
          title={`声像 ${((track.pan ?? 0) * 100).toFixed(0)}`}
        />
      </div>
      {track.source === "midi" ? (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="w-8 shrink-0 text-[10px] text-gray-500">乐器</span>
          <Select
            value={String(track.midi?.program ?? 0)}
            onChange={(v) =>
              onPatch(track.uid, {
                midi: { ...(track.midi ?? { program: 0, notes: [] }), program: Number(v) },
              })
            }
            options={GM_PROGRAMS.map((p) => ({ value: String(p.value), label: p.label }))}
            ariaLabel="乐器"
            className="!py-1 !text-[11px]"
          />
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="w-8 shrink-0 text-[10px] text-gray-500">变调</span>
          <input
            type="range"
            min={-12}
            max={12}
            step={1}
            value={track.semitones}
            onChange={(e) => onPatchLane(track.laneId, { semitones: Number(e.target.value) })}
            className="h-1 flex-1 accent-brand-500"
          />
        </div>
      )}
    </div>
  );
}
