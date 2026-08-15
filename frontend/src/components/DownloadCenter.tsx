import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { downloadFile, isDesktopRuntime } from "../api";
import downIcon from "../assets/down.svg";

type DownloadStatus = "downloading" | "done" | "failed";

interface DownloadItem {
  id: string;
  filename: string;
  progress: number;
  loaded: number;
  total: number;
  status: DownloadStatus;
  savedPath: string;
  error: string;
}

interface DownloadContextValue {
  startDownload: (url: string, fallbackFilename: string) => Promise<void>;
  activeCount: number;
  doneCount: number;
  desktop: boolean;
  toggleOpen: () => void;
}

interface DesktopDownloadEvent {
  id: string;
  filename?: string | null;
  saved_path?: string | null;
  loaded: number;
  total: number;
  status: DownloadStatus;
  error?: string | null;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

function fmtBytes(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function DownloadCenterProvider({ children }: { children: ReactNode }) {
  const desktop = isDesktopRuntime();
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [open, setOpen] = useState(false);

  const patchItem = useCallback((id: string, patch: Partial<DownloadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<DesktopDownloadEvent>("desktop-download-progress", (event) => {
          if (disposed) return;
          const payload = event.payload;
          setItems((prev) =>
            prev.map((item) => {
              if (item.id !== payload.id) return item;
              return {
                ...item,
                filename: payload.filename || item.filename,
                savedPath: payload.saved_path || item.savedPath,
                loaded: payload.loaded || item.loaded,
                total: payload.total || item.total,
                status: payload.status,
                error: payload.error || "",
                progress:
                  payload.status === "done"
                    ? 100
                    : payload.total
                      ? Math.min(95, Math.round((payload.loaded / payload.total) * 95))
                      : payload.loaded
                        ? 20
                        : item.progress,
              };
            }),
          );
        }),
      )
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  const startDownload = useCallback(
    async (url: string, fallbackFilename: string) => {
      if (!desktop) {
        await downloadFile(url, fallbackFilename);
        return;
      }

      const id = `${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const initial: DownloadItem = {
        id,
        filename: fallbackFilename,
        progress: 0,
        loaded: 0,
        total: 0,
        status: "downloading",
        savedPath: "",
        error: "",
      };
      setItems((prev) => [initial, ...prev].slice(0, 30));
      setOpen(true);

      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("start_desktop_download", { id, url, filename: fallbackFilename });
      } catch (error: any) {
        patchItem(id, {
          status: "failed",
          error: error?.message || "下载失败",
        });
      }
    },
    [desktop, patchItem],
  );

  const activeCount = items.filter((item) => item.status === "downloading").length;
  const doneCount = items.filter((item) => item.status === "done").length;
  const toggleOpen = useCallback(() => setOpen((v) => !v), []);
  const value = useMemo(
    () => ({ startDownload, activeCount, doneCount, desktop, toggleOpen }),
    [activeCount, desktop, doneCount, startDownload, toggleOpen],
  );

  return (
    <DownloadContext.Provider value={value}>
      {children}
      {desktop && (
        <>
          {open && (
            <div className="fixed right-6 top-[76px] z-[70] flex max-h-[520px] w-[420px] max-w-[calc(100vw-24px)] flex-col rounded-2xl border border-gray-800 bg-gray-900 shadow-2xl shadow-black/60">
              <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-gray-100">下载中心</div>
                  <div className="text-xs text-gray-500">桌面端文件会保存到系统下载目录</div>
                </div>
                <div className="flex items-center gap-2">
                  {items.some((item) => item.status !== "downloading") && (
                    <button
                      type="button"
                      onClick={() => setItems((prev) => prev.filter((item) => item.status === "downloading"))}
                      className="rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-gray-100"
                    >
                      清除完成
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-gray-100"
                  >
                    收起
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {items.length === 0 ? (
                  <div className="rounded-xl bg-gray-950/40 px-4 py-8 text-center text-sm text-gray-500">
                    暂无下载任务
                  </div>
                ) : (
                  <div className="space-y-2">
                    {items.map((item) => (
                      <div key={item.id} className="rounded-xl border border-gray-800 bg-gray-950/40 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-gray-100">{item.filename}</div>
                            <div className="mt-1 text-xs text-gray-500">
                              {item.status === "downloading"
                                ? `${fmtBytes(item.loaded)}${item.total ? ` / ${fmtBytes(item.total)}` : ""}`
                                : item.status === "done"
                                  ? "下载完成"
                                  : item.error || "下载失败"}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span
                              className={[
                                "rounded-full px-2 py-0.5 text-[11px]",
                                item.status === "done"
                                  ? "bg-emerald-950/60 text-emerald-300"
                                  : item.status === "failed"
                                    ? "bg-red-950/60 text-red-300"
                                    : "bg-brand-950/60 text-brand-300",
                              ].join(" ")}
                            >
                              {item.status === "done" ? "完成" : item.status === "failed" ? "失败" : `${item.progress}%`}
                            </span>
                            {item.status !== "downloading" && (
                              <button
                                type="button"
                                onClick={() => setItems((prev) => prev.filter((x) => x.id !== item.id))}
                                className="rounded p-1 text-gray-600 hover:bg-gray-800 hover:text-gray-300"
                                title="删除下载记录"
                                aria-label="删除下载记录"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-800">
                          <div
                            className={[
                              "h-full transition-all",
                              item.status === "failed" ? "bg-red-500" : "bg-brand-500",
                            ].join(" ")}
                            style={{ width: `${item.status === "failed" ? 100 : item.progress}%` }}
                          />
                        </div>
                        {item.savedPath && (
                          <button
                            type="button"
                            onClick={() => navigator.clipboard.writeText(item.savedPath).catch(() => undefined)}
                            className="mt-2 max-w-full truncate text-left text-[11px] text-gray-500 hover:text-gray-300"
                            title="点击复制保存路径"
                          >
                            {item.savedPath}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </DownloadContext.Provider>
  );
}

export function useDownloadCenter() {
  const ctx = useContext(DownloadContext);
  if (!ctx) {
    throw new Error("useDownloadCenter must be used within DownloadCenterProvider");
  }
  return ctx;
}

export function DownloadCenterButton() {
  const { activeCount, desktop, doneCount, toggleOpen } = useDownloadCenter();
  if (!desktop) return null;
  return (
    <button
      type="button"
      onClick={toggleOpen}
      title="下载中心"
      className="relative flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition hover:border-gray-500 hover:text-gray-100"
    >
      <img src={downIcon} alt="" className="h-4 w-4 opacity-70" />
      下载
      {(activeCount > 0 || doneCount > 0) && (
        <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-brand-600 px-1 text-center text-[10px] leading-5 text-white">
          {activeCount || doneCount}
        </span>
      )}
    </button>
  );
}
