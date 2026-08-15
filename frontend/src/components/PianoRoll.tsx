import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MidiNote } from "../types";

/**
 * Modal piano-roll editor for a MIDI clip's notes. Notes are edited locally and
 * committed to the parent via `onChange` at each discrete action / drag end.
 *
 * Grid: X = time in seconds (0.25s snap, 120 BPM ⇒ 0.5s per beat), Y = pitch
 * (one row per semitone, higher pitches on top like a real piano roll).
 */
const PX_PER_SEC = 80; // 0.25s snap ⇒ 20px per cell
const ROW_H = 16; // px per semitone row
const KEY_W = 56; // left keyboard column width
const SNAP = 0.25; // seconds
const DEFAULT_DUR = 0.5; // one beat at 120 BPM
const MIN_DUR = 0.25;
const PITCH_LOW = 36; // C2
const PITCH_HIGH = 96; // C7
const RESIZE_ZONE = 8; // px hot zone on the right edge for resize

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);

function noteName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}
function isBlackKey(pitch: number): boolean {
  return BLACK_KEYS.has(((pitch % 12) + 12) % 12);
}
function snap(sec: number): number {
  return Math.max(0, Math.round(sec / SNAP) * SNAP);
}

interface EditNote extends MidiNote {
  id: string;
}

let _noteSeq = 0;
function newNoteId(): string {
  _noteSeq += 1;
  return `pn${_noteSeq}`;
}

interface Props {
  notes: MidiNote[];
  instrumentLabel: string;
  onChange: (notes: MidiNote[]) => void;
  onClose: () => void;
}

type DragState =
  | { kind: "move"; id: string; startX: number; startY: number; origStart: number; origPitch: number }
  | { kind: "resize"; id: string; startX: number; origDur: number; start: number }
  | null;

export function PianoRoll({ notes, instrumentLabel, onChange, onClose }: Props) {
  const [items, setItems] = useState<EditNote[]>(() =>
    notes.map((n) => ({ ...n, id: newNoteId() })),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>(null);
  const itemsRef = useRef<EditNote[]>(items);
  itemsRef.current = items;

  const pitches = useMemo(() => {
    const arr: number[] = [];
    for (let p = PITCH_HIGH; p >= PITCH_LOW; p -= 1) arr.push(p);
    return arr;
  }, []);

  const gridSeconds = useMemo(() => {
    const end = items.reduce((m, n) => Math.max(m, n.start_sec + n.dur_sec), 0);
    return Math.max(8, Math.ceil(end) + 2);
  }, [items]);
  const gridWidth = gridSeconds * PX_PER_SEC;
  const gridHeight = pitches.length * ROW_H;

  // Strip local ids and push the plain MidiNote[] to the parent.
  const commit = (next: EditNote[]) => {
    setItems(next);
    onChange(next.map(({ id: _id, ...n }) => n));
  };

  // Center the initial view around middle C (pitch 60).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rowY = (PITCH_HIGH - 60) * ROW_H;
    el.scrollTop = Math.max(0, rowY - el.clientHeight / 2);
  }, []);

  // Keyboard: Delete/Backspace removes the selected note; Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        commit(itemsRef.current.filter((n) => n.id !== selected));
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, onClose]);

  const pointToTime = (clientX: number): number => {
    const rect = gridRef.current!.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / PX_PER_SEC);
  };
  const pointToPitch = (clientY: number): number => {
    const rect = gridRef.current!.getBoundingClientRect();
    const row = Math.floor((clientY - rect.top) / ROW_H);
    return Math.min(PITCH_HIGH, Math.max(PITCH_LOW, PITCH_HIGH - row));
  };

  // Create a note when pressing on empty grid.
  const onGridDown = (e: React.PointerEvent) => {
    if (e.target !== gridRef.current) return;
    const start = snap(pointToTime(e.clientX));
    const pitch = pointToPitch(e.clientY);
    const note: EditNote = { id: newNoteId(), pitch, start_sec: start, dur_sec: DEFAULT_DUR, velocity: 100 };
    commit([...itemsRef.current, note]);
    setSelected(note.id);
  };

  // ---- drag (move / resize) via window listeners so notes cross rows freely ----
  const beginDrag = (state: DragState) => {
    dragRef.current = state;
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  };
  const onDragMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setItems((prev) =>
      prev.map((n) => {
        if (n.id !== d.id) return n;
        if (d.kind === "move") {
          const dt = (e.clientX - d.startX) / PX_PER_SEC;
          const dRows = Math.round((e.clientY - d.startY) / ROW_H);
          const pitch = Math.min(PITCH_HIGH, Math.max(PITCH_LOW, d.origPitch - dRows));
          return { ...n, start_sec: snap(d.origStart + dt), pitch };
        }
        const dt = (e.clientX - d.startX) / PX_PER_SEC;
        const dur = Math.max(MIN_DUR, snap(d.origDur + dt) || MIN_DUR);
        return { ...n, dur_sec: dur };
      }),
    );
  };
  const onDragEnd = () => {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    if (dragRef.current) onChange(itemsRef.current.map(({ id: _id, ...n }) => n));
    dragRef.current = null;
  };
  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNoteDown = (e: React.PointerEvent, n: EditNote) => {
    e.stopPropagation();
    setSelected(n.id);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const nearRight = e.clientX >= rect.right - RESIZE_ZONE;
    if (nearRight) {
      beginDrag({ kind: "resize", id: n.id, startX: e.clientX, origDur: n.dur_sec, start: n.start_sec });
    } else {
      beginDrag({ kind: "move", id: n.id, startX: e.clientX, startY: e.clientY, origStart: n.start_sec, origPitch: n.pitch });
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[86vh] w-[min(1000px,92vw)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111116] shadow-2xl shadow-black/60">
        {/* header */}
        <div className="flex shrink-0 items-center justify-between border-b border-white/5 px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-100">钢琴卷帘 · {instrumentLabel}</h3>
            <p className="mt-0.5 text-[11px] text-gray-500">
              点击空白格添加音符 · 拖动移动 · 拖右缘改时长 · 双击/Delete 删除 · 0.25s 吸附
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] tabular-nums text-gray-500">{items.length} 音符</span>
            <button
              type="button"
              onClick={() => {
                commit([]);
                setSelected(null);
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:border-red-500/50 hover:text-red-300"
            >
              清空
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-brand-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-500"
            >
              完成
            </button>
          </div>
        </div>

        {/* body: scrollable keyboard + grid */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          <div style={{ width: KEY_W + gridWidth }}>
            {/* ruler */}
            <div className="sticky top-0 z-20 flex bg-[#111116]">
              <div className="sticky left-0 z-30 shrink-0 border-b border-r border-white/5 bg-[#111116]" style={{ width: KEY_W, height: 22 }} />
              <div className="relative border-b border-white/5" style={{ width: gridWidth, height: 22 }}>
                {Array.from({ length: gridSeconds + 1 }, (_, s) => (
                  <div key={s} className="absolute top-0 h-full border-l border-white/5" style={{ left: s * PX_PER_SEC }}>
                    <span className="absolute left-1 top-0.5 text-[10px] tabular-nums text-gray-600">{s}s</span>
                  </div>
                ))}
              </div>
            </div>

            {/* keyboard + grid rows */}
            <div className="flex">
              {/* keyboard column (sticky left) */}
              <div className="sticky left-0 z-10 shrink-0 bg-[#0B0B0F]" style={{ width: KEY_W }}>
                {pitches.map((p) => (
                  <div
                    key={p}
                    className={[
                      "flex items-center justify-end border-b border-white/[0.04] pr-1.5 text-[9px] tabular-nums",
                      isBlackKey(p) ? "bg-[#08080b] text-gray-600" : "bg-[#141420] text-gray-400",
                    ].join(" ")}
                    style={{ height: ROW_H }}
                  >
                    {p % 12 === 0 ? noteName(p) : ""}
                  </div>
                ))}
              </div>

              {/* grid */}
              <div
                ref={gridRef}
                onPointerDown={onGridDown}
                className="relative cursor-crosshair select-none"
                style={{ width: gridWidth, height: gridHeight }}
              >
                {/* horizontal pitch rows */}
                {pitches.map((p, i) => (
                  <div
                    key={p}
                    className={[
                      "pointer-events-none absolute left-0 w-full border-b border-white/[0.03]",
                      isBlackKey(p) ? "bg-white/[0.015]" : "",
                    ].join(" ")}
                    style={{ top: i * ROW_H, height: ROW_H }}
                  />
                ))}
                {/* vertical beat / snap lines */}
                {Array.from({ length: gridSeconds * 4 + 1 }, (_, k) => {
                  const isSecond = k % 4 === 0;
                  const isBeat = k % 2 === 0;
                  return (
                    <div
                      key={k}
                      className={[
                        "pointer-events-none absolute top-0 h-full border-l",
                        isSecond ? "border-white/[0.08]" : isBeat ? "border-white/[0.05]" : "border-white/[0.02]",
                      ].join(" ")}
                      style={{ left: (k / 4) * PX_PER_SEC }}
                    />
                  );
                })}
                {/* notes */}
                {items.map((n) => {
                  const top = (PITCH_HIGH - n.pitch) * ROW_H;
                  const left = n.start_sec * PX_PER_SEC;
                  const width = Math.max(6, n.dur_sec * PX_PER_SEC);
                  const isSel = n.id === selected;
                  return (
                    <div
                      key={n.id}
                      onPointerDown={(e) => onNoteDown(e, n)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        commit(items.filter((x) => x.id !== n.id));
                        if (selected === n.id) setSelected(null);
                      }}
                      className={[
                        "absolute cursor-grab rounded-sm border active:cursor-grabbing",
                        isSel ? "border-brand-300 bg-brand-400" : "border-brand-500/60 bg-brand-500",
                      ].join(" ")}
                      style={{ top: top + 1, left, width, height: ROW_H - 2 }}
                      title={`${noteName(n.pitch)} · ${n.start_sec.toFixed(2)}s · ${n.dur_sec.toFixed(2)}s`}
                    >
                      <div className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize" />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
