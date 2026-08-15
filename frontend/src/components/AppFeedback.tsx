import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type ConfirmTone = "danger" | "default";
type ToastTone = "success" | "error" | "info";

interface ConfirmOptions {
    title: string;
    description?: ReactNode;
    confirmText?: string;
    cancelText?: string;
    tone?: ConfirmTone;
}

interface ConfirmState extends Required<Omit<ConfirmOptions, "description">> {
    description?: ReactNode;
}

interface ToastState {
    message: string;
    tone: ToastTone;
}

export function useConfirmModal() {
    const [state, setState] = useState<ConfirmState | null>(null);
    const resolverRef = useRef<((value: boolean) => void) | null>(null);

    const close = useCallback((value: boolean) => {
        resolverRef.current?.(value);
        resolverRef.current = null;
        setState(null);
    }, []);

    const confirm = useCallback((options: ConfirmOptions) => {
        return new Promise<boolean>((resolve) => {
            resolverRef.current?.(false);
            resolverRef.current = resolve;
            setState({
                title: options.title,
                description: options.description,
                confirmText: options.confirmText ?? "确定",
                cancelText: options.cancelText ?? "取消",
                tone: options.tone ?? "default",
            });
        });
    }, []);

    const node = state ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center px-4">
            <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={() => close(false)} />
            <div className="relative w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900 shadow-2xl shadow-black/50">
                <div className="border-b border-gray-800 px-5 py-4">
                    <div className="flex items-center gap-3">
                        <div
                            className={[
                                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-lg",
                                state.tone === "danger"
                                    ? "border-red-500/40 bg-red-500/10 text-red-300"
                                    : "border-brand-500/40 bg-brand-500/10 text-brand-300",
                            ].join(" ")}
                        >
                            {state.tone === "danger" ? "!" : "i"}
                        </div>
                        <div className="min-w-0">
                            <h3 className="truncate text-base font-semibold text-gray-100">{state.title}</h3>
                            {state.description && <div className="mt-1 text-sm leading-5 text-gray-400">{state.description}</div>}
                        </div>
                    </div>
                </div>
                <div className="flex justify-end gap-2 px-5 py-4">
                    <button
                        type="button"
                        onClick={() => close(false)}
                        className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition hover:border-gray-500 hover:text-gray-100"
                    >
                        {state.cancelText}
                    </button>
                    <button
                        type="button"
                        onClick={() => close(true)}
                        className={[
                            "rounded-lg px-3 py-1.5 text-sm font-medium text-white transition",
                            state.tone === "danger" ? "bg-red-600 hover:bg-red-500" : "bg-brand-600 hover:bg-brand-500",
                        ].join(" ")}
                    >
                        {state.confirmText}
                    </button>
                </div>
            </div>
        </div>
    ) : null;

    return { confirm, confirmNode: node };
}

export function useToast() {
    const [toast, setToast] = useState<ToastState | null>(null);

    const showToast = useCallback((message: string, tone: ToastTone = "info") => {
        setToast({ message, tone });
    }, []);

    useEffect(() => {
        if (!toast) return;
        const id = window.setTimeout(() => setToast(null), 2200);
        return () => window.clearTimeout(id);
    }, [toast]);

    const node = toast ? (
        <div className="fixed right-5 top-5 z-[90]">
            <div
                className={[
                    "rounded-xl border px-4 py-3 text-sm shadow-2xl shadow-black/40 backdrop-blur",
                    toast.tone === "success"
                        ? "border-emerald-500/30 bg-emerald-950/90 text-emerald-100"
                        : toast.tone === "error"
                            ? "border-red-500/30 bg-red-950/90 text-red-100"
                            : "border-gray-700 bg-gray-900/90 text-gray-100",
                ].join(" ")}
            >
                {toast.message}
            </div>
        </div>
    ) : null;

    return { showToast, toastNode: node };
}
