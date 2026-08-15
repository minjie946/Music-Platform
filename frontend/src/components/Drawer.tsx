import { useEffect, useState, type ReactNode } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Right-aligned header content (before the close button), Antd-style. */
  extra?: ReactNode;
  /** Sticky footer (e.g. action buttons). */
  footer?: ReactNode;
  contentClassName?: string;
  width?: number;
  children: ReactNode;
}

/** A right-side sliding drawer (similar to Antd's Drawer). */
export function Drawer({
  open,
  onClose,
  title,
  extra,
  footer,
  contentClassName,
  width = 480,
  children,
}: DrawerProps) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  // Mount on open, then animate in; animate out before unmounting on close.
  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 300);
    return () => clearTimeout(t);
  }, [open]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        onClick={onClose}
        className={[
          "absolute inset-0 bg-black/60 transition-opacity duration-300",
          shown ? "opacity-100" : "opacity-0",
        ].join(" ")}
      />
      <div
        className={[
          "absolute right-0 top-0 h-full bg-[#1A1A24] border-l border-white/10 shadow-2xl",
          "flex flex-col transition-transform duration-300 ease-out",
          shown ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
        style={{ width: `min(${width}px, 100vw)` }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/5 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-100 truncate">{title}</h2>
          <div className="flex items-center gap-2 shrink-0">
            {extra}
            <button
              onClick={onClose}
              aria-label="关闭"
              className="rounded-lg border border-white/10 w-8 h-8 flex items-center justify-center text-gray-400 hover:bg-white/5 hover:text-gray-200"
            >
              ✕
            </button>
          </div>
        </div>

        <div className={contentClassName ?? "flex-1 min-h-0 overflow-y-auto px-6 py-4"}>
          {children}
        </div>

        {footer && (
          <div className="border-t border-white/5 px-6 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}
