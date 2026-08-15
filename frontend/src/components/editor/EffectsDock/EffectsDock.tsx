import { Knob } from "../components/Knob";
import { Select } from "../../Select";
import type { DockEffects } from "../../../types";

export type { DockEffects };

export function defaultDockEffects(): DockEffects {
  return {
    vocalFx: { enabled: true, preset: "harmony", intensity: 100 },
    autotune: { enabled: true, key: "C 大调", responseMs: 44, naturalness: 6 },
    reverb: { enabled: false, distance: "near", amount: 0 },
  };
}

interface Props {
  trackLabel: string;
  effects: DockEffects;
  onChange: (patch: Partial<DockEffects>) => void;
}

const VOCAL_PRESETS = [
  { value: "harmony", label: "一键叠声" },
  { value: "double", label: "双声道加倍" },
  { value: "wide", label: "宽立体声" },
];
const AUTOTUNE_KEYS = ["C 大调", "G 大调", "D 大调", "A 小调", "E 小调", "B 小调"];
const REVERB_DISTANCE = [
  { value: "near", label: "近距离" },
  { value: "mid", label: "中距离" },
  { value: "far", label: "远距离" },
];

const cardCls =
  "flex-1 min-w-[280px] rounded-2xl border border-white/5 bg-[#111116] p-5";
const headCls = "flex items-center justify-between";
const titleCls = "text-sm font-semibold text-gray-100";
const subCls = "mt-1 text-xs text-gray-500";

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "relative h-5 w-9 rounded-full transition",
        on ? "bg-brand-600" : "bg-white/15",
      ].join(" ")}
      aria-pressed={on}
    >
      <span
        className={[
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition",
          on ? "left-[18px]" : "left-0.5",
        ].join(" ")}
      />
    </button>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  leftLabel,
  rightLabel,
  valueLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  leftLabel: string;
  rightLabel: string;
  valueLabel: string;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex justify-between text-xs text-gray-400">
        <span>{leftLabel}</span>
        <span className="tabular-nums text-gray-300">{valueLabel}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-500"
      />
      <div className="mt-1 flex justify-between text-[11px] text-gray-600">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}

/** 底部常驻轨道效果面板：人声效果器（一键叠声）/ Autotune / 混响。 */
export function EffectsDock({ trackLabel, effects, onChange }: Props) {
  const { vocalFx, autotune, reverb } = effects;

  return (
    <div className="shrink-0 border-t border-white/5">
      <div className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-300">
        <span className="text-gray-500">▏</span>
        <span className="font-medium text-gray-100">{trackLabel || "未选择音轨"}</span>
        <span className="ml-2 rounded border border-white/10 px-2 py-0.5 text-xs text-gray-400">
          轨道效果
        </span>
      </div>

      <div className="flex flex-wrap gap-4 px-4 pb-4">
        {/* 人声效果器 */}
        <div className={cardCls}>
          <div className={headCls}>
            <div>
              <h4 className={titleCls}>人声效果器</h4>
              <p className={subCls}>只适用于纯人声音频通道</p>
            </div>
            <Toggle
              on={vocalFx.enabled}
              onClick={() => onChange({ vocalFx: { ...vocalFx, enabled: !vocalFx.enabled } })}
            />
          </div>
          <div className="mt-4">
            <Select
              value={vocalFx.preset}
              onChange={(v) => onChange({ vocalFx: { ...vocalFx, preset: v } })}
              options={VOCAL_PRESETS}
              ariaLabel="人声预设"
            />
          </div>
          <div className="mt-4 flex justify-center">
            <Knob
              value={vocalFx.intensity}
              min={0}
              max={100}
              onChange={(v) => onChange({ vocalFx: { ...vocalFx, intensity: Math.round(v) } })}
              label="强度"
              format={(v) => `${Math.round(v)}%`}
              disabled={!vocalFx.enabled}
            />
          </div>
        </div>

        {/* Autotune */}
        <div className={cardCls}>
          <div className={headCls}>
            <div>
              <h4 className={titleCls}>Autotune</h4>
              <p className={subCls}>修正音高或创造电音效果</p>
            </div>
            <Toggle
              on={autotune.enabled}
              onClick={() => onChange({ autotune: { ...autotune, enabled: !autotune.enabled } })}
            />
          </div>
          <div className="mt-4">
            <Select
              value={autotune.key}
              onChange={(v) => onChange({ autotune: { ...autotune, key: v } })}
              options={AUTOTUNE_KEYS.map((k) => ({ value: k, label: k }))}
              ariaLabel="Autotune 调性"
            />
          </div>
          <Slider
            value={autotune.responseMs}
            min={0}
            max={200}
            step={1}
            onChange={(v) => onChange({ autotune: { ...autotune, responseMs: v } })}
            leftLabel="电音"
            rightLabel="柔和"
            valueLabel={`${autotune.responseMs}ms`}
          />
          <Slider
            value={autotune.naturalness}
            min={0}
            max={100}
            step={1}
            onChange={(v) => onChange({ autotune: { ...autotune, naturalness: v } })}
            leftLabel="机械"
            rightLabel="自然"
            valueLabel={`${autotune.naturalness}%`}
          />
        </div>

        {/* 混响 */}
        <div className={cardCls}>
          <div className={headCls}>
            <div>
              <h4 className={titleCls}>混响</h4>
              <p className={subCls}>调节声音的空间氛围</p>
            </div>
            <Toggle
              on={reverb.enabled}
              onClick={() => onChange({ reverb: { ...reverb, enabled: !reverb.enabled } })}
            />
          </div>
          <div className="mt-4">
            <Select
              value={reverb.distance}
              onChange={(v) => onChange({ reverb: { ...reverb, distance: v } })}
              options={REVERB_DISTANCE}
              ariaLabel="混响距离"
            />
          </div>
          <div className="mt-4 flex justify-center">
            <Knob
              value={reverb.amount}
              min={0}
              max={100}
              onChange={(v) => onChange({ reverb: { ...reverb, amount: Math.round(v) } })}
              label="强度"
              format={(v) => `${Math.round(v)}%`}
              disabled={!reverb.enabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
