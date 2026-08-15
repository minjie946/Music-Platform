import { useCallback, useRef } from "react";

interface KnobProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** 旋钮直径（px）。 */
  size?: number;
  label?: string;
  /** 值格式化为展示文本，例如 (v)=>`${v}%`。 */
  format?: (v: number) => string;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * 圆形旋钮控件：拖动上下调节数值（也支持滚轮）。
 * 视觉对齐目标设计——底部效果面板的强度/距离等参数用它。
 */
export function Knob({
  value,
  min,
  max,
  onChange,
  size = 72,
  label,
  format,
  disabled = false,
  ariaLabel,
}: KnobProps) {
  const dragRef = useRef<{ startY: number; startVal: number } | null>(null);

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, v)),
    [min, max],
  );

  const frac = max > min ? (value - min) / (max - min) : 0;
  // 旋钮指针角度：-135° ~ +135°（共 270° 行程）。
  const angle = -135 + frac * 270;

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = { startY: e.clientY, startVal: value };
    },
    [disabled, value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // 向上拖增大：每 200px 覆盖整个量程。
      const deltaPx = drag.startY - e.clientY;
      const next = clamp(drag.startVal + (deltaPx / 200) * (max - min));
      onChange(next);
    },
    [clamp, max, min, onChange],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (disabled) return;
      const step = (max - min) / 100;
      onChange(clamp(value + (e.deltaY < 0 ? step : -step)));
    },
    [clamp, disabled, max, min, onChange, value],
  );

  const r = size / 2;
  return (
    <div className="flex flex-col items-center gap-2 select-none">
      <div
        role="slider"
        aria-label={ariaLabel || label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        className={[
          "relative rounded-full border border-white/10 bg-[#15151d]",
          disabled ? "opacity-40" : "cursor-ns-resize",
        ].join(" ")}
        style={{ width: size, height: size, touchAction: "none" }}
      >
        {/* 进度弧 */}
        <svg className="absolute inset-0" width={size} height={size}>
          <circle
            cx={r}
            cy={r}
            r={r - 6}
            fill="none"
            stroke="#2a2a36"
            strokeWidth={4}
          />
          <circle
            cx={r}
            cy={r}
            r={r - 6}
            fill="none"
            stroke="#5B54E6"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * (r - 6)}
            strokeDashoffset={2 * Math.PI * (r - 6) * (1 - frac * 0.75)}
            transform={`rotate(135 ${r} ${r})`}
          />
        </svg>
        {/* 指针 */}
        <div
          className="absolute left-1/2 top-1/2 origin-bottom"
          style={{
            width: 2,
            height: r - 10,
            background: "#c9c7f5",
            transform: `translate(-50%, -100%) rotate(${angle}deg)`,
            transformOrigin: "bottom center",
          }}
        />
      </div>
      {format && (
        <span className="text-xs tabular-nums text-gray-300">{format(value)}</span>
      )}
      {label && <span className="text-[11px] text-gray-500">{label}</span>}
    </div>
  );
}
