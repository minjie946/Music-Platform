import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchDesktopResourceUsage,
  isDesktopRuntime,
  terminateDesktopResourceProcess,
  type DesktopResourceProcess,
} from "../api";

interface ProcessTreeNode {
  process: DesktopResourceProcess;
  children: ProcessTreeNode[];
}

function fmtBytes(bytes: number): string {
  if (!bytes) return "--";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)}GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)}MB`;
}

function fmtPercent(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return `${Math.max(0, value).toFixed(value >= 10 ? 0 : 1)}%`;
}

function buildProcessTree(processes: DesktopResourceProcess[]): ProcessTreeNode[] {
  const nodes = new Map<number, ProcessTreeNode>();
  processes.forEach((process) => nodes.set(process.pid, { process, children: [] }));
  const roots: ProcessTreeNode[] = [];
  nodes.forEach((node) => {
    const parent = nodes.get(node.process.parent_pid);
    if (parent && parent.process.pid !== node.process.pid) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortTree = (items: ProcessTreeNode[]) => {
    items.sort((a, b) => b.process.memory_bytes - a.process.memory_bytes);
    items.forEach((item) => sortTree(item.children));
  };
  sortTree(roots);
  return roots;
}

export function ResourceUsageBadge() {
  const desktop = isDesktopRuntime();
  const [terminatingPid, setTerminatingPid] = useState<number | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const { data, refetch } = useQuery({
    queryKey: ["desktop-resource-usage"],
    queryFn: fetchDesktopResourceUsage,
    enabled: desktop,
    refetchInterval: 2000,
  });
  const topProcesses = data?.top_processes ?? [];
  const processTree = useMemo(() => buildProcessTree(topProcesses), [topProcesses]);

  if (!desktop || !data) return null;

  const otherMemory = Math.max(0, data.used_memory_bytes - data.app_memory_bytes);
  // M3: warn when system memory approaches the level a local model needs.
  const memPercent = data.used_memory_percent;
  const memTone =
    memPercent >= 85
      ? { text: "text-red-300", dot: "bg-red-400", label: "内存紧张，接近模型所需峰值，建议先关闭占用大的进程或切换保守模式" }
      : memPercent >= 70
        ? { text: "text-amber-300", dot: "bg-amber-400", label: "内存偏高，接近模型加载峰值时可能触发系统 swap" }
        : { text: "text-gray-300", dot: "", label: "" };
  const terminateProcess = async (pid: number, name: string) => {
    setActionMessage("");
    const ok = window.confirm(`确定要结束进程 ${name || "process"}（pid ${pid}）吗？\n\n正在运行的模型加载/生成任务会中断。`);
    if (!ok) return;
    setTerminatingPid(pid);
    try {
      const result = await terminateDesktopResourceProcess(pid);
      setActionMessage(result?.message || `已发送结束信号：pid ${pid}`);
      window.setTimeout(() => {
        void refetch();
      }, 1000);
      await refetch();
    } catch (error: any) {
      setActionMessage(error?.message || "结束进程失败");
    } finally {
      setTerminatingPid(null);
    }
  };
  const renderNode = (node: ProcessTreeNode, depth = 0) => {
    const proc = node.process;
    return (
      <div key={proc.pid} className="relative">
        <div
          className="rounded-lg border border-gray-800 bg-gray-900/60 px-2 py-1.5"
          style={{ marginLeft: `${depth * 18}px` }}
        >
          {depth > 0 && (
            <span className="absolute -left-1 top-4 h-px w-4 bg-gray-800" style={{ marginLeft: `${depth * 18}px` }} />
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs text-gray-200">
                {depth > 0 ? "└ " : ""}
                {proc.name || "process"} · pid {proc.pid}
              </div>
              <div className="mt-0.5 text-[10px] text-gray-500">
                ppid {proc.parent_pid || "-"} · {proc.group || "应用进程"} · {proc.session || "未标记"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-gray-300">
                {fmtBytes(proc.memory_bytes)} / CPU {fmtPercent(proc.cpu_percent)}
              </span>
              {proc.can_terminate && (
                <button
                  type="button"
                  disabled={terminatingPid === proc.pid}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void terminateProcess(proc.pid, proc.name);
                  }}
                  className="rounded-md border border-red-900/70 px-2 py-0.5 text-[11px] text-red-300 transition hover:border-red-500 hover:bg-red-950/50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {terminatingPid === proc.pid ? "结束中" : "结束"}
                </button>
              )}
            </div>
          </div>
          {proc.command && (
            <div className="mt-0.5 truncate text-[10px] text-gray-600">{proc.command}</div>
          )}
        </div>
        {node.children.length > 0 && (
          <div className="mt-1 space-y-1">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };
  return (
    <div
      className="group relative hidden items-center gap-2 rounded-full border border-white/5 bg-[#181820] px-4 py-1.5 text-xs text-gray-400 xl:flex"
      title={`当前应用进程组内存 ${fmtBytes(data.app_memory_bytes)}；系统其他已用内存 ${fmtBytes(otherMemory)}；物理总内存 ${fmtBytes(data.total_memory_bytes)}。系统已用不是当前应用独占。${memTone.label ? `\n\n⚠ ${memTone.label}。` : ""}`}
    >
      <span className="text-gray-500">资源</span>
      <span className="text-gray-300">CPU {fmtPercent(data.app_cpu_percent)}</span>
      <span className="h-3 w-px bg-white/10" />
      <span className="text-gray-300">
        应用内存 {fmtBytes(data.app_memory_bytes)}
      </span>
      <span className="h-3 w-px bg-white/10" />
      <span className={`flex items-center gap-1.5 ${memTone.text}`}>
        {memTone.dot && <span className={`h-1.5 w-1.5 rounded-full ${memTone.dot}`} />}
        系统已用 {fmtBytes(data.used_memory_bytes)} / {fmtBytes(data.total_memory_bytes)} ({fmtPercent(data.used_memory_percent)})
      </span>
      {processTree.length > 0 && (
        <div className="absolute right-0 top-full z-[90] mt-2 hidden max-h-[620px] w-[640px] overflow-y-auto rounded-2xl border border-gray-800 bg-gray-950 p-3 text-left shadow-2xl shadow-black/60 group-hover:block">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-200">当前应用进程树</span>
            <span className="text-[11px] text-gray-500">按父子关系展示</span>
          </div>
          {actionMessage && (
            <div className="mb-2 rounded-lg border border-gray-800 bg-gray-900/80 px-2 py-1 text-[11px] text-gray-300">
              {actionMessage}
            </div>
          )}
          <div className="space-y-1.5">
            {processTree.map((node) => renderNode(node))}
          </div>
        </div>
      )}
    </div>
  );
}
