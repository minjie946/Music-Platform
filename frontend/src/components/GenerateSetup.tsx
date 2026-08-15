import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchRuntimeLog,
  fetchSettings,
  runtimeLogEventsUrl,
  saveSettings,
  startGenerationService,
  type InitGuardDetail,
} from "../api";
import { useInitJob } from "../hooks/useInitJob";
import { useConfirmModal } from "./AppFeedback";
import { DirectoryPicker } from "./DirectoryPicker";
import { ProgressBar } from "./ProgressBar";
import { Select } from "./Select";
import type { GenerationCapabilities, GenModelOption } from "../types";

interface Props {
  caps: GenerationCapabilities;
  onReady: () => void;
  /** Banner mode: render only the loader inline (used above the form during load). */
  compact?: boolean;
}

function ModelSelect({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: GenModelOption[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="text-left">
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <Select
        value={value}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={label}
        options={options.map((o) => ({
          value: o.name,
          label: `${o.label || o.name}${o.recommended ? "（推荐）" : ""}`,
        }))}
      />
    </div>
  );
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function inferLogProgress(content: string): { progress: number; stage: string } {
  const text = content.toLowerCase();
  const percentMatches = [...content.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  if (percentMatches.length > 0) {
    const progress = Math.max(...percentMatches);
    return { progress, stage: `检测到日志进度 ${Math.round(progress)}%` };
  }
  if (text.includes("error") || text.includes("失败") || text.includes("failed")) {
    return { progress: 100, stage: "启动失败，请查看日志末尾" };
  }
  if (text.includes("启动 rest api") || text.includes("starting") || text.includes("server")) {
    return { progress: 85, stage: "正在启动 REST API" };
  }
  if (text.includes("加载") || text.includes("load") || text.includes("initialize")) {
    return { progress: 65, stage: "正在加载模型/服务" };
  }
  if (text.includes("下载") || text.includes("download") || text.includes("clone")) {
    return { progress: 35, stage: "正在下载或准备依赖" };
  }
  if (text.includes("安装") || text.includes("install") || text.includes("sync")) {
    return { progress: 25, stage: "正在安装依赖" };
  }
  return { progress: content.trim() ? 15 : 5, stage: content.trim() ? "正在输出启动日志" : "等待日志输出" };
}

function StartupLogViewer({
  active,
  logPath,
  compact = false,
  hideProgress = false,
  onProgress,
}: {
  active: boolean;
  logPath?: string;
  compact?: boolean;
  hideProgress?: boolean;
  onProgress?: (progress: number, stage: string) => void;
}) {
  const [content, setContent] = useState("");
  const [path, setPath] = useState(logPath || "");
  const [exists, setExists] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const boxRef = useRef<HTMLPreElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { progress, stage } = inferLogProgress(content);

  useEffect(() => {
    if (active) onProgress?.(progress, stage);
  }, [active, progress, stage, onProgress]);

  const matchRanges = useMemo(() => {
    const query = searchQuery.trim();
    if (!query) return [] as Array<{ start: number; end: number }>;
    const haystack = content.toLowerCase();
    const needle = query.toLowerCase();
    const matches: Array<{ start: number; end: number }> = [];
    let index = 0;
    while (matches.length < 2000) {
      const found = haystack.indexOf(needle, index);
      if (found === -1) break;
      matches.push({ start: found, end: found + needle.length });
      index = found + needle.length;
    }
    return matches;
  }, [content, searchQuery]);

  useEffect(() => {
    if (logPath) setPath(logPath);
  }, [logPath]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError("");
    fetchRuntimeLog("acestep", 500)
      .then((log) => {
        if (cancelled) return;
        setContent(stripAnsi(log.content || ""));
        setPath(log.path);
        setExists(log.exists);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.response?.data?.detail ?? "读取 ACE-Step 日志失败");
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const es = new EventSource(runtimeLogEventsUrl("acestep"));
    es.addEventListener("append", (ev) => {
      setExists(true);
      setContent((prev) => {
        const next = prev + stripAnsi((ev as MessageEvent).data);
        return next.length > 200_000 ? next.slice(-200_000) : next;
      });
    });
    es.onerror = () => {
      /* Keep the latest snapshot visible; EventSource retries automatically. */
    };
    return () => es.close();
  }, [active]);

  useEffect(() => {
    if (!expanded) return;
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [content, expanded]);

  useEffect(() => {
    if (!active || !expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const findShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
      if (findShortcut) {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
        return;
      }
      if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, expanded, searchOpen]);

  useEffect(() => {
    if (!expanded) return;
    if (!searchOpen || !searchQuery.trim()) return;
    const current = matchRanges[searchIndex] ?? matchRanges[0];
    if (!current) return;
    const el = boxRef.current;
    if (!el) return;
    const approxLine = content.slice(0, current.start).split("\n").length;
    const lineHeight = 18;
    el.scrollTop = Math.max(0, (approxLine - 3) * lineHeight);
  }, [content, expanded, matchRanges, searchIndex, searchOpen, searchQuery]);

  useEffect(() => {
    setSearchIndex(0);
  }, [searchQuery]);

  const highlightedLog = useMemo(() => {
    if (!searchQuery.trim() || matchRanges.length === 0) return content || "等待 ACE-Step 启动日志...";
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    matchRanges.slice(0, 500).forEach((range, index) => {
      if (range.start > cursor) {
        nodes.push(content.slice(cursor, range.start));
      }
      nodes.push(
        <mark
          key={`${range.start}-${range.end}`}
          className={index === searchIndex ? "bg-brand-500/80 text-white" : "bg-amber-400/50 text-white"}
        >
          {content.slice(range.start, range.end)}
        </mark>,
      );
      cursor = range.end;
    });
    if (cursor < content.length) nodes.push(content.slice(cursor));
    return nodes;
  }, [content, matchRanges, searchIndex, searchQuery]);

  const copyPath = async () => {
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mt-5 rounded-xl border border-gray-800 bg-black/40 p-4 text-left">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-200">ACE-Step 启动日志</div>
          <div className="mt-1 text-xs text-gray-500">
            默认收起完整日志，仅展示启动阶段和进度；展开后只读实时查看。
          </div>
          {path && (
            <div className="mt-1 break-all text-[11px] text-gray-600">
              文件：{path}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {expanded && (
            <button
              type="button"
              onClick={() => {
                setSearchOpen(true);
                window.setTimeout(() => searchRef.current?.focus(), 0);
              }}
              className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:border-brand-500 hover:text-white"
              title="搜索日志（Cmd/Ctrl+F）"
            >
              搜索
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:border-brand-500 hover:text-white"
          >
            {expanded ? "收起日志" : "查看日志"}
          </button>
          {path && (
            <button
              type="button"
              onClick={copyPath}
              className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:border-brand-500 hover:text-white"
            >
              {copied ? "已复制" : "复制路径"}
            </button>
          )}
        </div>
      </div>

      {!hideProgress && (
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-xs text-gray-400">
            <span>{stage}</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <ProgressBar value={progress} />
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-lg border border-red-700 bg-red-900/30 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {!exists && !content && !error && (
        <div className="mb-3 rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-2 text-xs text-amber-300">
          日志文件尚未生成，服务开始输出后会自动显示。
        </div>
      )}

      {expanded ? (
        <>
          {searchOpen && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-gray-800 bg-black/40 px-3 py-2">
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matchRanges.length > 0) {
                    e.preventDefault();
                    setSearchIndex((prev) => (prev + 1) % matchRanges.length);
                  }
                }}
                placeholder="搜索日志（Cmd/Ctrl+F）"
                className="flex-1 bg-transparent text-xs text-gray-100 outline-none placeholder:text-gray-600"
              />
              <div className="text-[11px] text-gray-500">
                {searchQuery.trim() ? `${Math.min(searchIndex + 1, matchRanges.length)}/${matchRanges.length}` : "输入关键词"}
              </div>
              {matchRanges.length > 1 && (
                <button
                  type="button"
                  onClick={() => setSearchIndex((prev) => (prev + 1) % matchRanges.length)}
                  className="rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:border-brand-500 hover:text-white"
                >
                  下一个
                </button>
              )}
            </div>
          )}
          <pre
            ref={boxRef}
            className={[
              "overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-800 bg-black/70 p-3 font-mono text-[11px] leading-relaxed text-gray-300",
              compact ? "h-56" : "h-80",
            ].join(" ")}
          >
            {highlightedLog}
          </pre>
        </>
      ) : (
        <div className="rounded-lg border border-gray-800 bg-black/30 px-3 py-2 text-xs text-gray-500">
          已隐藏完整日志。{content ? "点击“查看日志”展开最新输出。" : "日志生成后可点击“查看日志”查看。"}
        </div>
      )}
    </div>
  );
}

const LOAD_STAGES = ["自检", "准备", "加载", "就绪"] as const;

/** Single source of truth for the 4-stage loader (自检 → 准备 → 加载 → 就绪). */
function StepIndicator({ current, failed = false }: { current: number; failed?: boolean }) {
  return (
    <div className="flex items-center">
      {LOAD_STAGES.map((label, index) => {
        const done = index < current;
        const active = index === current;
        const tone = failed && active
          ? "border-red-500 bg-red-500/15 text-red-300"
          : done
            ? "border-brand-500 bg-brand-500/20 text-brand-200"
            : active
              ? "border-brand-500 bg-brand-500/10 text-brand-200"
              : "border-gray-700 bg-gray-900/60 text-gray-500";
        return (
          <div key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center">
              <div
                className={[
                  "flex h-7 w-7 items-center justify-center rounded-full border text-xs font-medium transition",
                  tone,
                  active && !failed ? "ring-2 ring-brand-500/30" : "",
                ].join(" ")}
              >
                {done ? "✓" : index + 1}
              </div>
              <span className={["mt-1 text-[11px]", active || done ? "text-gray-300" : "text-gray-600"].join(" ")}>
                {label}
              </span>
            </div>
            {index < LOAD_STAGES.length - 1 && (
              <div className={["mx-1 h-px flex-1", index < current ? "bg-brand-500/60" : "bg-gray-700"].join(" ")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface LoadProgress {
  stage: number;
  percent: number;
  title: string;
  detail: string;
}

/** Maps the various sidecar/init/log signals onto one stage index + percent. */
function computeLoadProgress(args: {
  caps: GenerationCapabilities;
  serviceStarting: boolean;
  needsInit: boolean;
  failed: boolean;
  initProgress: number;
  logProgress: number;
}): LoadProgress {
  const { caps, serviceStarting, needsInit, failed, initProgress, logProgress } = args;
  const band = (lo: number, hi: number, pct: number) => lo + (Math.min(100, Math.max(0, pct)) / 100) * (hi - lo);

  if (caps.available) {
    return { stage: 3, percent: 100, title: "就绪", detail: "模型已加载，可开始生成。" };
  }
  if (needsInit) {
    if (caps.model_downloaded) {
      return {
        stage: 2,
        percent: Math.round(band(46, 96, initProgress)),
        title: failed ? "加载失败" : "正在把模型加载进内存",
        detail: failed ? "模型加载未成功，可重试或到「设置」调整后再试。" : "正在加载已下载的模型，请稍候。",
      };
    }
    return {
      stage: 1,
      percent: Math.round(band(8, 45, initProgress || logProgress)),
      title: failed ? "下载失败" : "正在下载并准备模型",
      detail: failed ? "下载未完成，可重试。" : "首次使用需下载大模型（数 GB），请耐心等待。",
    };
  }
  if (serviceStarting) {
    return {
      stage: 1,
      percent: Math.round(band(8, 45, logProgress)),
      title: "正在启动生成服务",
      detail: "正在拉起 ACE-Step 并准备依赖；若模型已下载则不会重复下载。",
    };
  }
  return { stage: 0, percent: 4, title: "正在检测后端与硬件", detail: "正在确认本地服务与设备状态。" };
}

export function GenerateSetup({ caps, onReady, compact = false }: Props) {
  const init = useInitJob(onReady);
  const { confirm, confirmNode } = useConfirmModal();
  const [dit, setDit] = useState(caps.selected_dit);
  const [lm, setLm] = useState(caps.selected_lm);
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [workspacePreview, setWorkspacePreview] = useState("");
  const [savingCfg, setSavingCfg] = useState(false);
  const [serviceStarting, setServiceStarting] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [serviceLogPath, setServiceLogPath] = useState("");
  const [guardActionBusy, setGuardActionBusy] = useState(false);
  const [logProgress, setLogProgress] = useState(0);
  const pendingInitAfterServiceRef = useRef(false);

  // First launch (no cached model selection): let the user pick models + paths.
  // Afterwards the choice is cached and we skip straight to loading.
  const firstTime = !caps.model_configured;

  // Sync defaults from capabilities once they load / change.
  useEffect(() => {
    if (caps.selected_dit) setDit(caps.selected_dit);
    if (caps.selected_lm) setLm(caps.selected_lm);
  }, [caps.selected_dit, caps.selected_lm]);

  // Prefill the path inputs with whatever is currently configured.
  useEffect(() => {
    if (!firstTime) return;
    fetchSettings()
      .then((s) => {
        setWorkspaceDir(s.workspace_dir || "");
        setWorkspacePreview(s.workspace_dir || "");
      })
      .catch(() => {
        /* keep blank -> user must configure before start */
      });
  }, [firstTime]);

  const hwUnsupported = !caps.service_up && caps.device === "cpu" &&
    caps.reason.includes("CPU");
  const serviceDown = !caps.service_up && !hwUnsupported;
  const needsInit = caps.service_up && !caps.model_ready;
  const firstTimeSetup = firstTime && !caps.model_ready && !hwUnsupported;

  const running =
    init.job?.state === "queued" || init.job?.state === "running" || caps.initializing;
  const failed = init.job?.state === "failed";

  // L1/L2: single 4-stage loader fed by sidecar/init/log signals.
  const loadProgress = useMemo(
    () =>
      computeLoadProgress({
        caps,
        serviceStarting,
        needsInit,
        failed,
        initProgress: init.job?.progress ?? 0,
        logProgress,
      }),
    [caps, serviceStarting, needsInit, failed, init.job?.progress, logProgress],
  );

  // L3: only surface the recovery actions/log hint once progress stalls.
  const [stalled, setStalled] = useState(false);
  const lastPercentRef = useRef(loadProgress.percent);
  useEffect(() => {
    setStalled(false);
    lastPercentRef.current = loadProgress.percent;
    if (caps.available || failed) return;
    const id = window.setTimeout(() => setStalled(true), 25000);
    return () => window.clearTimeout(id);
  }, [loadProgress.percent, caps.available, failed]);


  useEffect(() => {
    if (caps.service_up) {
      setServiceStarting(false);
      setServiceError(null);
    }
  }, [caps.service_up]);

  useEffect(() => {
    if (!serviceStarting || caps.service_up) return;
    const id = window.setInterval(() => onReady(), 2000);
    return () => window.clearInterval(id);
  }, [serviceStarting, caps.service_up, onReady]);

  const handleLogProgress = useCallback((pct: number) => {
    setLogProgress((prev) => (pct > prev ? pct : prev));
  }, []);

  const startSidecar = async () => {
    setServiceError(null);
    setServiceStarting(true);
    try {
      const res = await startGenerationService();
      if (res.log) setServiceLogPath(res.log);
      onReady();
    } catch (e: any) {
      setServiceError(e?.response?.data?.detail ?? "启动 ACE-Step 服务失败，请在设置的运行日志中查看 ACE-Step 日志");
      setServiceStarting(false);
    }
  };

  // Configured devices auto-load the cached models (no user action needed).
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (
      needsInit &&
      !firstTime &&
      !failed &&
      !autoStartedRef.current &&
      !init.starting &&
      !init.job
    ) {
      autoStartedRef.current = true;
      init.start();
    }
  }, [needsInit, firstTime, failed, init.starting, init.job, init]);

  // Configured installs start the sidecar automatically when entering the tab.
  useEffect(() => {
    if (
      serviceDown &&
      !firstTime &&
      !serviceStarting &&
      !serviceError
    ) {
      startSidecar();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceDown, firstTime, serviceStarting, serviceError]);

  // First-time flow: save settings, start sidecar, then initialize once it is up.
  useEffect(() => {
    if (
      pendingInitAfterServiceRef.current &&
      needsInit &&
      !init.starting &&
      !init.job
    ) {
      pendingInitAfterServiceRef.current = false;
      init.start({ dit_model: dit, lm_model: lm });
    }
  }, [needsInit, init.starting, init.job, init, dit, lm]);

  // First-time: persist paths + model choice, then kick off init.
  // Subsequent: just load with the cached config.
  const handleStart = async () => {
    if (firstTime) {
      setSavingCfg(true);
      try {
        await saveSettings({
          workspace_dir: workspaceDir,
          gen_dit_model: dit,
          gen_lm_model: lm,
        });
      } catch {
        /* non-fatal: init still uses effective defaults */
      } finally {
        setSavingCfg(false);
      }
      if (!caps.service_up) {
        pendingInitAfterServiceRef.current = true;
        await startSidecar();
        return;
      }
      await init.start({ dit_model: dit, lm_model: lm });
    } else {
      await init.start();
    }
  };

  const busy = init.starting || savingCfg || serviceStarting;
  const requiredDirsReady = !!workspaceDir.trim();
  const workspaceRoot = (workspacePreview || workspaceDir).replace(/\/$/, "");
  const memoryGuard = init.guard?.type === "memory_guard" ? init.guard : null;
  const switchToConservativeAndRetry = async () => {
    setGuardActionBusy(true);
    try {
      setDit("acestep-v15-turbo");
      setLm("none");
      await saveSettings({
        generation_performance_mode: "conservative",
        gen_dit_model: "acestep-v15-turbo",
        gen_lm_model: "none",
      });
      onReady();
      autoStartedRef.current = true;
      await init.start({ dit_model: "acestep-v15-turbo", lm_model: "none" });
    } finally {
      setGuardActionBusy(false);
    }
  };
  const continueLoadAnyway = async () => {
    const ok = await confirm({
      title: "仍然继续加载？",
      description:
        "继续加载可能超出可用内存，触发系统 swap、明显变慢甚至卡死。确定仍要继续吗？",
      confirmText: "仍然继续",
      tone: "danger",
    });
    if (!ok) return;
    setGuardActionBusy(true);
    try {
      autoStartedRef.current = true;
      await init.start({
        dit_model: dit || undefined,
        lm_model: lm || undefined,
        force_memory_guard: true,
      });
    } finally {
      setGuardActionBusy(false);
    }
  };
  const renderMemoryGuard = (guard: InitGuardDetail) => (
    <div className="mt-4 rounded-xl border border-amber-700/70 bg-amber-950/30 px-4 py-4 text-left">
      <div className="text-sm font-semibold text-amber-200">内存可能不足</div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-lg bg-black/30 px-2 py-1.5">
          <div className="text-gray-500">预计峰值</div>
          <div className="mt-0.5 text-sm font-medium text-amber-200">{guard.required_gb.toFixed(1)} GB</div>
        </div>
        <div className="rounded-lg bg-black/30 px-2 py-1.5">
          <div className="text-gray-500">当前可用</div>
          <div className="mt-0.5 text-sm font-medium text-amber-200">{guard.available_gb.toFixed(1)} GB</div>
        </div>
        <div className="rounded-lg bg-black/30 px-2 py-1.5">
          <div className="text-gray-500">物理总内存</div>
          <div className="mt-0.5 text-sm font-medium text-gray-300">{guard.total_gb.toFixed(1)} GB</div>
        </div>
      </div>
      <div className="mt-2 text-xs text-amber-100/80">
        建议切换保守模式（turbo DiT、不加载 LM）以稳定运行。
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={guardActionBusy}
          onClick={() => {
            void switchToConservativeAndRetry();
          }}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {guardActionBusy ? "处理中…" : "切换保守模式（推荐）"}
        </button>
        {guard.can_continue && (
          <button
            type="button"
            disabled={guardActionBusy}
            onClick={() => {
              void continueLoadAnyway();
            }}
            className="text-xs text-amber-300/80 underline underline-offset-2 transition hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {guardActionBusy ? "处理中…" : "仍然继续加载"}
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className={compact ? "" : "h-full min-h-0 overflow-y-auto p-6"}>
      {confirmNode}
      <div
        className={
          compact
            ? "rounded-xl border border-gray-800 bg-gray-900/50 p-4"
            : "mx-auto w-full max-w-3xl rounded-2xl border border-gray-800 bg-gray-900/40 p-10 text-center"
        }
      >
        {/* ----- hardware unsupported ----- */}
        {hwUnsupported && (
          <>
            <div className="text-5xl mb-4"></div>
            <h2 className="text-lg font-semibold text-gray-100 mb-2">当前设备不支持音乐生成</h2>
            <p className="text-sm text-gray-400">{caps.reason}</p>
          </>
        )}

        {/* ----- first time setup: pick models + workspace, then start ----- */}
        {firstTimeSetup && !serviceStarting && !running && (
          <>
            <div className="text-5xl mb-4">📦</div>
            <h2 className="text-lg font-semibold text-gray-100 mb-2">
              {caps.model_downloaded ? "加载模型" : "首次使用：设置并下载大模型"}
            </h2>
            <p className="text-sm text-gray-400 mb-1">
              {caps.service_up
                ? caps.reason
                : "请先选择音乐工作目录。保存后会启动 ACE-Step，并把模型下载到工作目录下的 ace/models/。"}
            </p>
            <div className="text-xs text-gray-500 mb-4 space-y-0.5">
              <div>设备：{caps.device.toUpperCase()}{caps.gpu_name && ` · ${caps.gpu_name}`}</div>
              <div>推荐模型：{caps.recommended_dit}{caps.recommended_lm ? ` + ${caps.recommended_lm}` : ""}</div>
              <div className="break-all">模型目录：{caps.checkpoints_dir || "未设置"}</div>
            </div>

            <div className="mb-6 space-y-4">
              <ModelSelect
                label="DiT 模型"
                options={caps.dit_options}
                value={dit}
                onChange={setDit}
                disabled={busy}
              />
              <ModelSelect
                label="LM 模型"
                options={caps.lm_options}
                value={lm}
                onChange={setLm}
                disabled={busy}
              />
              <div className="text-left">
                <label className="block text-xs text-gray-400 mb-1">音乐工作目录</label>
                <DirectoryPicker
                  value={workspaceDir}
                  onChange={(value) => {
                    setWorkspaceDir(value);
                    setWorkspacePreview(value);
                  }}
                  disabled={busy}
                  placeholder="必须选择一个工作目录"
                  title="选择音乐工作目录"
                />
                <p className="mt-1 text-[11px] text-gray-500 break-all">
                  保存后自动创建：{workspaceRoot ? `${workspaceRoot}/ace/models、ace/generation、ace/generation_history、separation/outputs、svc/models、uploads` : "ace/models、ace/generation、ace/generation_history、separation/outputs、svc/models、uploads"}。
                </p>
              </div>
            </div>

            <button
              onClick={handleStart}
              disabled={busy || !requiredDirsReady}
              className="rounded-xl bg-brand-600 hover:bg-brand-500 px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy
                ? "正在启动…"
                : !caps.service_up
                  ? "保存设置并启动生成服务"
                  : caps.model_downloaded
                    ? "加载模型"
                    : "开始下载并初始化"}
            </button>
            {!requiredDirsReady && (
              <p className="mt-3 text-xs text-amber-300">
                请先选择音乐工作目录，应用不会使用默认目录启动。
              </p>
            )}
            {init.error && <div className="mt-4 text-sm text-red-400">{init.error}</div>}
            {memoryGuard && renderMemoryGuard(memoryGuard)}
            {serviceError && <div className="mt-4 text-sm text-red-400">{serviceError}</div>}
          </>
        )}

        {/* ----- unified 4-stage loader: 自检 → 准备 → 加载 → 就绪 ----- */}
        {!hwUnsupported && !(firstTimeSetup && !serviceStarting && !running) && (
          <div className="text-left">
            {failed ? (
              <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full border-4 border-red-700/70 text-2xl text-red-300">!</div>
            ) : (
              <div className="mx-auto mb-5 h-12 w-12 rounded-full border-4 border-gray-700 border-t-brand-500 animate-spin" />
            )}

            <div className="mb-5">
              <StepIndicator current={loadProgress.stage} failed={failed} />
            </div>

            <div className="mb-4 text-center">
              <h2 className={["text-lg font-semibold", failed ? "text-red-300" : "text-gray-100"].join(" ")}>
                {loadProgress.title}
              </h2>
              <p className="mt-1 text-sm text-gray-400">{loadProgress.detail}</p>
            </div>

            {!failed && (
              <div className="mb-4">
                <div className="mb-1 flex justify-between text-xs text-gray-400">
                  <span>{init.job?.stage || LOAD_STAGES[loadProgress.stage]}</span>
                  <span className="font-mono">{loadProgress.percent}%</span>
                </div>
                <ProgressBar value={loadProgress.percent} />
              </div>
            )}

            <div className="mb-3 text-[11px] text-gray-500">
              设备 {caps.device.toUpperCase()}{caps.gpu_name && ` · ${caps.gpu_name}`}
              {" · "}
              模型 {caps.selected_dit || caps.recommended_dit}
              {caps.selected_lm && caps.selected_lm !== "none" ? ` + ${caps.selected_lm}` : ""}
            </div>

            {failed && (
              <>
                <div className="mb-3 rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300">
                  初始化失败：{init.job?.error ?? init.error ?? serviceError ?? "未知错误"}
                </div>
                <button
                  onClick={() => {
                    autoStartedRef.current = true;
                    init.start();
                  }}
                  className="rounded-xl bg-brand-600 hover:bg-brand-500 px-6 py-3 text-sm font-medium text-white"
                >
                  重试加载
                </button>
              </>
            )}

            {/* L3: recovery actions only appear once progress stalls. */}
            {!failed && stalled && (
              <div className="mb-3 rounded-lg border border-amber-700/60 bg-amber-900/15 px-3 py-2.5 text-xs text-amber-200/90">
                <div>长时间没有进展？可重新同步加载任务，或在「设置」的运行日志查看 ACE-Step 详细日志。</div>
                {needsInit && (
                  <button
                    type="button"
                    onClick={() => {
                      autoStartedRef.current = true;
                      init.start();
                    }}
                    disabled={init.starting}
                    className="mt-2 rounded-lg border border-amber-600/70 px-3 py-1.5 text-amber-100 transition hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {init.starting ? "正在同步…" : "重新同步加载任务"}
                  </button>
                )}
              </div>
            )}

            {(serviceStarting || serviceDown || needsInit) && (
              <StartupLogViewer
                active={serviceStarting || serviceDown || needsInit}
                logPath={serviceLogPath}
                compact
                hideProgress
                onProgress={handleLogProgress}
              />
            )}

            {init.error && !failed && <div className="mt-4 text-sm text-red-400">{init.error}</div>}
            {serviceError && !failed && <div className="mt-4 text-sm text-red-400">{serviceError}</div>}
            {memoryGuard && renderMemoryGuard(memoryGuard)}
          </div>
        )}
      </div>
    </div>
  );
}
