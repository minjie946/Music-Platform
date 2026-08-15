import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchCapabilities, fetchSettings, isDesktopRuntime } from "./api";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import type { EditorTrack } from "./components/EditorPanel";
import { DownloadCenterButton, DownloadCenterProvider } from "./components/DownloadCenter";
import { ResourceUsageBadge } from "./components/ResourceUsageBadge";
import { useJob } from "./hooks/useJob";
import type { JobStatus } from "./types";
import appIcon from "../src-tauri/icons/icon.png";
import questionCircleIcon from "./assets/question-circle.svg";
import settingIcon from "./assets/setting.svg";

// 按需懒加载各面板：默认停在「音乐生成」tab，编辑器（Tone.js/wavesurfer 体积大）
// 等进入对应 tab 时再加载，缩短首屏 JS。
const GeneratePanel = lazy(() =>
  import("./components/GeneratePanel").then((m) => ({ default: m.GeneratePanel })),
);
const SvcPanel = lazy(() =>
  import("./components/SvcPanel").then((m) => ({ default: m.SvcPanel })),
);
const EditorPanel = lazy(() =>
  import("./components/EditorPanel").then((m) => ({ default: m.EditorPanel })),
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((m) => ({ default: m.SettingsModal })),
);
const UserManualDrawer = lazy(() =>
  import("./components/UserManualDrawer").then((m) => ({ default: m.UserManualDrawer })),
);

const PanelFallback = () => (
  <div className="flex h-full items-center justify-center text-gray-500 text-sm">
    加载中…
  </div>
);

type Tab = "generate" | "separate" | "svc" | "edit";

export default function App() {
  const [tab, setTab] = useState<Tab>("generate");
  const [engine, setEngine] = useState("demucs");
  const [outputFormat, setOutputFormat] = useState("wav");
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [separateLeftCollapsed, setSeparateLeftCollapsed] = useState(false);
  const [editTracks, setEditTracks] = useState<EditorTrack[]>([]);
  const { job, starting, error, start, adopt } = useJob();
  const desktop = isDesktopRuntime();

  // Initialise engine from saved default settings once.
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
  });
  useEffect(() => {
    if (settings?.default_engine) setEngine(settings.default_engine);
  }, [settings?.default_engine]);

  const {
    data: capabilities,
    refetch: refetchCaps,
    isError: capsError,
  } = useQuery({
    queryKey: ["capabilities", engine],
    queryFn: () => fetchCapabilities(engine),
    // Keep polling until the backend is reachable, then stop.
    retry: true,
    refetchInterval: (q) => (q.state.data ? false : 4000),
  });

  // Default-select all supported stems whenever the capability set changes.
  useEffect(() => {
    if (!capabilities) return;
    setSelected(new Set(capabilities.stems.filter((s) => s.supported).map((s) => s.id)));
  }, [capabilities]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const selectAll = () =>
    setSelected(
      new Set((capabilities?.stems ?? []).filter((s) => s.supported).map((s) => s.id)),
    );
  const clear = () => setSelected(new Set());

  const canSubmit = useMemo(
    () => !!file && selected.size > 0,
    [file, selected],
  );

  const handleSubmit = () => {
    if (!file) return;
    start(file, Array.from(selected), engine, outputFormat);
  };

  const handleSeparateFromGen = (sepJob: JobStatus) => {
    adopt(sepJob);
    setTab("separate");
  };

  const handleEdit = (tracks: EditorTrack[]) => {
    if (tracks.length === 0) return;
    setEditTracks(tracks);
    setTab("edit");
  };

  const tabBtn = (id: Tab, label: string) => (
    <button
      onClick={() => setTab(id)}
      className={[
        "rounded-full px-4 py-1.5 text-sm font-medium transition",
        tab === id
          ? "bg-brand-600 text-white"
          : "text-gray-400 hover:text-gray-200",
      ].join(" ")}
    >
      {label}
    </button>
  );

  return (
    <DownloadCenterProvider>
      <div className="h-full flex flex-col">
        <header className="flex items-center justify-between h-[60px] px-4 border-b border-white/5 bg-[#0B0B0F] shrink-0">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <img src={appIcon} alt="" className="h-7 w-7 rounded-md" />
              <h1 className="bg-brand-logo bg-clip-text text-lg font-semibold text-transparent">Music Studio</h1>
            </div>
            <div className="flex items-center gap-2">
              {tabBtn("generate", "音乐生成")}
              {tabBtn("separate", "音轨分离")}
              {tabBtn("svc", "SVC 音源")}
              {tabBtn("edit", "音乐编辑")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {desktop && <ResourceUsageBadge />}
            {desktop && <DownloadCenterButton />}
            <button
              onClick={() => setManualOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5"
              title="查看使用手册"
            >
              <img src={questionCircleIcon} alt="" className="h-4 w-4 opacity-70" />
              手册
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5"
            >
              <img src={settingIcon} alt="" className="h-4 w-4 opacity-70" />
              设置
            </button>
          </div>
        </header>

        {tab === "separate" && error && (
          <div className="mx-6 mt-4 rounded-lg border border-red-700 bg-red-900/30 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {tab === "separate" && !capabilities ? (
          <main className="flex-1 min-h-0 flex items-center justify-center p-6">
            <div className="flex flex-col items-center text-center">
              <div className="h-12 w-12 rounded-full border-4 border-gray-700 border-t-brand-500 animate-spin" />
              <p className="mt-4 text-sm text-gray-300">
                {capsError ? "正在连接分轨服务…" : "服务启动中，正在加载…"}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                首次启动会下载依赖，请稍候，就绪后将自动进入。
              </p>
            </div>
          </main>
        ) : tab === "separate" ? (
          <main className="relative flex-1 min-h-0 overflow-hidden border-t border-gray-800 lg:flex">
            <div
              className={[
                "min-h-0 shrink-0 overflow-hidden border-r border-gray-800 bg-gray-950/30 transition-[width] duration-300",
                separateLeftCollapsed ? "w-0 border-r-0" : "w-full lg:w-[380px]",
              ].join(" ")}
            >
              <div className="h-full overflow-y-auto p-5">
                <LeftPanel
                  file={file}
                  onFile={setFile}
                  engine={engine}
                  onEngineChange={setEngine}
                  outputFormat={outputFormat}
                  onOutputFormatChange={setOutputFormat}
                  capabilities={capabilities}
                  selected={selected}
                  onToggle={toggle}
                  onSelectAll={selectAll}
                  onClear={clear}
                  onSubmit={handleSubmit}
                  submitting={starting || job?.state === "queued" || job?.state === "running"}
                  canSubmit={canSubmit}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSeparateLeftCollapsed((v) => !v)}
              className={[
                "absolute top-1/2 z-20 hidden h-12 w-7 -translate-y-1/2 items-center justify-center border border-gray-700 bg-gray-900 text-gray-400 shadow-lg shadow-black/40 transition hover:border-brand-500 hover:text-white lg:flex",
                separateLeftCollapsed
                  ? "left-0 rounded-r-lg border-l-0"
                  : "left-[380px] -translate-x-full rounded-l-lg border-r-0",
              ].join(" ")}
              title={separateLeftCollapsed ? "展开分轨参数" : "收起分轨参数"}
            >
              {separateLeftCollapsed ? "›" : "‹"}
            </button>
            <div className="min-w-0 flex-1 px-5 pb-5 pt-3">
              <div className="h-full overflow-hidden flex flex-col">
                <RightPanel job={job} onEdit={handleEdit} />
              </div>
            </div>
          </main>
        ) : tab === "generate" ? (
          <Suspense fallback={<PanelFallback />}>
            <GeneratePanel
              onSeparate={handleSeparateFromGen}
              onGoToSvc={() => setTab("svc")}
              onEdit={handleEdit}
            />
          </Suspense>
        ) : tab === "svc" ? (
          <Suspense fallback={<PanelFallback />}>
            <SvcPanel />
          </Suspense>
        ) : (
          <Suspense fallback={<PanelFallback />}>
            <EditorPanel initialTracks={editTracks} onGoToGenerate={() => setTab("generate")} />
          </Suspense>
        )}

        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsModal
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              onSaved={() => refetchCaps()}
            />
          </Suspense>
        )}
        {manualOpen && (
          <Suspense fallback={null}>
            <UserManualDrawer
              open={manualOpen}
              onClose={() => setManualOpen(false)}
            />
          </Suspense>
        )}
      </div>
    </DownloadCenterProvider>
  );
}
