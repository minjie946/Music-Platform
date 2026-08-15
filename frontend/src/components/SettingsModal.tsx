import { useEffect, useState } from "react";
import {
  fetchGenerationCapabilities,
  fetchSettings,
  restartGenerationService,
  restartSvcService,
  saveSettings,
  stopGenerationService,
} from "../api";
import type { GenModelOption, RuntimeSettingsOut } from "../types";
import { DirectoryPicker } from "./DirectoryPicker";
import { Drawer } from "./Drawer";
import { RuntimeLogsPanel } from "./RuntimeLogsPanel";
import { Select } from "./Select";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type PerformanceMode = RuntimeSettingsOut["generation_performance_mode"];

const PERFORMANCE_MODES: Array<{
  id: PerformanceMode;
  title: string;
  desc: string;
  warn?: string;
}> = [
    {
      id: "conservative",
      title: "保守模式",
      desc: "默认，稳定优先。关闭 LM、限制批量与时长，降低 macOS 内存压力。",
    },
    {
      id: "standard",
      title: "标准模式",
      desc: "可用 LM 0.6B，质量更好，仍控制批量和时长。",
    },
    {
      id: "quality",
      title: "高质量模式",
      desc: "更长时长/更大 LM，适合内存充足时使用。",
      warn: "可能触发 macOS 内存压力提示。",
    },
  ];

export function SettingsModal({ open, onClose, onSaved }: Props) {
  const [engine, setEngine] = useState("demucs");
  const [keyMasked, setKeyMasked] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [cascade, setCascade] = useState(false);
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [workspaceEffective, setWorkspaceEffective] = useState("");
  const [ckptEffective, setCkptEffective] = useState("");
  const [outEffective, setOutEffective] = useState("");
  const [histEffective, setHistEffective] = useState("");
  const [sepOutEffective, setSepOutEffective] = useState("");
  const [tmpEffective, setTmpEffective] = useState("");
  const [svcEffective, setSvcEffective] = useState("");
  const [ditModel, setDitModel] = useState("");
  const [lmModel, setLmModel] = useState("");
  const [performanceMode, setPerformanceMode] = useState<PerformanceMode>("conservative");
  const [ditOptions, setDitOptions] = useState<GenModelOption[]>([]);
  const [lmOptions, setLmOptions] = useState<GenModelOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [stoppingAce, setStoppingAce] = useState(false);
  const [restartingServices, setRestartingServices] = useState(false);
  const [migrateExisting, setMigrateExisting] = useState(true);
  const [cleanupOldTemp, setCleanupOldTemp] = useState(true);
  const [migrationSummary, setMigrationSummary] = useState<string[]>([]);
  const [serviceMessage, setServiceMessage] = useState("");
  const [tab, setTab] = useState<"separation" | "generation" | "svc" | "logs">("generation");

  useEffect(() => {
    if (!open) return;
    fetchSettings().then((s) => {
      setEngine(s.default_engine);
      setKeyMasked(s.lalal_api_key_masked);
      setKeySet(s.lalal_api_key_set);
      setCascade(s.cascade_vocal_split);
      setWorkspaceDir(s.workspace_dir);
      setWorkspaceEffective(s.workspace_dir);
      setCkptEffective(s.effective_checkpoints_dir);
      setOutEffective(s.effective_generation_dir);
      setHistEffective(s.effective_history_dir);
      setSepOutEffective(s.effective_separation_dir);
      setTmpEffective(s.effective_acestep_tmp_dir);
      setSvcEffective(s.effective_svc_models_dir);
      setPerformanceMode(s.generation_performance_mode || "conservative");
      setNewKey("");
      setMigrationSummary([]);
      setServiceMessage("");
    });
    // Capabilities give the selectable model options + the current selection.
    fetchGenerationCapabilities()
      .then((c) => {
        setDitOptions(c.dit_options || []);
        setLmOptions(c.lm_options || []);
        setDitModel(c.selected_dit || "");
        setLmModel(c.selected_lm || "");
      })
      .catch(() => {
        /* generation may be unavailable; selectors just stay empty */
      });
  }, [open]);

  const handlePerformanceModeChange = (mode: PerformanceMode) => {
    setPerformanceMode(mode);
    const hasDit = (name: string) => ditOptions.some((o) => o.name === name);
    const hasLm = (name: string) => lmOptions.some((o) => o.name === name);
    if (hasDit("acestep-v15-turbo")) {
      setDitModel("acestep-v15-turbo");
    }
    if (mode === "conservative") {
      setLmModel("none");
    } else if (mode === "standard") {
      setLmModel(hasLm("acestep-5Hz-lm-0.6B") ? "acestep-5Hz-lm-0.6B" : "none");
    } else {
      setLmModel(
        hasLm("acestep-5Hz-lm-1.7B")
          ? "acestep-5Hz-lm-1.7B"
          : hasLm("acestep-5Hz-lm-0.6B")
            ? "acestep-5Hz-lm-0.6B"
            : "none",
      );
    }
  };

  const saveCurrentSettings = async () => {
    const s = await saveSettings({
      default_engine: engine,
      cascade_vocal_split: cascade,
      workspace_dir: workspaceDir,
      migrate_existing_data: migrateExisting,
      cleanup_old_temp_cache: cleanupOldTemp,
      generation_performance_mode: performanceMode,
      ...(ditModel ? { gen_dit_model: ditModel } : {}),
      ...(lmModel ? { gen_lm_model: lmModel } : {}),
      // Only send the key if the user typed a new one.
      ...(newKey ? { lalal_api_key: newKey } : {}),
    });
    setCkptEffective(s.effective_checkpoints_dir);
    setWorkspaceEffective(s.workspace_dir);
    setOutEffective(s.effective_generation_dir);
    setHistEffective(s.effective_history_dir);
    setSepOutEffective(s.effective_separation_dir);
    setTmpEffective(s.effective_acestep_tmp_dir);
    setSvcEffective(s.effective_svc_models_dir);
    setMigrationSummary(s.path_migration_summary || []);
    onSaved();
    return s;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveCurrentSettings();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    try {
      await saveSettings({ lalal_api_key: "" });
      setKeySet(false);
      setKeyMasked("");
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const stopAceService = async () => {
    setStoppingAce(true);
    try {
      await stopGenerationService();
      onSaved();
    } finally {
      setStoppingAce(false);
    }
  };

  const saveAndRestartServices = async () => {
    setRestartingServices(true);
    setServiceMessage("");
    try {
      await saveCurrentSettings();
      const [ace, svc] = await Promise.allSettled([
        restartGenerationService(),
        restartSvcService(),
      ]);
      const messages = [];
      if (ace.status === "fulfilled") {
        messages.push(ace.value.service_up ? "ACE-Step 已重启" : "ACE-Step 正在启动");
      } else {
        messages.push("ACE-Step 重启失败，请查看运行日志");
      }
      if (svc.status === "fulfilled") {
        messages.push(svc.value.service_up ? "SVC 已重启" : "SVC 正在重启");
      } else {
        messages.push("SVC 重启失败，请查看运行日志");
      }
      setServiceMessage(messages.join("；"));
      onSaved();
    } finally {
      setRestartingServices(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="设置"
      width={888}
      contentClassName="flex-1 min-h-0 overflow-hidden"
      extra={tab === "logs" ? undefined : (
        <div className="flex items-center gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-500"
          >
            取消
          </button>
          <button
            onClick={saveAndRestartServices}
            disabled={saving || restartingServices}
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-100 disabled:opacity-50"
          >
            {restartingServices ? "保存并重启中…" : "保存并重启服务"}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || restartingServices}
            className="rounded-lg bg-brand-600 hover:bg-brand-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-white/5 bg-[#1A1A24] px-6 py-4">
          <div className="flex gap-1 rounded-xl bg-[#111116] border border-white/5 p-1">
            <button
              onClick={() => setTab("generation")}
              className={[
                "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition",
                tab === "generation"
                  ? "bg-brand-600 text-white"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5",
              ].join(" ")}
            >
              音乐生成
            </button>
            <button
              onClick={() => setTab("separation")}
              className={[
                "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition",
                tab === "separation"
                  ? "bg-brand-600 text-white"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5",
              ].join(" ")}
            >
              音轨分离
            </button>
            <button
              onClick={() => setTab("svc")}
              className={[
                "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition",
                tab === "svc"
                  ? "bg-brand-600 text-white"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5",
              ].join(" ")}
            >
              SVC 音源
            </button>
            <button
              onClick={() => setTab("logs")}
              className={[
                "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition",
                tab === "logs"
                  ? "bg-brand-600 text-white"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5",
              ].join(" ")}
            >
              运行日志
            </button>
          </div>
        </div>

        <div className={[
          "min-h-0 flex-1 px-6 py-4",
          tab === "logs" ? "overflow-hidden" : "overflow-y-auto",
        ].join(" ")}>
          {(migrationSummary.length > 0 || serviceMessage) && (
            <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
              {serviceMessage && <div>{serviceMessage}</div>}
              {migrationSummary.map((item) => (
                <div key={item}>{item}</div>
              ))}
            </div>
          )}
          <div className={tab === "separation" ? "" : "hidden"}>
            <label className="block text-sm text-gray-300 mb-1">默认分轨引擎</label>
            <Select
              value={engine}
              onChange={setEngine}
              ariaLabel="默认分轨引擎"
              className="mb-4"
              options={[
                { value: "demucs", label: "Demucs（本地 · 免费 · 6 轨）" },
                { value: "lalal", label: "LALAL.AI（云端 · 付费 · 10 轨）" },
              ]}
            />

            <label className="block text-sm text-gray-300 mb-1">LALAL.AI API Key</label>
            {keySet && (
              <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
                <span>已配置：{keyMasked}</span>
                <button onClick={clearKey} className="text-red-400 hover:underline">
                  清除
                </button>
              </div>
            )}
            <input
              type="password"
              value={newKey}
              placeholder={keySet ? "输入新 Key 以替换" : "粘贴你的 LALAL.AI API Key"}
              onChange={(e) => setNewKey(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 mb-1"
            />
            <p className="text-xs text-gray-500 mb-4">
              配置后可选择 LALAL.AI 引擎解锁主唱/伴唱、电/木吉他、合成器、弦乐等全部 10 种分轨。
            </p>

            <p className="text-xs text-gray-500 mb-4">
              分轨结果会保存到工作目录下的 <code>separation/outputs/</code>。当前路径：{sepOutEffective || "未设置"}。
            </p>

            <label className="flex items-start gap-3 rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-3 mb-5 cursor-pointer">
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
                className="mt-0.5 accent-brand-500"
              />
              <span className="text-sm text-gray-200">
                Demucs 级联拆分主唱/伴唱
                <span className="block text-xs text-gray-500 mt-0.5">
                  在本地 Demucs 基础上，用 karaoke 模型把人声进一步拆为主唱与伴唱（需安装
                  audio-separator，首次会下载模型）。
                </span>
              </span>
            </label>
          </div>

          <div className={tab === "generation" ? "" : "hidden"}>
            {(ditOptions.length > 0 || lmOptions.length > 0) && (
              <div className="mb-5">
                <h3 className="text-sm font-semibold text-gray-200 mb-2">音乐生成（ACE-Step）性能模式</h3>
                <div className="mb-4 grid gap-2 md:grid-cols-3">
                  {PERFORMANCE_MODES.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => handlePerformanceModeChange(mode.id)}
                      className={[
                        "rounded-xl border px-3 py-3 text-left transition",
                        performanceMode === mode.id
                          ? "border-brand-500 bg-brand-500/15 text-white"
                          : "border-gray-700 bg-gray-800/60 text-gray-300 hover:border-gray-500",
                      ].join(" ")}
                    >
                      <div className="text-sm font-medium">{mode.title}</div>
                      <div className="mt-1 text-xs text-gray-400">{mode.desc}</div>
                      {mode.warn && <div className="mt-2 text-xs text-amber-300">{mode.warn}</div>}
                    </button>
                  ))}
                </div>

                <h3 className="text-sm font-semibold text-gray-200 mb-2">音乐生成（ACE-Step）模型</h3>

                <label className="block text-sm text-gray-300 mb-1">DiT 模型</label>
                <Select
                  value={ditModel}
                  onChange={setDitModel}
                  ariaLabel="DiT 模型"
                  className="mb-3"
                  options={ditOptions.map((o) => ({
                    value: o.name,
                    label: `${o.label || o.name}${o.recommended ? "（推荐）" : ""}`,
                  }))}
                />

                <label className="block text-sm text-gray-300 mb-1">LM 模型</label>
                <Select
                  value={lmModel}
                  onChange={setLmModel}
                  ariaLabel="LM 模型"
                  className="mb-1"
                  options={lmOptions.map((o) => ({
                    value: o.name,
                    label: `${o.label || o.name}${o.recommended ? "（推荐）" : ""}`,
                  }))}
                />
                <p className="text-xs text-gray-500">
                  根据当前电脑配置推荐。<span className="text-emerald-400">保存后到生成页点「⟳ 重新加载模型」即可生效（会下载/加载新模型，无需重启进程）。</span>
                </p>
              </div>
            )}

            <div className="border-t border-gray-800 pt-4 mb-5">
              <h3 className="text-sm font-semibold text-gray-200 mb-2">工作目录</h3>
              <label className="block text-sm text-gray-300 mb-1">音乐工作目录</label>
              <DirectoryPicker
                value={workspaceDir}
                onChange={setWorkspaceDir}
                placeholder="必须选择一个工作目录"
                title="选择音乐工作目录"
              />
              <p className="text-xs text-gray-500 mb-4">
                生效路径：{workspaceEffective || "未设置"}。保存后会自动创建
                <code> ace/models/</code>、<code>ace/generation/</code>、<code>ace/generation_history/</code>、
                <code>separation/outputs/</code>、<code>svc/models/</code>、<code>uploads/</code>。
                <span className="text-amber-400"> 修改后请点「保存并重启服务」。</span>
              </p>
              <label className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-gray-200">
                <input
                  type="checkbox"
                  checked={migrateExisting}
                  onChange={(e) => setMigrateExisting(e.target.checked)}
                  className="mt-0.5 accent-amber-500"
                />
                <span>
                  目录修改后迁移已有 ACE 模型和 SVC 音源
                  <span className="mt-0.5 block text-xs text-amber-100/80">
                    推荐开启：会把旧目录里的模型、历史歌曲、分轨结果、上传暂存和音源合并到新工作目录，临时缓存不会迁移。
                  </span>
                </span>
              </label>
              <label className="mb-4 flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-gray-200">
                <input
                  type="checkbox"
                  checked={cleanupOldTemp}
                  onChange={(e) => setCleanupOldTemp(e.target.checked)}
                  className="mt-0.5 accent-red-500"
                />
                <span>
                  修改临时缓存目录后清理旧临时缓存
                  <span className="mt-0.5 block text-xs text-red-100/80">
                    只清理旧 ACE-Step 临时缓存目录内内容；模型、音源和历史歌曲不会删除。若旧路径过于宽泛会自动跳过。
                  </span>
                </span>
              </label>

              <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-3 text-xs text-gray-400 space-y-1">
                <div>ACE 模型：{ckptEffective || "未设置"} <span className="text-gray-500">(ace/models/)</span></div>
                <div>ACE 生成缓存：{outEffective || "未设置"} <span className="text-gray-500">(ace/generation/)</span></div>
                <div>ACE 历史歌曲：{histEffective || "未设置"} <span className="text-gray-500">(ace/generation_history/)</span></div>
                <div>分轨输出：{sepOutEffective || "未设置"} <span className="text-gray-500">(separation/outputs/)</span></div>
                <div>上传暂存：{workspaceEffective ? `${workspaceEffective.replace(/\/$/, "")}/uploads` : "未设置"} <span className="text-gray-500">(uploads/)</span></div>
                <div>ACE 临时缓存：{tmpEffective || "未设置"} <span className="text-gray-500">(ace/generation/tmp/)</span></div>
                <div>SVC 音源：{svcEffective || "未设置"} <span className="text-gray-500">(svc/models/)</span></div>
                <div>运行时依赖：{workspaceEffective ? `${workspaceEffective.replace(/\/$/, "")}/vendor` : "未设置"} <span className="text-gray-500">(vendor/ ffmpeg等，自动安装)</span></div>
                <div>ACE 源码包：{workspaceEffective ? `${workspaceEffective.replace(/\/$/, "")}/resources` : "未设置"} <span className="text-gray-500">(resources/ 需放 ACE-Step-1.5-main.zip)</span></div>
              </div>
              <button
                type="button"
                onClick={stopAceService}
                disabled={stoppingAce}
                className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 disabled:opacity-60"
              >
                {stoppingAce ? "正在停止 ACE-Step 服务..." : "仅停止 ACE-Step 服务"}
              </button>
            </div>
          </div>

          <div className={tab === "svc" ? "" : "hidden"}>
            <h3 className="text-sm font-semibold text-gray-200 mb-2">SVC 音源</h3>
            <p className="text-xs text-gray-500">
              SVC 音源会保存到工作目录下的 <code>svc/models/</code>。当前路径：{svcEffective || "未设置"}。
              <span className="text-amber-400">修改工作目录后请点「保存并重启服务」。</span>
            </p>
          </div>

          <div className={tab === "logs" ? "h-full min-h-0" : "hidden"}>
            <RuntimeLogsPanel active={open && tab === "logs"} />
          </div>
        </div>
      </div>
    </Drawer>
  );
}
