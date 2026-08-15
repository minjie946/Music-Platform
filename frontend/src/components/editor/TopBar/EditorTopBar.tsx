import { Select } from "../../Select";

export interface TransportState {
  playing: boolean;
  currentSec: number;
  bpm: number;
  timeSig: string; // e.g. "4/4"
  keyName: string; // e.g. "B 小调"
  masterVolume: number; // 0..1
}

interface Props {
  state: TransportState;
  canPlay: boolean;
  recording?: boolean;
  onTogglePlay: () => void;
  onToggleRecord?: () => void;
  onSeekStart: () => void;
  onBpmChange: (bpm: number) => void;
  onTimeSigChange: (sig: string) => void;
  onKeyChange: (key: string) => void;
  onMasterVolume: (v: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onExport: () => void;
  exporting?: boolean;
}

const TIME_SIGS = ["4/4", "3/4", "6/8", "2/4"];
const KEYS = [
  "C 大调", "G 大调", "D 大调", "A 大调", "E 大调", "F 大调",
  "A 小调", "E 小调", "B 小调", "D 小调", "G 小调",
];

/** 秒 -> 00:00.0 时间码。 */
function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec * 10) % 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${d}`;
}

const chip =
  "flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#15151d] px-3 py-1.5 text-sm text-gray-200";
const btn =
  "flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-gray-300 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40";

/** 编辑器顶栏：播放/录制/时间码 + BPM/拍号/调性 + 主音量 + 撤销重做/保存/导出。 */
export function EditorTopBar({
  state,
  canPlay,
  recording = false,
  onTogglePlay,
  onToggleRecord,
  onSeekStart,
  onBpmChange,
  onTimeSigChange,
  onKeyChange,
  onMasterVolume,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  onExport,
  exporting = false,
}: Props) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/5 px-4 py-3">
      {/* Transport */}
      <div className="flex items-center gap-1">
        <button type="button" onClick={onSeekStart} className={btn} title="回到开头">
          ⏮
        </button>
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={!canPlay && !state.playing}
          className={btn}
          title={state.playing ? "暂停" : "播放"}
        >
          {state.playing ? "⏸" : "▶"}
        </button>
        {onToggleRecord && (
          <button
            type="button"
            onClick={onToggleRecord}
            className={[btn, recording ? "text-red-400" : ""].join(" ")}
            title="录制"
          >
            ⏺
          </button>
        )}
      </div>

      <div className="rounded-lg bg-[#15151d] px-3 py-1.5 text-lg font-semibold tabular-nums text-gray-100">
        {fmtTime(state.currentSec)}
      </div>

      {/* BPM / 拍号 / 调性 */}
      <div className={chip}>
        <input
          type="number"
          min={40}
          max={300}
          value={state.bpm}
          onChange={(e) => onBpmChange(Number(e.target.value) || state.bpm)}
          className="w-12 bg-transparent text-right tabular-nums outline-none"
          aria-label="BPM"
        />
        <span className="text-xs text-gray-500">bpm</span>
      </div>

      <div className="w-24">
        <Select
          value={state.timeSig}
          onChange={onTimeSigChange}
          options={TIME_SIGS.map((s) => ({ value: s, label: s }))}
          ariaLabel="拍号"
        />
      </div>

      <div className="w-28">
        <Select
          value={state.keyName}
          onChange={onKeyChange}
          options={KEYS.map((k) => ({ value: k, label: k }))}
          ariaLabel="调性"
        />
      </div>

      {/* 主音量 */}
      <label className="flex items-center gap-2">
        <span className="text-xs text-gray-500">主音量</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={state.masterVolume}
          onChange={(e) => onMasterVolume(Number(e.target.value))}
          className="w-28 accent-brand-500"
          aria-label="主音量"
        />
      </label>

      <div className="flex-1" />

      {/* Undo / Redo */}
      <div className="flex items-center gap-1">
        <button type="button" onClick={onUndo} disabled={!canUndo} className={btn} title="撤销">
          ↶
        </button>
        <button type="button" onClick={onRedo} disabled={!canRedo} className={btn} title="重做">
          ↷
        </button>
      </div>

      <button
        type="button"
        onClick={onSave}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-sm text-gray-200 transition hover:bg-white/5"
      >
        保存
      </button>
      <button
        type="button"
        onClick={onExport}
        disabled={exporting}
        className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-brand-500 disabled:opacity-50"
      >
        {exporting ? "导出中…" : "导出"}
      </button>
    </div>
  );
}
