import { useState } from "react";
import { Select } from "../../../Select";
import { formatInput } from "../../../../api";
import { ServiceDownNotice, isServiceDownError } from "../ServiceDownNotice";
import { buildVocalLyricsPrompt, isInstrumentalLyrics } from "../lyricsUtils";
import type { EditorTrack } from "../../editorTrack";

interface Props {
  tracks: EditorTrack[];
  onGoToGenerate?: () => void;
  onGenerateMelody?: (opts: {
    backingUid?: string;
    mode: "vocal" | "inspiration";
    syllables?: number;
  }) => Promise<void>;
}

type MelodyMode = "vocal" | "inspiration";

/**
 * 人声旋律标签：旋律模式 + 主伴奏选择 + 歌词（自动生成接 format-input / 自定义）。
 * 「生成旋律」用本地引擎：分析伴奏 key/bpm → 生成 MIDI 旋律轨。
 */
export function VocalMelodyTab({ tracks, onGoToGenerate, onGenerateMelody }: Props) {
  const [mode, setMode] = useState<MelodyMode>("vocal");
  const [backingUid, setBackingUid] = useState<string>(tracks[0]?.uid ?? "");
  const [lyricsMode, setLyricsMode] = useState<"auto" | "custom">("auto");
  const [lyricTopic, setLyricTopic] = useState("");
  const [customLyrics, setCustomLyrics] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [serviceDown, setServiceDown] = useState(false);
  const [melodyLoading, setMelodyLoading] = useState(false);
  const [melodyError, setMelodyError] = useState<string | null>(null);

  const backingOptions = tracks.map((t) => ({ value: t.uid, label: t.label }));

  // 「伴奏配人声演唱」按歌词音节数生成音符，使旋律与词大致对齐。
  const countSyllables = (text: string): number => {
    const cleaned = text.replace(/\[.*?\]/g, "").replace(/\s+/g, "");
    return cleaned ? cleaned.length : 0;
  };

  const runGenerateMelody = async () => {
    if (!onGenerateMelody) return;
    setMelodyLoading(true);
    setMelodyError(null);
    try {
      const syllables =
        mode === "vocal" && customLyrics.trim()
          ? countSyllables(customLyrics) || undefined
          : undefined;
      await onGenerateMelody({ backingUid: backingUid || undefined, mode, syllables });
    } catch (e: any) {
      setMelodyError(e?.response?.data?.detail || e?.message || "旋律生成失败");
    } finally {
      setMelodyLoading(false);
    }
  };

  const generateLyrics = async () => {
    if (!lyricTopic.trim()) return;
    setGenLoading(true);
    setGenError(null);
    setServiceDown(false);
    try {
      const res = await formatInput({ prompt: buildVocalLyricsPrompt(lyricTopic) });
      if (isInstrumentalLyrics(res.lyrics)) {
        setGenError("模型生成了器乐版（无歌词）。请把主题写得更偏叙事/情感，或点击重试。");
        if (res.lyrics) {
          setCustomLyrics(res.lyrics);
          setLyricsMode("custom");
        }
      } else {
        setCustomLyrics(res.lyrics || "");
        setLyricsMode("custom");
      }
    } catch (e: any) {
      if (isServiceDownError(e)) {
        setServiceDown(true);
      } else {
        setGenError(e?.response?.data?.detail || e?.message || "生成失败");
      }
    } finally {
      setGenLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* 旋律模式 */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-200">旋律模式</h3>
        <div className="flex flex-col gap-2">
          <ModeCard
            active={mode === "vocal"}
            onClick={() => setMode("vocal")}
            title="伴奏配人声演唱"
            badge="推荐"
            desc="为伴奏生成人声词曲演唱示例 (TemPolor v4.1a)"
          />
          <ModeCard
            active={mode === "inspiration"}
            onClick={() => setMode("inspiration")}
            title="伴奏配旋律灵感"
            desc="为伴奏配上哼唱旋律灵感"
          />
        </div>
      </section>

      {/* 主伴奏音轨 */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-200">主伴奏音轨</h3>
        {backingOptions.length > 0 ? (
          <Select
            value={backingUid}
            onChange={setBackingUid}
            options={backingOptions}
            ariaLabel="选择主伴奏音轨"
          />
        ) : (
          <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm text-gray-500">
            暂无音轨，请先在「素材」添加伴奏。
          </div>
        )}
      </section>

      {/* 歌词 */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-200">歌词</h3>
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setLyricsMode("auto")}
            className={tabBtn(lyricsMode === "auto")}
          >
            自动生成
          </button>
          <button
            type="button"
            onClick={() => setLyricsMode("custom")}
            className={tabBtn(lyricsMode === "custom")}
          >
            自定义歌词
          </button>
        </div>

        {lyricsMode === "auto" ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <textarea
              value={lyricTopic}
              onChange={(e) => setLyricTopic(e.target.value)}
              placeholder="输入你的歌词主题，例如：毕业的夏天"
              rows={4}
              className="w-full resize-none bg-transparent text-sm text-gray-200 outline-none placeholder:text-gray-600"
            />
            {genError && <p className="mt-1 text-xs text-red-400">{genError}</p>}
            {serviceDown && (
              <ServiceDownNotice onGoToGenerate={onGoToGenerate} className="mt-2" />
            )}
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={generateLyrics}
                disabled={genLoading || !lyricTopic.trim()}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs text-white transition hover:bg-brand-500 disabled:opacity-50"
              >
                {genLoading ? "生成中…" : "✦ 生成歌词"}
              </button>
            </div>
          </div>
        ) : (
          <textarea
            value={customLyrics}
            onChange={(e) => setCustomLyrics(e.target.value)}
            placeholder="在此粘贴或输入你的歌词…"
            rows={6}
            className="w-full resize-none rounded-xl border border-white/10 bg-white/[0.02] p-3 text-sm text-gray-200 outline-none placeholder:text-gray-600"
          />
        )}
      </section>

      {mode === "vocal" && (
        <p className="-mt-2 text-[11px] leading-relaxed text-gray-500">
          说明：本地生成的是<b>人声旋律线</b>（用合唱音色演奏），不是逐字演唱的真人歌声；
          填写自定义歌词可让旋律按音节数对齐。
        </p>
      )}

      {melodyError && <p className="text-xs text-red-400">{melodyError}</p>}

      <button
        type="button"
        onClick={runGenerateMelody}
        disabled={melodyLoading || !onGenerateMelody || backingOptions.length === 0}
        className="h-11 w-full rounded-xl bg-brand-600 text-sm font-medium text-white transition hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-gray-400"
        title={backingOptions.length === 0 ? "请先添加伴奏音轨" : "按伴奏调性/速度生成旋律"}
      >
        {melodyLoading ? "生成中…" : "✦ 生成旋律"}
      </button>
    </div>
  );
}

function tabBtn(active: boolean): string {
  return [
    "h-9 rounded-lg text-sm transition",
    active ? "bg-white/10 text-gray-100" : "text-gray-500 hover:text-gray-300",
  ].join(" ");
}

function ModeCard({
  active,
  onClick,
  title,
  badge,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  badge?: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-xl border p-3 text-left transition",
        active
          ? "border-brand-500 bg-brand-600/10"
          : "border-white/10 bg-white/[0.02] hover:border-white/20",
      ].join(" ")}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-100">{title}</span>
        {badge && (
          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">{desc}</p>
    </button>
  );
}
