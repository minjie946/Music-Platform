import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { downloadLora, fetchLoras } from "../api";
import type { LoraItem } from "../types";

interface LoraSelectProps {
  value: string;                 // selected LoRA id ("" = none / base model)
  onChange: (id: string) => void;
  disabled?: boolean;
}

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 8;

interface MenuPosition {
  left: number;
  width: number;
  top: number;
  maxHeight: number;
}

const CATEGORY_ORDER = ["pop", "instrumental"];

/**
 * Music-generation LoRA picker. Lists catalog adapters grouped by category;
 * undownloaded items expose a download button (with live progress), downloaded
 * items are directly selectable. Incompatible adapters (wrong DiT base) are
 * shown disabled. The menu is portaled and flips up/down to fit the viewport.
 */
export function LoraSelect({ value, onChange, disabled }: LoraSelectProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const { data } = useQuery({
    queryKey: ["gen-loras"],
    queryFn: fetchLoras,
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((i) => i.download_status === "downloading") ? 1500 : 0;
    },
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  const download = useMutation({
    mutationFn: (id: string) => downloadLora(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["gen-loras"] }),
  });

  const selected = useMemo(() => items.find((i) => i.id === value), [items, value]);

  const grouped = useMemo(() => {
    const byCat = new Map<string, LoraItem[]>();
    for (const it of items) {
      const list = byCat.get(it.category) ?? [];
      list.push(it);
      byCat.set(it.category, list);
    }
    const cats = [...byCat.keys()].sort(
      (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
    );
    return cats.map((cat) => ({
      cat,
      label: byCat.get(cat)?.[0]?.category_label || cat,
      list: byCat.get(cat) ?? [],
    }));
  }, [items]);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const measured = menuRef.current?.scrollHeight ?? 0;
    const content = Math.min(measured || MENU_MAX_HEIGHT, MENU_MAX_HEIGHT);
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const dropDown = spaceBelow >= content || spaceBelow >= spaceAbove;
    const maxHeight = Math.max(140, Math.min(content, dropDown ? spaceBelow : spaceAbove));
    setPos({
      left: rect.left,
      width: rect.width,
      top: dropDown ? rect.bottom + MENU_GAP : rect.top - MENU_GAP - maxHeight,
      maxHeight,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    computePosition();
    const handle = () => computePosition();
    window.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
    };
  }, [open, computePosition, items]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const pickable = (it: LoraItem) => it.downloaded && it.compatible;

  const commit = (it: LoraItem) => {
    if (!pickable(it)) return;
    onChange(it.id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const triggerLabel = selected ? selected.name : "不使用 LoRA（基础模型）";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label="音乐 LoRA"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex w-full items-center justify-between gap-2 rounded-lg border border-gray-700 bg-gray-900 px-2 py-2 text-left text-sm",
          selected ? "text-gray-100" : "text-gray-400",
          "focus:outline-none focus:ring-2 focus:ring-brand-600/60 disabled:opacity-50",
        ].join(" ")}
      >
        <span className="truncate">{triggerLabel}</span>
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          className={["h-4 w-4 shrink-0 text-gray-400 transition-transform", open ? "rotate-180" : ""].join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 8l4 4 4-4" />
        </svg>
      </button>

      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              role="listbox"
              style={{
                position: "fixed",
                left: pos ? pos.left : -9999,
                top: pos ? pos.top : 0,
                width: pos?.width,
                maxHeight: pos ? pos.maxHeight : MENU_MAX_HEIGHT,
                visibility: pos ? "visible" : "hidden",
              }}
              className="z-[95] overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 py-1 shadow-2xl shadow-black/50"
            >
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className={[
                  "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm",
                  !value ? "bg-brand-600 text-white" : "text-gray-200 hover:bg-gray-800",
                ].join(" ")}
              >
                <span>不使用 LoRA（基础模型）</span>
                {!value ? <Check /> : null}
              </button>

              {grouped.map(({ cat, label, list }) => (
                <div key={cat}>
                  <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                    {label}
                  </div>
                  {list.map((it) => {
                    const isSelected = it.id === value;
                    const canPick = pickable(it);
                    return (
                      <div
                        key={it.id}
                        role="option"
                        aria-selected={isSelected}
                        title={!it.compatible ? "与当前 DiT 基座不匹配" : it.description}
                        onClick={() => commit(it)}
                        className={[
                          "flex items-center justify-between gap-2 px-3 py-1.5 text-sm",
                          isSelected
                            ? "bg-brand-600 text-white"
                            : canPick
                              ? "cursor-pointer text-gray-200 hover:bg-gray-800"
                              : "text-gray-500",
                        ].join(" ")}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {it.name}
                          {!it.compatible ? <span className="ml-1 text-[11px] text-amber-400">· 基座不匹配</span> : null}
                        </span>
                        {isSelected ? (
                          <Check />
                        ) : it.downloaded ? null : (
                          <DownloadControl
                            item={it}
                            onDownload={(e) => {
                              e.stopPropagation();
                              download.mutate(it.id);
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              {items.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-500">暂无可用 LoRA</div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l3 3 7-7" />
    </svg>
  );
}

function DownloadControl({
  item,
  onDownload,
}: {
  item: LoraItem;
  onDownload: (e: React.MouseEvent) => void;
}) {
  if (item.download_status === "downloading") {
    const pct =
      item.download_total > 0
        ? Math.round((item.download_loaded / item.download_total) * 100)
        : null;
    return (
      <span className="shrink-0 text-[11px] text-brand-300">
        下载中{pct != null ? ` ${pct}%` : "…"}
      </span>
    );
  }
  if (item.download_status === "failed") {
    return (
      <button
        type="button"
        onClick={onDownload}
        title={item.download_error || "下载失败，点击重试"}
        className="shrink-0 rounded-md border border-red-700/60 px-2 py-0.5 text-[11px] text-red-300 hover:border-red-500"
      >
        重试
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onDownload}
      className="shrink-0 rounded-md border border-gray-600 px-2 py-0.5 text-[11px] text-gray-300 hover:border-brand-500 hover:text-white"
    >
      下载
    </button>
  );
}
