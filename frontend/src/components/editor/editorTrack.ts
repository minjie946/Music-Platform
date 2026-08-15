import { stemStreamUrl, generationTrackStreamUrl } from "../../api";
import type { EditTrackSpec, MidiNote } from "../../types";
import { defaultEffects } from "../EffectsPanel";

/** UI-side editable track: an EditTrackSpec plus solo/id/preview and duration. */
export interface EditorTrack extends EditTrackSpec {
  uid: string;
  /** Clips sharing a laneId render in the same lane and share track-level controls. */
  laneId: string;
  solo: boolean;
  /** Stream URL for waveform preview (blob: URL for freshly uploaded tracks). */
  previewUrl: string;
  /** Clip duration in seconds; drives timeline clip width. */
  durationSec: number;
}

let _uidSeq = 0;
export function nextUid(): string {
  _uidSeq += 1;
  return `t${Date.now().toString(36)}_${_uidSeq}`;
}

/** Build an EditorTrack for a separation stem. */
export function stemToEditorTrack(
  jobId: string,
  stem: { stem: string; label_zh: string; duration_sec?: number | null },
): EditorTrack {
  return {
    uid: nextUid(),
    laneId: nextUid(),
    source: "separation",
    job_id: jobId,
    stem_id: stem.stem,
    index: 0,
    upload_name: "",
    label: stem.label_zh || stem.stem,
    gain: 1,
    mute: false,
    solo: false,
    semitones: 0,
    offset_sec: 0,
    clip_start_sec: 0,
    clip_end_sec: 0,
    effects: defaultEffects(),
    durationSec: stem.duration_sec || 0,
    previewUrl: stemStreamUrl(jobId, stem.stem),
  };
}

/** Build an EditorTrack for a generated track. */
export function genToEditorTrack(
  jobId: string,
  index: number,
  label: string,
  previewUrl?: string,
  durationSec?: number | null,
): EditorTrack {
  return {
    uid: nextUid(),
    laneId: nextUid(),
    source: "generation",
    job_id: jobId,
    stem_id: "",
    index,
    upload_name: "",
    label: label || `音轨 ${index}`,
    gain: 1,
    mute: false,
    solo: false,
    semitones: 0,
    offset_sec: 0,
    clip_start_sec: 0,
    clip_end_sec: 0,
    effects: defaultEffects(),
    durationSec: durationSec || 0,
    previewUrl: previewUrl || generationTrackStreamUrl(jobId, index),
  };
}

/** Build a MIDI EditorTrack from generated melody notes. */
export function melodyToEditorTrack(
  label: string,
  program: number,
  notes: MidiNote[],
): EditorTrack {
  const span = notes.reduce((m, n) => Math.max(m, n.start_sec + n.dur_sec), 0);
  return {
    uid: nextUid(),
    laneId: nextUid(),
    source: "midi",
    job_id: "",
    stem_id: "",
    index: 0,
    upload_name: "",
    label: label || "旋律",
    gain: 1,
    mute: false,
    solo: false,
    semitones: 0,
    offset_sec: 0,
    clip_start_sec: 0,
    clip_end_sec: 0,
    effects: defaultEffects(),
    midi: { program, notes },
    durationSec: Math.max(1, span),
    previewUrl: "",
  };
}
