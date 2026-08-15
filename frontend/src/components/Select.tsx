import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
    value: string;
    label: ReactNode;
    disabled?: boolean;
}

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    disabled?: boolean;
    placeholder?: string;
    className?: string;
    /** aria-label when there is no associated visible <label>. */
    ariaLabel?: string;
}

const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 320;
const VIEWPORT_MARGIN = 8;

interface MenuPosition {
    left: number;
    width: number;
    top: number;
    maxHeight: number;
    placement: "top" | "bottom";
}

/**
 * Custom select whose menu is portaled to <body> and anchored flush to the
 * trigger's top or bottom edge. Direction is chosen from the space available in
 * the viewport: it drops down when there is room, otherwise flips up.
 */
export function Select({
    value,
    onChange,
    options,
    disabled,
    placeholder = "— 请选择 —",
    className = "",
    ariaLabel,
}: SelectProps) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<MenuPosition | null>(null);
    const [activeIndex, setActiveIndex] = useState(-1);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLUListElement>(null);
    const listboxId = useId();

    const selected = useMemo(
        () => options.find((o) => o.value === value),
        [options, value],
    );

    const computePosition = useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        const measured = menuRef.current?.scrollHeight ?? 0;
        const content = Math.min(measured || MENU_MAX_HEIGHT, MENU_MAX_HEIGHT);

        const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
        const spaceAbove = rect.top - VIEWPORT_MARGIN;

        // Drop down when it fits below, or when there is at least as much room
        // below as above; otherwise flip up.
        const dropDown = spaceBelow >= content || spaceBelow >= spaceAbove;
        const maxHeight = Math.max(
            120,
            Math.min(content, dropDown ? spaceBelow : spaceAbove),
        );

        setPos({
            left: rect.left,
            width: rect.width,
            // Anchor flush to the trigger edge: top edge below, bottom edge above.
            top: dropDown ? rect.bottom + MENU_GAP : rect.top - MENU_GAP - maxHeight,
            maxHeight,
            placement: dropDown ? "bottom" : "top",
        });
    }, []);

    // Reset stale position each time we open so the invisible first paint does
    // not flash at the previous location.
    useLayoutEffect(() => {
        if (!open) setPos(null);
    }, [open]);

    // Measure after the menu mounts, and keep it aligned on scroll/resize.
    useLayoutEffect(() => {
        if (!open) return;
        computePosition();
        const handle = () => computePosition();
        window.addEventListener("scroll", handle, true);
        window.addEventListener("resize", handle);
        return () => {
            window.removeEventListener("scroll", handle, true);
            window.removeEventListener("resize", handle);
        };
    }, [open, computePosition]);

    // Close on outside interaction.
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

    const openMenu = useCallback(() => {
        if (disabled) return;
        const current = options.findIndex((o) => o.value === value);
        setActiveIndex(current);
        setOpen(true);
    }, [disabled, options, value]);

    const commit = useCallback(
        (opt: SelectOption) => {
            if (opt.disabled) return;
            onChange(opt.value);
            setOpen(false);
            triggerRef.current?.focus();
        },
        [onChange],
    );

    const moveActive = useCallback(
        (dir: 1 | -1) => {
            setActiveIndex((prev) => {
                const n = options.length;
                if (n === 0) return -1;
                let next = prev;
                for (let i = 0; i < n; i += 1) {
                    next = (next + dir + n) % n;
                    if (!options[next]?.disabled) return next;
                }
                return prev;
            });
        },
        [options],
    );

    const onTriggerKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (disabled) return;
            if (!open) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openMenu();
                }
                return;
            }
            if (e.key === "ArrowDown") {
                e.preventDefault();
                moveActive(1);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                moveActive(-1);
            } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                const opt = options[activeIndex];
                if (opt) commit(opt);
            } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
            } else if (e.key === "Tab") {
                setOpen(false);
            }
        },
        [disabled, open, openMenu, moveActive, options, activeIndex, commit],
    );

    // Keep the active option scrolled into view.
    useEffect(() => {
        if (!open || activeIndex < 0) return;
        const el = menuRef.current?.children[activeIndex] as HTMLElement | undefined;
        el?.scrollIntoView({ block: "nearest" });
    }, [open, activeIndex]);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listboxId : undefined}
                aria-label={ariaLabel}
                disabled={disabled}
                onClick={() => (open ? setOpen(false) : openMenu())}
                onKeyDown={onTriggerKeyDown}
                className={[
                    "flex w-full items-center justify-between gap-2 rounded-lg border border-gray-700 bg-gray-900 px-2 py-2 text-left text-sm text-gray-100",
                    "focus:outline-none focus:ring-2 focus:ring-brand-600/60 disabled:opacity-50",
                    className,
                ].join(" ")}
            >
                <span className={["truncate", selected ? "" : "text-gray-500"].join(" ")}>
                    {selected ? selected.label : placeholder}
                </span>
                <svg
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                    className={[
                        "h-4 w-4 shrink-0 text-gray-400 transition-transform",
                        open ? "rotate-180" : "",
                    ].join(" ")}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 8l4 4 4-4" />
                </svg>
            </button>

            {open
                ? createPortal(
                    <ul
                        ref={menuRef}
                        id={listboxId}
                        role="listbox"
                        tabIndex={-1}
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
                        {options.map((o, i) => {
                            const isSelected = o.value === value;
                            const isActive = i === activeIndex;
                            return (
                                <li
                                    key={o.value || `opt-${i}`}
                                    role="option"
                                    aria-selected={isSelected}
                                    aria-disabled={o.disabled || undefined}
                                    onMouseEnter={() => !o.disabled && setActiveIndex(i)}
                                    onClick={() => commit(o)}
                                    className={[
                                        "flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm",
                                        o.disabled
                                            ? "cursor-not-allowed text-gray-600"
                                            : isSelected
                                                ? "bg-brand-600 text-white"
                                                : isActive
                                                    ? "bg-gray-800 text-gray-100"
                                                    : "text-gray-200",
                                    ].join(" ")}
                                >
                                    <span className="truncate">{o.label}</span>
                                    {isSelected ? (
                                        <svg
                                            viewBox="0 0 20 20"
                                            aria-hidden="true"
                                            className="h-4 w-4 shrink-0"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth={2}
                                        >
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l3 3 7-7" />
                                        </svg>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>,
                    document.body,
                )
                : null}
        </>
    );
}
