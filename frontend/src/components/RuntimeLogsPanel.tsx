import { useEffect, useRef, useState } from "react";
import { fetchRuntimeLog, runtimeLogEventsUrl } from "../api";
import type { RuntimeLog } from "../types";

type LogName = RuntimeLog["name"];

const LOGS: Array<{ id: LogName; label: string; desc: string }> = [
  { id: "launcher", label: "Launcher", desc: "桌面启动器与运行编排日志" },
  { id: "api", label: "API", desc: "后端 FastAPI 服务日志" },
  { id: "worker", label: "Worker", desc: "Celery 任务队列与定时任务日志" },
  { id: "acestep", label: "ACE-Step", desc: "音乐生成 sidecar 日志" },
  { id: "svc", label: "SVC", desc: "歌声转换 sidecar 日志" },
];

function stripAnsi(s: string): string {
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

export function RuntimeLogsPanel({ active }: { active: boolean }) {
  const [selected, setSelected] = useState<LogName>("launcher");
  const [content, setContent] = useState("");
  const [path, setPath] = useState("");
  const [exists, setExists] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError("");
    fetchRuntimeLog(selected)
      .then((log) => {
        if (cancelled) return;
        setContent(stripAnsi(log.content || ""));
        setPath(log.path);
        setExists(log.exists);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.response?.data?.detail ?? "读取日志失败");
        setContent("");
        setPath("");
        setExists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, selected]);

  useEffect(() => {
    if (!active) return;
    const es = new EventSource(runtimeLogEventsUrl(selected));
    es.addEventListener("append", (ev) => {
      setExists(true);
      setContent((prev) => {
        const next = prev + stripAnsi((ev as MessageEvent).data);
        return next.length > 200_000 ? next.slice(-200_000) : next;
      });
    });
    es.onerror = () => {
      /* Keep the static snapshot visible; browser/EventSource will retry. */
    };
    return () => es.close();
  }, [active, selected]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [content]);

  const meta = LOGS.find((x) => x.id === selected)!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 -mx-6 mb-3 border-b border-gray-800 bg-gray-900/95 px-6 pb-3 backdrop-blur shadow-lg shadow-black/25">
        <div className="flex gap-1 rounded-lg bg-gray-800/60 p-1">
        {LOGS.map((l) => (
          <button
            key={l.id}
            onClick={() => setSelected(l.id)}
            className={[
              "flex-1 rounded-md px-3 py-2 text-sm font-medium transition",
              selected === l.id ? "bg-brand-600 text-white" : "text-gray-400 hover:text-gray-200",
            ].join(" ")}
          >
            {l.label}
          </button>
        ))}
        </div>
      </div>

      <div className="mb-2 shrink-0">
        <h3 className="text-sm font-semibold text-gray-200">{meta.label} 运行日志</h3>
        <p className="mt-1 text-xs text-gray-500">
          {meta.desc}，只读实时查看，不支持在界面内清空、删除或执行操作。
        </p>
        {path && <p className="mt-1 break-all text-[11px] text-gray-600">文件：{path}</p>}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-700 bg-red-900/30 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {!exists && !content && !error && (
        <div className="mb-3 rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-2 text-xs text-amber-300">
          日志文件尚未生成。服务启动后会自动显示新增日志。
        </div>
      )}

      <pre
        ref={boxRef}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-gray-800 bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-gray-300"
      >
        {content || "等待日志输出..."}
      </pre>
    </div>
  );
}
