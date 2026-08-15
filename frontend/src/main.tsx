import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import {
  fetchDesktopBootProgress,
  initializeApiBaseUrl,
  listenDesktopBootProgress,
  type DesktopBootProgress,
} from "./api";
import appIcon from "../src-tauri/icons/icon.png";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const BOOT_STEPS = [
  { at: 8, label: "初始化桌面窗口" },
  { at: 24, label: "准备内置 Python runtime" },
  { at: 42, label: "启动本地后端服务" },
  { at: 62, label: "等待 API 就绪" },
  { at: 82, label: "加载音乐工作台界面" },
];

function BootScreen({ ready, boot }: { ready: boolean; boot: DesktopBootProgress }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 700);
    return () => window.clearInterval(id);
  }, []);

  const progress = ready ? 100 : Math.max(0, Math.min(99, boot.progress ?? 0));

  const step = useMemo(
    () =>
      [...BOOT_STEPS]
        .reverse()
        .find((item) => progress >= item.at) ?? BOOT_STEPS[0],
    [progress],
  );

  return (
    <div className="h-full min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-6">
      <div className="w-full max-w-xl rounded-3xl border border-gray-800 bg-gray-900/70 px-8 py-10 shadow-2xl shadow-black/40">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="relative mb-5 h-20 w-20">
            <div className="absolute inset-0 rounded-full border-4 border-gray-800" />
            <div className="absolute inset-0 rounded-full border-4 border-brand-500 border-r-transparent animate-spin" />
            <div className="absolute inset-3 rounded-full bg-gray-950 flex items-center justify-center overflow-hidden">
              <img src={appIcon} alt="" className="h-full w-full object-cover" />
            </div>
          </div>
          <h1 className="bg-brand-logo bg-clip-text text-xl font-semibold text-transparent">音乐工作台正在启动</h1>
          <p className="mt-2 text-sm text-gray-400">
            {boot.detail || "正在启动桌面后端和本地服务，首次启动可能需要更久。"}
          </p>
        </div>

        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-gray-300">{ready ? "启动完成" : boot.stage || step.label}</span>
          <span className="font-mono text-gray-400">{Math.round(progress)}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-gray-800">
          <div
            className="h-full rounded-full bg-brand-500 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-2 text-xs text-gray-500 sm:grid-cols-2">
          {BOOT_STEPS.map((item) => {
            const done = progress >= item.at;
            return (
              <div key={item.label} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2">
                <span className={done ? "text-brand-400" : "text-gray-700"}>
                  {done ? "●" : "○"}
                </span>
                <span className={done ? "text-gray-300" : ""}>{item.label}</span>
              </div>
            );
          })}
        </div>

        <p className="mt-5 text-center text-xs text-gray-600">
          已等待 {elapsed}s。若长时间停留，请查看桌面应用日志。
        </p>
      </div>
    </div>
  );
}

function Root() {
  const [ready, setReady] = useState(false);
  const [boot, setBoot] = useState<DesktopBootProgress>({
    progress: 0,
    stage: "初始化桌面窗口",
    detail: "正在创建应用窗口",
  });

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    fetchDesktopBootProgress().then((snapshot) => {
      if (!cancelled && snapshot) setBoot(snapshot);
    });
    listenDesktopBootProgress((payload) => {
      if (!cancelled) setBoot(payload);
    }).then((fn) => {
      unlisten = fn;
    });
    initializeApiBaseUrl().finally(() => {
      if (!cancelled) {
        setBoot({ progress: 100, stage: "启动完成", detail: "本地服务已就绪" });
        window.setTimeout(() => {
          if (!cancelled) setReady(true);
        }, 180);
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!ready) return <BootScreen ready={ready} boot={boot} />;
  return (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
