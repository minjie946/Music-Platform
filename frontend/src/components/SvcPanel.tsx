import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteSvcVoice,
  fetchSvcCapabilities,
  fetchSvcTrainStatus,
  fetchSvcVoices,
  importSvcVoice,
  previewSvcVoice,
  restartSvcService,
  svcVoiceExportUrl,
  trainSvc,
} from "../api";
import type { SvcTrainStatus } from "../types";
import { useConfirmModal, useToast } from "./AppFeedback";
import { useDownloadCenter } from "./DownloadCenter";
import { Hint } from "./Hint";
import { fmtDateTime } from "../utils/format";

const ENGINE_INFO: Record<string, { label: string; desc: string }> = {
  sovits: {
    label: "so-vits-svc",
    desc: "跨平台（CPU/MPS/CUDA 均可训练）。音质上限更高，训练更重、更慢；适合追求效果且样本较充足（建议 5-30 分钟干净人声）。",
  },
};

export function SvcPanel() {
  const qc = useQueryClient();
  const { data: caps, isFetching: capsFetching } = useQuery({
    queryKey: ["svc-capabilities"],
    queryFn: fetchSvcCapabilities,
    refetchInterval: (q) => (q.state.data?.service_up ? 30000 : 4000),
    retry: true,
  });
  const { data: voices } = useQuery({
    queryKey: ["svc-voices"],
    queryFn: fetchSvcVoices,
    refetchInterval: 8000,
    enabled: !!caps?.service_up,
  });

  const [name, setName] = useState("");
  const [engine, setEngine] = useState("sovits");
  const [files, setFiles] = useState<File[]>([]);
  const [epochs, setEpochs] = useState(50);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [train, setTrain] = useState<SvcTrainStatus | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [svcStarting, setSvcStarting] = useState(false);
  const [svcStartErr, setSvcStartErr] = useState<string | null>(null);
  const { confirm, confirmNode } = useConfirmModal();
  const { showToast, toastNode } = useToast();
  const { startDownload } = useDownloadCenter();
  const pollRef = useRef<number | null>(null);
  const autoStartTriedRef = useRef(false);
  const [importing, setImporting] = useState(false);

  const engines = caps?.engines ?? {};
  const engCap = engines[engine];
  const trainAvailable = !!engCap?.train_available;
  const svcNeedsConfig = (caps?.reason || "").includes("请先在设置中配置目录");
  const svcBusy = svcStarting || (!caps && capsFetching);

  // Default the engine to the first one whose training is available.
  useEffect(() => {
    if (!caps?.service_up) return;
    const avail = Object.entries(engines).find(([, c]) => c.train_available);
    if (avail && !engines[engine]?.train_available) setEngine(avail[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps?.service_up]);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const refreshSvcState = () => {
    qc.invalidateQueries({ queryKey: ["svc-capabilities"] });
    qc.invalidateQueries({ queryKey: ["svc-voices"] });
  };

  const handleRestartSvc = async (manual = true) => {
    if (svcStarting) return;
    setSvcStartErr(null);
    setSvcStarting(true);
    try {
      const result = await restartSvcService();
      refreshSvcState();
      if (result.service_up) {
        if (manual) showToast("SVC 服务已启动", "success");
        return;
      }
      if (!result.restarting) {
        const message = result.reason || "SVC 服务未启动，请检查 SVC 日志后重试";
        setSvcStartErr(message);
        if (manual) showToast(message, "error");
        return;
      }
      if (manual) showToast("SVC 服务正在启动，请稍后刷新状态", "success");
      window.setTimeout(refreshSvcState, 1500);
      window.setTimeout(refreshSvcState, 4000);
    } catch (e: any) {
      const message = e?.response?.data?.detail || "SVC 服务启动失败，请检查 SVC 日志后重试";
      setSvcStartErr(message);
      if (manual) showToast(message, "error");
    } finally {
      setSvcStarting(false);
    }
  };

  useEffect(() => {
    if (autoStartTriedRef.current || caps?.service_up || svcNeedsConfig || !caps) return;
    autoStartTriedRef.current = true;
    handleRestartSvc(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps?.service_up, svcNeedsConfig, !!caps]);

  const pollTrain = (trainId: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const s = await fetchSvcTrainStatus(trainId);
        setTrain(s);
        if (s.state === "done" || s.state === "failed") {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          qc.invalidateQueries({ queryKey: ["svc-voices"] });
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  };

  const handleTrain = async () => {
    setErr(null);
    if (files.length === 0) {
      setErr("请上传至少一段声音样本");
      return;
    }
    if (!name.trim()) {
      setErr("请填写音源名称");
      return;
    }
    setSubmitting(true);
    try {
      const s = await trainSvc(files, { name: name.trim(), engine, max_epochs: epochs });
      setTrain(s);
      pollTrain(s.train_id);
      setFiles([]);
      setName("");
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? "提交训练失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: "删除 SVC 音源",
      description: "确定删除该音源？此操作不可恢复。",
      confirmText: "删除",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await deleteSvcVoice(id);
      qc.invalidateQueries({ queryKey: ["svc-voices"] });
      showToast("音源已删除", "success");
    } catch {
      showToast("删除音源失败，请稍后重试", "error");
    }
  };

  const handleExport = async (voiceId: string, filename: string) => {
    try {
      await startDownload(svcVoiceExportUrl(voiceId), filename);
    } catch {
      showToast("导出音源失败，请稍后重试", "error");
    }
  };

  const handleImport = async (file: File | undefined) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      const voice = await importSvcVoice(file);
      qc.invalidateQueries({ queryKey: ["svc-voices"] });
      showToast(`已导入音源：${voice.name}`, "success");
    } catch (e: any) {
      showToast(e?.response?.data?.detail || "导入音源失败，请检查音源包格式", "error");
    } finally {
      setImporting(false);
    }
  };

  const handlePreview = async (voiceId: string, file: File | undefined) => {
    if (!file) return;
    setPreviewErr(null);
    setPreviewVoiceId(voiceId);
    setPreviewingId(voiceId);
    try {
      const blob = await previewSvcVoice(voiceId, file);
      const url = URL.createObjectURL(blob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
      setPreviewVoiceId(voiceId);
    } catch (e: any) {
      setPreviewErr(e?.response?.data?.detail ?? "试听转换失败");
    } finally {
      setPreviewingId(null);
    }
  };

  const training = train?.state === "queued" || train?.state === "running";

  return (
    <main className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[460px_1fr] gap-6 p-6 overflow-auto">
      {confirmNode}
      {toastNode}
      {/* Left: training form */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 overflow-auto">
        <h2 className="text-base font-semibold text-gray-100 mb-1">训练 SVC 音源</h2>
        <p className="text-xs text-gray-500 mb-4">
          上传你自己的清唱/说话录音（至少 5 段，越干净、越多样越好，建议 5-30 分钟，无背景音乐），训练出专属音色，
          可在「音乐生成 · 人声模式」中使用。
        </p>

        {!caps?.service_up && (
          <div className="mb-4 rounded-lg border border-amber-700/60 bg-amber-900/20 px-3 py-3 text-xs text-amber-300">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">
                  {svcBusy ? "SVC 音源服务启动中…" : svcStartErr ? "SVC 音源服务加载失败" : "SVC 音源服务未启动"}
                </div>
                <div className="mt-1 text-amber-200/90">
                  {svcStartErr || caps?.reason || "正在连接 SVC 音源服务，请稍候。"}
                </div>
                {svcStarting && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-amber-950/80">
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-amber-400" />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleRestartSvc(true)}
                disabled={svcStarting || svcNeedsConfig}
                className={[
                  "shrink-0 rounded-md border px-3 py-1.5 text-xs transition",
                  svcStarting || svcNeedsConfig
                    ? "cursor-not-allowed border-amber-900/80 text-amber-700"
                    : "border-amber-600 text-amber-200 hover:bg-amber-500/10",
                ].join(" ")}
              >
                {svcStarting ? "启动中…" : svcStartErr ? "重试加载" : "重启加载 SVC"}
              </button>
            </div>
            {svcNeedsConfig && (
              <p className="mt-2 text-[11px] text-amber-400/80">
                配置工作目录后，进入本页会自动加载 SVC，也可以手动点击重启加载。
              </p>
            )}
          </div>
        )}
        {caps?.service_up && (
          <div className="mb-4 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 text-xs text-gray-400">
            设备：<span className="text-gray-200">{caps.device.toUpperCase()}</span>
          </div>
        )}

        <label className="block text-sm text-gray-300 mb-1">音源名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：我的声音"
          className="w-full mb-3 rounded-lg bg-white/5 border border-gray-700 hover:bg-white/10 px-3 py-2 text-sm text-gray-100 outline-none focus:border-brand-500"
        />

        <label className="block text-sm text-gray-300 mb-1">引擎</label>
        <div className="space-y-2 mb-2">
          {Object.keys(ENGINE_INFO).map((key) => {
            const c = engines[key];
            const canTrain = !!c?.train_available;
            return (
              <label
                key={key}
                className={[
                  "flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm",
                  engine === key
                    ? "border-brand-500 bg-brand-500/10"
                    : "border-gray-700 bg-gray-900/40",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="svc-engine"
                  value={key}
                  checked={engine === key}
                  onChange={() => setEngine(key)}
                  className="mt-1 accent-brand-500"
                />
                <span>
                  <span className="font-medium text-gray-100">
                    {ENGINE_INFO[key].label}
                    {!canTrain && (
                      <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                        本机不可训练
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-gray-400">{ENGINE_INFO[key].desc}</span>
                  {c?.note && (
                    <span className="mt-0.5 block text-[11px] text-amber-400/80">{c.note}</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        <label className="block text-sm text-gray-300 mb-1">
          声音样本（可多选）
          <Hint text="支持 wav/mp3/flac 等。so-vits 至少需要 5 段有效音频；建议切成多个 5-15 秒、单人、清晰、无伴奏的人声片段。" />
        </label>
        <input
          type="file"
          accept="audio/*"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="w-full mb-1 text-xs text-gray-400 file:mr-3 file:rounded-md file:border-0 file:bg-gray-800 file:px-3 file:py-1.5 file:text-gray-200"
        />
        {files.length > 0 && (
          <p className="mb-3 text-[11px] text-gray-500">已选 {files.length} 个文件</p>
        )}

        <label className="block text-sm text-gray-300 mb-1 mt-2">
          训练轮数 {epochs}
          <Hint text="轮数越多通常效果越好但耗时显著增加。CPU/MPS 上建议先用较小值快速验证。" />
        </label>
        <input
          type="range"
          min={10}
          max={200}
          step={10}
          value={epochs}
          onChange={(e) => setEpochs(Number(e.target.value))}
          className="w-full mb-4"
        />

        {err && (
          <div className="mb-3 rounded-lg border border-red-700 bg-red-900/30 px-3 py-2 text-xs text-red-300">
            {err}
          </div>
        )}

        <button
          onClick={handleTrain}
          disabled={!caps?.service_up || !trainAvailable || submitting || training || svcBusy}
          className={[
            "w-full rounded-lg px-4 py-2.5 text-sm font-medium transition",
            !caps?.service_up || !trainAvailable || submitting || training || svcBusy
              ? "bg-gray-800 text-gray-500 cursor-not-allowed"
              : "bg-brand-600 text-white hover:bg-brand-500",
          ].join(" ")}
        >
          {training ? "训练中…" : submitting ? "提交中…" : "开始训练"}
        </button>
        {!trainAvailable && caps?.service_up && (
          <p className="mt-2 text-[11px] text-gray-500">
            该引擎在本机不可训练{engCap?.note ? `：${engCap.note}` : ""}
          </p>
        )}

        {train && (
          <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900/40 p-3">
            <div className="flex items-center justify-between text-xs text-gray-300">
              <span>{train.stage || train.state}</span>
              <span>{train.progress}%</span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-800">
              <div
                className={[
                  "h-full transition-all duration-300",
                  train.state === "failed" ? "bg-red-500" : "bg-brand-500",
                ].join(" ")}
                style={{ width: `${Math.min(100, Math.max(0, train.progress))}%` }}
              />
            </div>
            {train.state === "failed" && (
              <p className="mt-2 text-[11px] text-red-400">{train.error || "训练失败"}</p>
            )}
            {train.state === "done" && (
              <p className="mt-2 text-[11px] text-emerald-400">训练完成，可在音乐生成中使用。</p>
            )}
          </div>
        )}
      </div>

      {/* Right: voice list */}
      <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 overflow-auto">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-100">我的音源</h2>
          <label
            className={[
              "rounded-md border px-3 py-1.5 text-xs transition",
              caps?.service_up && !importing
                ? "cursor-pointer border-gray-700 text-gray-300 hover:border-brand-500 hover:text-brand-300"
                : "cursor-not-allowed border-gray-800 text-gray-600",
            ].join(" ")}
          >
            {importing ? "导入中…" : "导入音源"}
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={!caps?.service_up || importing}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.currentTarget.value = "";
                handleImport(file);
              }}
              className="hidden"
            />
          </label>
        </div>
        {(voices ?? []).length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-gray-500">
            还没有音源，先在左侧训练一个吧。
          </div>
        ) : (
          <ul className="space-y-2">
            {(voices ?? []).map((v) => (
              <li
                key={v.id}
                className="rounded-lg border border-gray-800 bg-gray-900/60 px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm text-gray-100">
                      {v.name}
                      <span className="ml-2 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                        {v.engine}
                      </span>
                      {v.ready ? (
                        <span className="ml-2 text-[11px] text-emerald-400">可用</span>
                      ) : (
                        <span className="ml-2 text-[11px] text-amber-400">未就绪</span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500">{fmtDateTime(v.created_at)}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => handleExport(v.id, `${v.name || v.id}.svcvoice.zip`)}
                      disabled={!v.ready}
                      className={[
                        "rounded-md border px-2.5 py-1 text-xs transition",
                        v.ready
                          ? "border-gray-700 text-gray-300 hover:border-brand-500 hover:text-brand-300"
                          : "cursor-not-allowed border-gray-800 text-gray-600",
                      ].join(" ")}
                    >
                      导出
                    </button>
                    <label
                      className={[
                        "rounded-md border px-2.5 py-1 text-xs transition",
                        v.ready && previewingId !== v.id
                          ? "cursor-pointer border-gray-700 text-gray-300 hover:border-brand-500 hover:text-brand-300"
                          : "cursor-not-allowed border-gray-800 text-gray-600",
                      ].join(" ")}
                    >
                      {previewingId === v.id ? "转换中…" : "试听"}
                      <input
                        type="file"
                        accept="audio/*"
                        disabled={!v.ready || previewingId === v.id}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.currentTarget.value = "";
                          handlePreview(v.id, f);
                        }}
                        className="hidden"
                      />
                    </label>
                    <button
                      onClick={() => handleDelete(v.id)}
                      className="rounded-md border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:border-red-600 hover:text-red-400"
                    >
                      删除
                    </button>
                  </div>
                </div>
                {previewVoiceId === v.id && previewUrl && (
                  <audio controls src={previewUrl} className="mt-3 w-full" />
                )}
                {previewVoiceId === v.id && previewErr && (
                  <p className="mt-2 text-[11px] text-red-400">{previewErr}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
