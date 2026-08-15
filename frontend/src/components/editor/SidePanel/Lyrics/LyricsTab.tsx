import { useState } from "react";
import { formatInput } from "../../../../api";
import { ServiceDownNotice, isServiceDownError } from "../ServiceDownNotice";
import { buildVocalLyricsPrompt, isInstrumentalLyrics } from "../lyricsUtils";

/** 歌词标签：自动生成（接 format-input 用 LM 生成/润色）或自定义。 */
export function LyricsTab({ onGoToGenerate }: { onGoToGenerate?: () => void }) {
  const [mode, setMode] = useState<"auto" | "custom">("auto");
  const [topic, setTopic] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceDown, setServiceDown] = useState(false);

  const generate = async () => {
    if (!topic.trim()) return;
    setLoading(true);
    setError(null);
    setServiceDown(false);
    try {
      const res = await formatInput({ prompt: buildVocalLyricsPrompt(topic) });
      if (isInstrumentalLyrics(res.lyrics)) {
        setError("模型生成了器乐版（无歌词）。请把主题写得更偏叙事/情感，或点击重试。");
        if (res.lyrics) {
          setLyrics(res.lyrics);
          setMode("custom");
        }
      } else {
        setLyrics(res.lyrics || "");
        setMode("custom");
      }
    } catch (e: any) {
      if (isServiceDownError(e)) {
        setServiceDown(true);
      } else {
        setError(e?.response?.data?.detail || e?.message || "生成失败");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-gray-200">歌词</h3>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setMode("auto")}
          className={tabCls(mode === "auto")}
        >
          自动生成
        </button>
        <button
          type="button"
          onClick={() => setMode("custom")}
          className={tabCls(mode === "custom")}
        >
          自定义
        </button>
      </div>

      {mode === "auto" ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="输入歌词主题，例如：夏夜的海边"
            rows={4}
            className="w-full resize-none bg-transparent text-sm text-gray-200 outline-none placeholder:text-gray-600"
          />
          {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
          {serviceDown && (
            <ServiceDownNotice onGoToGenerate={onGoToGenerate} className="mt-2" />
          )}
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={generate}
              disabled={loading || !topic.trim()}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs text-white transition hover:bg-brand-500 disabled:opacity-50"
            >
              {loading ? "生成中…" : "✦ 生成歌词"}
            </button>
          </div>
        </div>
      ) : (
        <textarea
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          placeholder="在此输入你的歌词…"
          rows={12}
          className="w-full resize-none rounded-xl border border-white/10 bg-white/[0.02] p-3 text-sm text-gray-200 outline-none placeholder:text-gray-600"
        />
      )}
    </div>
  );
}

function tabCls(active: boolean): string {
  return [
    "h-9 rounded-lg text-sm transition",
    active ? "bg-white/10 text-gray-100" : "text-gray-500 hover:text-gray-300",
  ].join(" ");
}
