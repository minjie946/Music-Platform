import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClipEffects } from "../types";

export function defaultEffects(): ClipEffects {
  return {
    eq_enabled: false,
    eq_low_db: 0,
    eq_mid_db: 0,
    eq_high_db: 0,
    reverb_enabled: false,
    reverb_amount: 0.3,
    comp_enabled: false,
    comp_amount: 0.5,
    delay_enabled: false,
    delay_ms: 250,
    delay_feedback: 0.3,
  };
}

/** True if any effect in the chain is enabled. */
export function hasActiveEffects(fx: ClipEffects | undefined): boolean {
  if (!fx) return false;
  return fx.eq_enabled || fx.reverb_enabled || fx.comp_enabled || fx.delay_enabled;
}

interface Props {
  anchorRect: DOMRect | null;
  effects: ClipEffects;
  onChange: (patch: Partial<ClipEffects>) => void;
  onClose: () => void;
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded px-2 py-0.5 text-[11px] font-medium transition",
        on ? "bg-brand-600 text-white" : "border border-white/10 text-gray-400 hover:bg-white/5",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className={["flex flex-col gap-0.5", disabled ? "opacity-40" : ""].join(" ")}>
      <span className="flex justify-between text-[10px] text-gray-400">
        <span>{label}</span>
        <span className="tabular-nums text-gray-500">
          {value}
          {suffix || ""}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 accent-brand-500"
      />
    </label>
  );
}

export function EffectsPanel({ anchorRect, effects, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!anchorRect) return;
    const W = 260;
    const margin = 8;
    let left = anchorRect.left;
    left = Math.min(left, window.innerWidth - W - margin);
    left = Math.max(margin, left);
    // Prefer below the anchor; flip above if not enough room.
    const belowTop = anchorRect.bottom + 4;
    const needed = 340;
    const top =
      window.innerHeight - belowTop < needed ? Math.max(margin, anchorRect.top - needed - 4) : belowTop;
    setPos({ top, left });
  }, [anchorRect]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[80] w-[260px] rounded-xl border border-white/10 bg-[#111116] p-3 shadow-2xl shadow-black/60"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-100">效果器</span>
        <span className="text-[10px] text-gray-500">导出时生效</span>
      </div>

      {/* EQ */}
      <div className="mb-3 rounded-lg border border-white/5 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] text-gray-300">均衡 EQ</span>
          <Toggle on={effects.eq_enabled} label={effects.eq_enabled ? "开" : "关"} onClick={() => onChange({ eq_enabled: !effects.eq_enabled })} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Slider label="低" value={effects.eq_low_db} min={-12} max={12} step={1} suffix="dB" disabled={!effects.eq_enabled} onChange={(v) => onChange({ eq_low_db: v })} />
          <Slider label="中" value={effects.eq_mid_db} min={-12} max={12} step={1} suffix="dB" disabled={!effects.eq_enabled} onChange={(v) => onChange({ eq_mid_db: v })} />
          <Slider label="高" value={effects.eq_high_db} min={-12} max={12} step={1} suffix="dB" disabled={!effects.eq_enabled} onChange={(v) => onChange({ eq_high_db: v })} />
        </div>
      </div>

      {/* Compressor */}
      <div className="mb-3 rounded-lg border border-white/5 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] text-gray-300">压缩 Compressor</span>
          <Toggle on={effects.comp_enabled} label={effects.comp_enabled ? "开" : "关"} onClick={() => onChange({ comp_enabled: !effects.comp_enabled })} />
        </div>
        <Slider label="强度" value={Math.round(effects.comp_amount * 100)} min={0} max={100} step={5} suffix="%" disabled={!effects.comp_enabled} onChange={(v) => onChange({ comp_amount: v / 100 })} />
      </div>

      {/* Reverb */}
      <div className="mb-3 rounded-lg border border-white/5 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] text-gray-300">混响 Reverb</span>
          <Toggle on={effects.reverb_enabled} label={effects.reverb_enabled ? "开" : "关"} onClick={() => onChange({ reverb_enabled: !effects.reverb_enabled })} />
        </div>
        <Slider label="空间量" value={Math.round(effects.reverb_amount * 100)} min={0} max={100} step={5} suffix="%" disabled={!effects.reverb_enabled} onChange={(v) => onChange({ reverb_amount: v / 100 })} />
      </div>

      {/* Delay */}
      <div className="rounded-lg border border-white/5 p-2">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] text-gray-300">延迟 Delay</span>
          <Toggle on={effects.delay_enabled} label={effects.delay_enabled ? "开" : "关"} onClick={() => onChange({ delay_enabled: !effects.delay_enabled })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Slider label="延迟" value={Math.round(effects.delay_ms)} min={50} max={800} step={10} suffix="ms" disabled={!effects.delay_enabled} onChange={(v) => onChange({ delay_ms: v })} />
          <Slider label="回授" value={Math.round(effects.delay_feedback * 100)} min={0} max={90} step={5} suffix="%" disabled={!effects.delay_enabled} onChange={(v) => onChange({ delay_feedback: v / 100 })} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
