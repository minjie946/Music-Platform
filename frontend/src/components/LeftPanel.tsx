import type { EngineCapabilities } from "../types";
import { UploadDropzone } from "./UploadDropzone";

interface Props {
  file: File | null;
  onFile: (f: File) => void;
  engine: string;
  onEngineChange: (e: string) => void;
  outputFormat: string;
  onOutputFormatChange: (f: string) => void;
  capabilities: EngineCapabilities | undefined;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onSubmit: () => void;
  submitting: boolean;
  canSubmit: boolean;
}

export function LeftPanel({
  file,
  onFile,
  engine,
  onEngineChange,
  outputFormat,
  onOutputFormatChange,
  capabilities,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  onSubmit,
  submitting,
  canSubmit,
}: Props) {
  const stems = capabilities?.stems ?? [];

  return (
    <div className="flex flex-col gap-5 h-full">
      <section>
        <h2 className="text-sm font-semibold text-gray-300 mb-2">1. 上传音乐</h2>
        <UploadDropzone file={file} onFile={onFile} disabled={submitting} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-300 mb-2">2. 分轨引擎</h2>
        <div className="flex gap-2">
          {[
            { id: "demucs", label: "Demucs（本地·免费）" },
            { id: "lalal", label: "LALAL.AI（10轨）" },
          ].map((opt) => (
            <button
              key={opt.id}
              onClick={() => onEngineChange(opt.id)}
              disabled={submitting}
              className={[
                "flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition",
                engine === opt.id
                  ? "border-brand-500 bg-brand-600/30 text-white"
                  : "border-gray-700 text-gray-300 hover:border-gray-500",
              ].join(" ")}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {capabilities && (
          <p className="text-xs text-gray-500 mt-2">
            当前生效引擎：<span className="text-gray-300">{capabilities.engine}</span>
            {engine === "lalal" && capabilities.engine !== "lalal" && (
              <span className="text-amber-400">（未配置 API Key，已回退 Demucs）</span>
            )}
          </p>
        )}
      </section>

      <section className="flex-1 min-h-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-300">3. 选择分轨类型</h2>
          <div className="flex gap-2 text-xs">
            <button onClick={onSelectAll} className="text-brand-400 hover:underline">
              全选
            </button>
            <button onClick={onClear} className="text-gray-400 hover:underline">
              清空
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 overflow-y-auto pr-1">
          {stems.map((s) => {
            const checked = selected.has(s.id);
            return (
              <label
                key={s.id}
                title={s.supported ? s.label_en : s.note}
                className={[
                  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
                  !s.supported
                    ? "border-gray-800 bg-gray-900/40 text-gray-600 cursor-not-allowed"
                    : checked
                      ? "border-brand-500 bg-brand-600/20 text-white cursor-pointer"
                      : "border-gray-700 text-gray-300 hover:border-gray-500 cursor-pointer",
                ].join(" ")}
              >
                <input
                  type="checkbox"
                  disabled={!s.supported || submitting}
                  checked={checked}
                  onChange={() => onToggle(s.id)}
                  className="accent-brand-500"
                />
                <span className="truncate">{s.label_zh}</span>
                {!s.supported && <span className="ml-auto text-[10px]">不可用</span>}
              </label>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-300 mb-2">4. 输出格式</h2>
        <div className="flex gap-2">
          {[
            { id: "wav", label: "WAV（无损）" },
            { id: "mp3", label: "MP3（体积小）" },
          ].map((opt) => (
            <button
              key={opt.id}
              onClick={() => onOutputFormatChange(opt.id)}
              disabled={submitting}
              className={[
                "flex-1 rounded-lg px-3 py-2 text-xs font-medium border transition",
                outputFormat === opt.id
                  ? "border-brand-500 bg-brand-600/30 text-white"
                  : "border-gray-700 text-gray-300 hover:border-gray-500",
              ].join(" ")}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <button
        onClick={onSubmit}
        disabled={!canSubmit || submitting}
        className={[
          "rounded-xl py-3 font-semibold transition",
          canSubmit && !submitting
            ? "bg-brand-600 hover:bg-brand-500 text-white"
            : "bg-gray-800 text-gray-500 cursor-not-allowed",
        ].join(" ")}
      >
        {submitting ? "处理中…" : "开始分轨"}
      </button>
    </div>
  );
}
