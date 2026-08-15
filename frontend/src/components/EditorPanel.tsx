import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import {
  createEdit,
  editEventsUrl,
  editResultUrl,
  fetchEditJob,
  generateMelody,
  uploadEditTrack,
} from "../api";
import type { EditRequest, JobStatus, MidiNote, DockEffects } from "../types";
import { useEventSourceJob } from "../hooks/useEventSourceJob";
import { useTonePlayback } from "../hooks/useTonePlayback";
import { useToast } from "./AppFeedback";
import { useDownloadCenter } from "./DownloadCenter";
import { Timeline } from "./Timeline";
import { PianoRoll } from "./PianoRoll";
import { defaultEffects } from "./EffectsPanel";
import { EditorTopBar, type TransportState } from "./editor/TopBar/EditorTopBar";
import { SidePanel } from "./editor/SidePanel/SidePanel";
import { EffectsDock } from "./editor/EffectsDock/EffectsDock";
import { defaultDockEffects } from "./editor/EffectsDock/EffectsDock";
import { useEditorHistory } from "./editor/hooks/useEditorHistory";
import {
  type EditorTrack,
  nextUid,
  stemToEditorTrack,
  genToEditorTrack,
  melodyToEditorTrack,
} from "./editor/editorTrack";

// 复用旧的导入路径：其它组件仍从 "./EditorPanel" 取类型与工厂函数。
export type { EditorTrack };
export { stemToEditorTrack, genToEditorTrack };

interface Props {
  initialTracks: EditorTrack[];
  onGoToGenerate?: () => void;
}

const PX_PER_SEC_DEFAULT = 40;

export function EditorPanel({ initialTracks, onGoToGenerate }: Props) {
  const { showToast, toastNode } = useToast();
  const { startDownload } = useDownloadCenter();

  // 轨道状态带历史栈（撤销/重做）。
  const {
    state: tracks,
    set: setTracks,
    reset: resetTracks,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useEditorHistory<EditorTrack[]>(initialTracks);

  const [tempo] = useState(1);
  const [masterSemitones] = useState(0);
  const [masterVolume, setMasterVolume] = useState(1);
  const [format] = useState<"wav" | "mp3">("wav");
  const [title] = useState("");
  const [job, setJob] = useState<JobStatus | null>(null);
  const [exporting, setExporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pxPerSec] = useState(PX_PER_SEC_DEFAULT);
  const [pianoRollUid, setPianoRollUid] = useState<string | null>(null);
  const [selectedLane] = useState<string | null>(null);

  // 顶栏乐理信息（阶段1：展示 + 本地状态；阶段2 与生成参数打通）。
  const [bpm, setBpm] = useState(120);
  const [timeSig, setTimeSig] = useState("4/4");
  const [keyName, setKeyName] = useState("C 大调");

  useEffect(() => {
    resetTracks(initialTracks);
    setJob(null);
  }, [initialTracks, resetTracks]);

  const wsMap = useRef<Map<string, WaveSurfer>>(new Map());
  const register = useCallback((uid: string, ws: WaveSurfer | null) => {
    if (ws) wsMap.current.set(uid, ws);
    else wsMap.current.delete(uid);
  }, []);

  const anySolo = tracks.some((t) => t.solo);
  const isEffectivelyMuted = useCallback(
    (t: EditorTrack) => t.mute || (anySolo && !t.solo),
    [anySolo],
  );

  const visibleLen = useCallback((t: EditorTrack) => {
    const end = t.clip_end_sec > 0 ? t.clip_end_sec : t.durationSec || 0;
    return Math.max(0, end - t.clip_start_sec);
  }, []);

  const timelineEnd = useCallback(
    () => tracks.reduce((m, t) => Math.max(m, t.offset_sec + visibleLen(t)), 0),
    [tracks, visibleLen],
  );

  const tone = useTonePlayback(tracks, isEffectivelyMuted);
  const { playing: allPlaying, currentSec, ready: playReady, loadError } = tone;

  useEffect(() => {
    if (loadError) showToast(loadError, "error");
  }, [loadError, showToast]);

  // 主音量接 Tone 总线。
  useEffect(() => {
    tone.setMasterVolume(masterVolume);
  }, [masterVolume, tone]);

  const togglePlayAll = useCallback(() => {
    if (allPlaying) {
      tone.pause();
      return;
    }
    if (!playReady) return;
    const end = timelineEnd();
    tone.play(currentSec >= end ? 0 : currentSec);
  }, [allPlaying, currentSec, playReady, timelineEnd, tone]);

  const onSeek = useCallback((sec: number) => tone.seek(sec), [tone]);

  const patchTrack = useCallback(
    (uid: string, patch: Partial<EditorTrack>) => {
      setTracks((prev) => prev.map((t) => (t.uid === uid ? { ...t, ...patch } : t)));
    },
    [setTracks],
  );
  const patchLane = useCallback(
    (laneId: string, patch: Partial<EditorTrack>) => {
      setTracks((prev) => prev.map((t) => (t.laneId === laneId ? { ...t, ...patch } : t)));
    },
    [setTracks],
  );
  const setOffset = useCallback(
    (uid: string, offsetSec: number) => {
      setTracks((prev) => prev.map((t) => (t.uid === uid ? { ...t, offset_sec: offsetSec } : t)));
    },
    [setTracks],
  );
  const removeLane = useCallback(
    (laneId: string) => {
      setTracks((prev) => prev.filter((t) => t.laneId !== laneId));
    },
    [setTracks],
  );

  const addMidiTrack = useCallback(() => {
    setTracks((prev) => [
      ...prev,
      {
        uid: nextUid(),
        laneId: nextUid(),
        source: "midi",
        job_id: "",
        stem_id: "",
        index: 0,
        upload_name: "",
        label: "MIDI 乐器",
        gain: 1,
        mute: false,
        solo: false,
        semitones: 0,
        offset_sec: 0,
        clip_start_sec: 0,
        clip_end_sec: 0,
        effects: defaultEffects(),
        midi: { program: 0, notes: [] },
        durationSec: 4,
        previewUrl: "",
      },
    ]);
    showToast("已添加 MIDI 轨（导出时用软件音源合成）", "success");
  }, [setTracks, showToast]);

  const updateMidiNotes = useCallback(
    (uid: string, notes: MidiNote[]) => {
      const span = notes.reduce((m, n) => Math.max(m, n.start_sec + n.dur_sec), 0);
      setTracks((prev) =>
        prev.map((t) =>
          t.uid === uid
            ? {
                ...t,
                midi: { program: t.midi?.program ?? 0, notes },
                durationSec: Math.max(1, span),
              }
            : t,
        ),
      );
    },
    [setTracks],
  );

  // 旋律生成：可选按某条伴奏轨分析 key/bpm，生成 MIDI 旋律作为新轨。
  const handleGenerateMelody = useCallback(
    async (opts: {
      backingUid?: string;
      mode: "vocal" | "inspiration";
      syllables?: number;
    }) => {
      const backing = opts.backingUid
        ? tracks.find((t) => t.uid === opts.backingUid)
        : undefined;
      const durationSec = backing ? Math.max(4, visibleLen(backing)) : 16;
      // 「伴奏配人声演唱」用人声音色(合唱)，「旋律灵感」用长笛/口哨类。
      const program = opts.mode === "vocal" ? 52 : 73;
      const backingSpec = backing
        ? {
            source: backing.source,
            job_id: backing.job_id,
            stem_id: backing.stem_id,
            index: backing.index,
            upload_name: backing.upload_name,
            label: backing.label,
            gain: backing.gain,
            mute: false,
            semitones: backing.semitones,
            offset_sec: backing.offset_sec,
            clip_start_sec: backing.clip_start_sec,
            clip_end_sec: backing.clip_end_sec,
            effects: backing.effects,
          }
        : null;
      const res = await generateMelody({
        backing: backingSpec as any,
        duration_sec: durationSec,
        syllables: opts.syllables,
        program,
      });
      const label = opts.mode === "vocal" ? "人声旋律" : "旋律灵感";
      const track = melodyToEditorTrack(`${label}(${res.key_name})`, res.program, res.notes);
      setTracks((prev) => [...prev, track]);
      setBpm(Math.round(res.bpm));
      showToast(`已生成${label}：${res.key_name} / ${Math.round(res.bpm)} BPM`, "success");
    },
    [tracks, visibleLen, setTracks, showToast],
  );

  const duplicateClip = useCallback(
    (uid: string) => {
      setTracks((prev) => {
        const src = prev.find((t) => t.uid === uid);
        if (!src) return prev;
        const len =
          src.clip_end_sec > 0
            ? src.clip_end_sec - src.clip_start_sec
            : (src.durationSec || 0) - src.clip_start_sec;
        const copy: EditorTrack = { ...src, uid: nextUid(), offset_sec: src.offset_sec + Math.max(0, len) };
        return [...prev, copy];
      });
    },
    [setTracks],
  );

  const splitClip = useCallback(
    (uid: string) => {
      setTracks((prev) => {
        const src = prev.find((t) => t.uid === uid);
        if (!src) return prev;
        const end = src.clip_end_sec > 0 ? src.clip_end_sec : src.durationSec || 0;
        const visEnd = src.offset_sec + (end - src.clip_start_sec);
        if (!(currentSec > src.offset_sec && currentSec < visEnd)) {
          showToast("请先把播放头移到该片段中间再分割", "error");
          return prev;
        }
        const cut = src.clip_start_sec + (currentSec - src.offset_sec);
        const left: EditorTrack = { ...src, clip_end_sec: cut };
        const right: EditorTrack = {
          ...src,
          uid: nextUid(),
          clip_start_sec: cut,
          clip_end_sec: end,
          offset_sec: currentSec,
        };
        const idx = prev.findIndex((t) => t.uid === uid);
        const next = [...prev];
        next.splice(idx, 1, left, right);
        return next;
      });
    },
    [currentSec, setTracks, showToast],
  );

  const controller = useEventSourceJob(editEventsUrl, fetchEditJob, (data) => {
    setJob(data);
    if (data.state === "done") {
      setExporting(false);
      const track = data.tracks?.[0];
      const name = track?.filename || `${title || "mix"}.${format}`;
      void startDownload(editResultUrl(data.id, true), name);
      showToast("混音导出完成", "success");
    } else if (data.state === "failed") {
      setExporting(false);
      showToast(data.error || "混音失败", "error");
    }
  });
  useEffect(() => controller.cleanup, [controller]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const { upload_name, label } = await uploadEditTrack(file);
      const objectUrl = URL.createObjectURL(file);
      let durationSec = 0;
      try {
        durationSec = await new Promise<number>((resolve) => {
          const audio = new Audio();
          audio.preload = "metadata";
          audio.onloadedmetadata = () => resolve(audio.duration || 0);
          audio.onerror = () => resolve(0);
          audio.src = objectUrl;
        });
      } catch {
        durationSec = 0;
      }
      setTracks((prev) => [
        ...prev,
        {
          uid: nextUid(),
          laneId: nextUid(),
          source: "upload",
          job_id: "",
          stem_id: "",
          index: 0,
          upload_name,
          label,
          gain: 1,
          mute: false,
          solo: false,
          semitones: 0,
          offset_sec: 0,
          clip_start_sec: 0,
          clip_end_sec: 0,
          effects: defaultEffects(),
          durationSec,
          previewUrl: objectUrl,
        },
      ]);
      showToast(`已添加音轨：${label}`, "success");
    } catch (e: any) {
      showToast(e?.response?.data?.detail || e?.message || "上传失败", "error");
    } finally {
      setUploading(false);
    }
  };

  const handleExport = async () => {
    const active = tracks.filter((t) => !isEffectivelyMuted(t));
    if (active.length === 0) {
      showToast("没有可混音的音轨（全部静音）", "error");
      return;
    }
    tone.pause();
    const req: EditRequest = {
      tracks: active.map((t) => ({
        source: t.source,
        job_id: t.job_id,
        stem_id: t.stem_id,
        index: t.index,
        upload_name: t.upload_name,
        label: t.label,
        gain: t.gain,
        mute: false,
        pan: t.pan ?? 0,
        semitones: t.semitones,
        offset_sec: t.offset_sec,
        clip_start_sec: t.clip_start_sec,
        clip_end_sec: t.clip_end_sec,
        effects: t.effects,
        midi: t.midi,
      })),
      tempo,
      master_semitones: masterSemitones,
      output_format: format,
      title: title.trim(),
    };
    setExporting(true);
    setJob(null);
    try {
      const created = await createEdit(req);
      setJob(created);
      controller.subscribe(created.id);
    } catch (e: any) {
      setExporting(false);
      showToast(e?.response?.data?.detail || e?.message || "创建混音任务失败", "error");
    }
  };

  const handleSave = useCallback(() => {
    try {
      const snapshot = { tracks, tempo, masterSemitones, bpm, timeSig, keyName, title };
      localStorage.setItem("editor.project", JSON.stringify(snapshot));
      showToast("工程已保存到本地", "success");
    } catch {
      showToast("保存失败", "error");
    }
  }, [tracks, tempo, masterSemitones, bpm, timeSig, keyName, title, showToast]);

  const running = exporting || job?.state === "queued" || job?.state === "running";
  const hasTracks = tracks.length > 0;
  const pianoRollTrack = pianoRollUid ? tracks.find((t) => t.uid === pianoRollUid) : undefined;
  const selectedTrack = useMemo(
    () => tracks.find((t) => t.laneId === (selectedLane ?? tracks[0]?.laneId)),
    [tracks, selectedLane],
  );

  const transport: TransportState = {
    playing: allPlaying,
    currentSec,
    bpm,
    timeSig,
    keyName,
    masterVolume,
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {toastNode}

      <EditorTopBar
        state={transport}
        canPlay={playReady}
        onTogglePlay={togglePlayAll}
        onSeekStart={() => onSeek(0)}
        onBpmChange={setBpm}
        onTimeSigChange={setTimeSig}
        onKeyChange={setKeyName}
        onMasterVolume={setMasterVolume}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onSave={handleSave}
        onExport={handleExport}
        exporting={running}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SidePanel
          tracks={tracks}
          onUploadAudio={(f) => void handleUpload(f)}
          onAddMidi={addMidiTrack}
          uploading={uploading}
          onGoToGenerate={onGoToGenerate}
          onGenerateMelody={handleGenerateMelody}
        />

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {!hasTracks ? (
              <div className="rounded-2xl border border-white/5 bg-[#111116] p-10 text-center text-sm text-gray-500">
                还没有音轨。请从「音轨分离」或「音乐生成」的结果点击「→ 编辑」进入，或在左侧「素材」上传音频。
              </div>
            ) : (
              <Timeline
                tracks={tracks}
                pxPerSec={pxPerSec}
                currentSec={currentSec}
                isEffectivelyMuted={isEffectivelyMuted}
                onOffsetChange={setOffset}
                onPatch={patchTrack}
                onPatchLane={patchLane}
                onRemoveLane={removeLane}
                onDuplicate={duplicateClip}
                onSplit={splitClip}
                onSeek={onSeek}
                onEditMidi={setPianoRollUid}
                register={register}
              />
            )}
          </div>

          {hasTracks && (
            <EffectsDockBridge
              track={selectedTrack}
              onPatch={(patch) => selectedTrack && patchLane(selectedTrack.laneId, patch)}
            />
          )}
        </section>
      </div>

      {pianoRollTrack && (
        <PianoRoll
          notes={pianoRollTrack.midi?.notes ?? []}
          instrumentLabel={pianoRollTrack.label}
          onChange={(notes) => updateMidiNotes(pianoRollTrack.uid, notes)}
          onClose={() => setPianoRollUid(null)}
        />
      )}
    </main>
  );
}

/**
 * 桥接底部 Dock 与轨道 effects：dock 参数存进 track.effects.dock，
 * useTonePlayback 已把它接到 Tone 实时链（人声效果器/混响距离）。
 */
function EffectsDockBridge({
  track,
  onPatch,
}: {
  track?: EditorTrack;
  onPatch: (patch: Partial<EditorTrack>) => void;
}) {
  const value: DockEffects = track?.effects?.dock ?? defaultDockEffects();
  return (
    <EffectsDock
      trackLabel={track?.label ?? ""}
      effects={value}
      onChange={(patch) => {
        if (!track) return;
        const nextDock = { ...value, ...patch };
        onPatch({ effects: { ...track.effects, dock: nextDock } });
      }}
    />
  );
}
