import { useState } from "react";
import { VocalMelodyTab } from "./VocalMelody/VocalMelodyTab";
import { LyricsTab } from "./Lyrics/LyricsTab";
import { PlaceholderTab } from "./PlaceholderTab";
import type { EditorTrack } from "../editorTrack";

export type SideTab = "melody" | "lyrics" | "singing" | "harmony" | "assets" | "favorites";

const TABS: { id: SideTab; label: string }[] = [
  { id: "melody", label: "人声旋律" },
  { id: "lyrics", label: "歌词" },
  { id: "singing", label: "智能演唱" },
  { id: "harmony", label: "和声" },
  { id: "assets", label: "素材" },
  { id: "favorites", label: "收藏" },
];

export interface GenerateMelodyOpts {
  backingUid?: string;
  mode: "vocal" | "inspiration";
  syllables?: number;
}

interface Props {
  tracks: EditorTrack[];
  onUploadAudio: (file: File) => void;
  onAddMidi: () => void;
  uploading: boolean;
  onGoToGenerate?: () => void;
  onGenerateMelody?: (opts: GenerateMelodyOpts) => Promise<void>;
}

/** 左侧标签容器：人声旋律 / 歌词 / 智能演唱 / 和声 / 素材 / 收藏。 */
export function SidePanel({
  tracks,
  onUploadAudio,
  onAddMidi,
  uploading,
  onGoToGenerate,
  onGenerateMelody,
}: Props) {
  const [active, setActive] = useState<SideTab>("melody");

  return (
    <aside className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-white/5">
      <div className="flex shrink-0 gap-4 overflow-x-auto border-b border-white/5 px-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t.id)}
            className={[
              "shrink-0 border-b-2 py-3 text-sm transition",
              active === t.id
                ? "border-brand-500 text-gray-100"
                : "border-transparent text-gray-500 hover:text-gray-300",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {active === "melody" && (
          <VocalMelodyTab
            tracks={tracks}
            onGoToGenerate={onGoToGenerate}
            onGenerateMelody={onGenerateMelody}
          />
        )}
        {active === "lyrics" && <LyricsTab onGoToGenerate={onGoToGenerate} />}
        {active === "singing" && (
          <PlaceholderTab title="智能演唱" desc="选择音色与演唱风格，让 AI 演唱你的歌词（后续接入）。" />
        )}
        {active === "harmony" && (
          <PlaceholderTab title="和声" desc="为主旋律自动生成和声声部（后续接入一键叠声引擎）。" />
        )}
        {active === "assets" && (
          <AssetsTab onUploadAudio={onUploadAudio} onAddMidi={onAddMidi} uploading={uploading} />
        )}
        {active === "favorites" && (
          <PlaceholderTab title="收藏" desc="收藏常用音色、预设与片段（后续接入）。" />
        )}
      </div>
    </aside>
  );
}

function AssetsTab({
  onUploadAudio,
  onAddMidi,
  uploading,
}: {
  onUploadAudio: (file: File) => void;
  onAddMidi: () => void;
  uploading: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-gray-200">素材</h3>
      <label
        className={[
          "flex h-11 cursor-pointer items-center justify-center rounded-lg border border-dashed border-white/15 bg-white/[0.02] text-sm transition hover:border-white/30",
          uploading ? "text-gray-500" : "text-gray-300",
        ].join(" ")}
      >
        {uploading ? "上传中…" : "＋ 添加音频文件"}
        <input
          type="file"
          accept="audio/*"
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadAudio(f);
            e.target.value = "";
          }}
        />
      </label>
      <button
        type="button"
        onClick={onAddMidi}
        className="flex h-11 items-center justify-center rounded-lg border border-dashed border-brand-500/40 bg-brand-600/10 text-sm text-brand-200 transition hover:border-brand-500/70 hover:bg-brand-600/20"
      >
        ＋ MIDI 轨（软件音源）
      </button>
    </div>
  );
}
