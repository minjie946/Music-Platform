import { useCallback, useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import type { EditorTrack } from "../components/EditorPanel";

/** Sample-accurate multi-track preview with per-lane realtime effects (Tone.js). */
export interface TonePlayback {
    ready: boolean;
    playing: boolean;
    currentSec: number;
    play: (from: number) => void;
    pause: () => void;
    seek: (sec: number) => void;
    setMasterVolume: (v: number) => void;
    loadError: string | null;
}

interface LaneChain {
    input: Tone.PitchShift;
    eq: Tone.EQ3;
    comp: Tone.Compressor;
    chorus: Tone.Chorus;
    reverb: Tone.Reverb;
    delay: Tone.FeedbackDelay;
    channel: Tone.Channel;
}

const LOOKAHEAD = 0.08; // s, scheduling headroom so all clips share one anchor

/** 混响“距离”映射到 decay（秒）：越远 decay 越长、湿度略增。 */
function reverbDecayForDistance(distance: string): number {
    if (distance === "far") return 4.0;
    if (distance === "mid") return 2.5;
    return 1.2; // near
}

function visibleLen(t: EditorTrack): number {
    const end = t.clip_end_sec > 0 ? t.clip_end_sec : t.durationSec || 0;
    return Math.max(0, end - t.clip_start_sec);
}

function layoutSignature(tracks: EditorTrack[], isMuted: (t: EditorTrack) => boolean): string {
    return tracks
        .map((t) => `${t.uid}:${t.offset_sec}:${t.clip_start_sec}:${t.clip_end_sec}:${isMuted(t) ? 1 : 0}`)
        .join("|");
}

export function useTonePlayback(
    tracks: EditorTrack[],
    isMuted: (t: EditorTrack) => boolean,
): TonePlayback {
    const [ready, setReady] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [currentSec, setCurrentSec] = useState(0);
    const [loadError, setLoadError] = useState<string | null>(null);

    const buffers = useRef<Map<string, Tone.ToneAudioBuffer>>(new Map());
    const lanes = useRef<Map<string, LaneChain>>(new Map());
    const players = useRef<Map<string, Tone.Player>>(new Map());
    // 主总线：所有 lane 汇入此处再到 destination，用于主音量控制。
    const masterRef = useRef<Tone.Gain | null>(null);
    const getMaster = useCallback(() => {
        if (!masterRef.current) {
            masterRef.current = new Tone.Gain(1).toDestination();
        }
        return masterRef.current;
    }, []);
    const setMasterVolume = useCallback((v: number) => {
        getMaster().gain.rampTo(Math.max(0, Math.min(1, v)), 0.05);
    }, [getMaster]);
    // One PolySynth per MIDI lane, connected to that lane's effect-chain input.
    // Rebuilt on each schedule pass so previously-scheduled notes are cancelled.
    const synths = useRef<Map<string, Tone.PolySynth>>(new Map());
    const rafRef = useRef<number | null>(null);
    const anchorRef = useRef<{ ctxStart: number; from: number } | null>(null);
    const playingRef = useRef(false);

    // Always read the latest layout from a ref inside non-reactive callbacks.
    const tracksRef = useRef<EditorTrack[]>(tracks);
    const isMutedRef = useRef(isMuted);
    useEffect(() => {
        tracksRef.current = tracks;
        isMutedRef.current = isMuted;
    });

    const timelineEnd = useCallback(
        () => tracksRef.current.reduce((m, t) => Math.max(m, t.offset_sec + visibleLen(t)), 0),
        [],
    );

    // ---- Buffer loading (keyed by distinct previewUrl) ----
    const urlKey = tracks
        .map((t) => t.previewUrl)
        .filter(Boolean)
        .sort()
        .join("|");
    useEffect(() => {
        const wanted = new Set(tracks.map((t) => t.previewUrl).filter(Boolean));
        // Dispose buffers no longer referenced.
        for (const [url, buf] of buffers.current) {
            if (!wanted.has(url)) {
                buf.dispose();
                buffers.current.delete(url);
            }
        }
        let cancelled = false;
        const pending: Promise<void>[] = [];
        for (const url of wanted) {
            if (buffers.current.has(url)) continue;
            const buf = new Tone.ToneAudioBuffer();
            buffers.current.set(url, buf);
            pending.push(
                buf
                    .load(url)
                    .then(() => undefined)
                    .catch((e) => {
                        if (!cancelled) setLoadError(`音频加载失败：${(e as Error)?.message || url}`);
                    }),
            );
        }
        setReady(false);
        Promise.allSettled(pending).then(() => {
            if (!cancelled) {
                const allLoaded = [...wanted].every((u) => buffers.current.get(u)?.loaded);
                setReady(allLoaded);
            }
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [urlKey]);

    // ---- Lane effect chains (keyed by distinct laneId) ----
    const laneKey = [...new Set(tracks.map((t) => t.laneId))].sort().join("|");
    useEffect(() => {
        const wanted = new Set(tracks.map((t) => t.laneId));
        for (const [id, chain] of lanes.current) {
            if (!wanted.has(id)) {
                Object.values(chain).forEach((n) => n.dispose());
                lanes.current.delete(id);
            }
        }
        for (const id of wanted) {
            if (lanes.current.has(id)) continue;
            const input = new Tone.PitchShift({ pitch: 0 });
            const eq = new Tone.EQ3({ low: 0, mid: 0, high: 0, lowFrequency: 250, highFrequency: 2500 });
            const comp = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.02, release: 0.25 });
            // 人声效果器（一键叠声/加宽）用 Chorus 近似：默认 wet=0（关闭）。
            const chorus = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0 }).start();
            const reverb = new Tone.Reverb({ decay: 2.2, wet: 0 });
            const delay = new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.3, wet: 0 });
            const channel = new Tone.Channel({ volume: 0, pan: 0 });
            input.chain(eq, comp, chorus, reverb, delay, channel, getMaster());
            lanes.current.set(id, { input, eq, comp, chorus, reverb, delay, channel });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [laneKey]);

    // ---- Players (keyed by distinct clip uid, gated by buffer readiness) ----
    const playerKey = tracks.map((t) => `${t.uid}@${t.previewUrl}`).sort().join("|");
    useEffect(() => {
        const wanted = new Map(tracks.map((t) => [t.uid, t]));
        for (const [uid, p] of players.current) {
            if (!wanted.has(uid)) {
                p.dispose();
                players.current.delete(uid);
            }
        }
        for (const [uid, t] of wanted) {
            if (players.current.has(uid)) continue;
            const buf = buffers.current.get(t.previewUrl);
            const lane = lanes.current.get(t.laneId);
            if (!buf || !buf.loaded || !lane) continue;
            const player = new Tone.Player(buf);
            player.connect(lane.input);
            players.current.set(uid, player);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playerKey, ready, laneKey]);

    // ---- Live parameter sync (effects, gain, mute) on every tracks change ----
    useEffect(() => {
        // Apply lane params from the lane's representative (first) clip.
        const repByLane = new Map<string, EditorTrack>();
        for (const t of tracks) if (!repByLane.has(t.laneId)) repByLane.set(t.laneId, t);
        for (const [laneId, t] of repByLane) {
            const chain = lanes.current.get(laneId);
            if (!chain) continue;
            const fx = t.effects;
            // EQ
            chain.eq.low.value = fx.eq_enabled ? fx.eq_low_db : 0;
            chain.eq.mid.value = fx.eq_enabled ? fx.eq_mid_db : 0;
            chain.eq.high.value = fx.eq_enabled ? fx.eq_high_db : 0;
            // Compressor
            if (fx.comp_enabled) {
                const amt = Math.max(0, Math.min(1, fx.comp_amount));
                chain.comp.ratio.value = 2 + amt * 6;
                chain.comp.threshold.value = 20 * Math.log10(Math.max(0.05, 0.5 - amt * 0.4));
            } else {
                chain.comp.ratio.value = 1;
                chain.comp.threshold.value = 0;
            }
            // Reverb (wet only; decay fixed)
            chain.reverb.wet.value = fx.reverb_enabled ? Math.max(0, Math.min(1, fx.reverb_amount)) : 0;
            // Delay
            if (fx.delay_enabled) {
                chain.delay.delayTime.value = Math.max(0.02, fx.delay_ms / 1000);
                chain.delay.feedback.value = Math.max(0, Math.min(0.95, fx.delay_feedback));
                chain.delay.wet.value = 0.5;
            } else {
                chain.delay.wet.value = 0;
            }

            // ---- 底部 Dock 效果（人声效果器/Autotune/混响距离）实时接线 ----
            const dock = fx.dock;
            if (dock) {
                // 人声效果器：一键叠声/加宽 -> Chorus wet 随强度。
                if (dock.vocalFx.enabled) {
                    const w = Math.max(0, Math.min(1, dock.vocalFx.intensity / 100));
                    chain.chorus.wet.value = w;
                    // 加宽预设扩大立体声深度。
                    chain.chorus.depth = dock.vocalFx.preset === "wide" ? 0.9 : 0.7;
                } else {
                    chain.chorus.wet.value = 0;
                }
                // 混响：距离 -> decay，强度 -> wet（覆盖旧的通用混响 wet）。
                if (dock.reverb.enabled) {
                    const targetDecay = reverbDecayForDistance(dock.reverb.distance);
                    // Reverb.decay 是构造属性，改动需重建脉冲；仅在明显变化时更新。
                    if (Math.abs((chain.reverb.decay as number) - targetDecay) > 0.05) {
                        chain.reverb.decay = targetDecay;
                    }
                    chain.reverb.wet.value = Math.max(0, Math.min(1, dock.reverb.amount / 100));
                }
                // Autotune：实时音高校正较重，放阶段3后端渲染；此处不接线。
            } else {
                chain.chorus.wet.value = 0;
            }

            // Pitch (per-lane semitones)
            chain.input.pitch = t.semitones;
            // 声像
            chain.channel.pan.value = Math.max(-1, Math.min(1, t.pan ?? 0));
            // Gain / mute
            chain.channel.volume.value = t.gain > 0 ? Tone.gainToDb(t.gain) : -Infinity;
            chain.channel.mute = isMuted(t);
        }
    }, [tracks, isMuted]);

    // ---- Scheduling ----
    const clearPlayers = useCallback(() => {
        players.current.forEach((p) => {
            try {
                p.stop();
            } catch {
                /* ignore */
            }
        });
    }, []);

    // Dispose all MIDI-lane synths (this also cancels any notes already scheduled
    // on them) and recreate them connected to their lane's effect-chain input.
    const rebuildSynths = useCallback(() => {
        synths.current.forEach((s) => {
            try {
                s.dispose();
            } catch {
                /* ignore */
            }
        });
        synths.current.clear();
        const laneIds = new Set(
            tracksRef.current.filter((t) => t.source === "midi").map((t) => t.laneId),
        );
        for (const laneId of laneIds) {
            const lane = lanes.current.get(laneId);
            if (!lane) continue;
            const synth = new Tone.PolySynth(Tone.Synth, {
                oscillator: { type: "triangle" },
                envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.4 },
            });
            synth.connect(lane.input);
            synths.current.set(laneId, synth);
        }
    }, []);

    const stopRaf = useCallback(() => {
        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
    }, []);

    // Schedule audio clips and MIDI notes up-front at precise AudioContext times
    // from a shared anchor, so playback is sample-accurate and independent of the
    // rAF cadence (which only drives the visual playhead).
    const scheduleFrom = useCallback((from: number) => {
        clearPlayers();
        rebuildSynths();
        const ctxNow = Tone.now();
        const startTime = ctxNow + LOOKAHEAD;
        anchorRef.current = { ctxStart: startTime, from };
        for (const t of tracksRef.current) {
            if (isMutedRef.current(t)) continue;
            const start = t.offset_sec;
            const len = visibleLen(t);
            const end = start + len;
            if (len <= 0 || from >= end) continue;

            if (t.source === "midi" && t.midi) {
                const synth = synths.current.get(t.laneId);
                if (!synth) continue;
                const clipStart = t.clip_start_sec;
                const clipEnd = t.clip_end_sec > 0 ? t.clip_end_sec : t.durationSec || 0;
                for (const n of t.midi.notes) {
                    if (n.start_sec < clipStart || n.start_sec >= clipEnd) continue;
                    const onset = t.offset_sec + (n.start_sec - clipStart);
                    if (onset < from) continue; // note already passed
                    const when = startTime + (onset - from);
                    const dur = Math.max(0.05, n.dur_sec);
                    const freq = Tone.Frequency(n.pitch, "midi").toFrequency();
                    const vel = Math.max(0, Math.min(1, n.velocity / 127));
                    try {
                        synth.triggerAttackRelease(freq, dur, when, vel);
                    } catch {
                        /* ignore scheduling races */
                    }
                }
                continue;
            }

            const player = players.current.get(t.uid);
            if (!player) continue;
            if (from <= start) {
                player.start(startTime + (start - from), t.clip_start_sec, len);
            } else {
                player.start(startTime, t.clip_start_sec + (from - start), end - from);
            }
        }
    }, [clearPlayers, rebuildSynths]);

    const stopInternal = useCallback(() => {
        stopRaf();
        clearPlayers();
        rebuildSynths();
        playingRef.current = false;
        setPlaying(false);
    }, [clearPlayers, rebuildSynths, stopRaf]);

    const play = useCallback(
        (from: number) => {
            const startAt = Math.max(0, from);
            void Tone.start().then(() => {
                scheduleFrom(startAt);
                playingRef.current = true;
                setPlaying(true);
                const end = timelineEnd();
                const tick = () => {
                    const a = anchorRef.current;
                    if (!a) return;
                    const now = Tone.now();
                    const cur = a.from + Math.max(0, now - a.ctxStart);
                    setCurrentSec(cur);
                    if (cur >= end) {
                        stopInternal();
                        setCurrentSec(end);
                        return;
                    }
                    rafRef.current = requestAnimationFrame(tick);
                };
                stopRaf();
                rafRef.current = requestAnimationFrame(tick);
            });
        },
        [scheduleFrom, stopInternal, stopRaf, timelineEnd],
    );

    const pause = useCallback(() => {
        stopInternal();
    }, [stopInternal]);

    const seek = useCallback(
        (sec: number) => {
            const clamped = Math.max(0, sec);
            setCurrentSec(clamped);
            if (playingRef.current) play(clamped);
        },
        [play],
    );

    // Reschedule if the layout changes mid-playback (offset/trim/mute).
    const layoutSig = layoutSignature(tracks, isMuted);
    const layoutSigRef = useRef(layoutSig);
    useEffect(() => {
        if (layoutSigRef.current === layoutSig) return;
        layoutSigRef.current = layoutSig;
        if (playingRef.current && anchorRef.current) {
            const now = Tone.now();
            const cur = anchorRef.current.from + Math.max(0, now - anchorRef.current.ctxStart);
            scheduleFrom(cur);
        }
    }, [layoutSig, scheduleFrom]);

    // Teardown everything on unmount.
    useEffect(() => {
        return () => {
            stopRaf();
            players.current.forEach((p) => p.dispose());
            players.current.clear();
            synths.current.forEach((s) => s.dispose());
            synths.current.clear();
            lanes.current.forEach((c) => Object.values(c).forEach((n) => n.dispose()));
            lanes.current.clear();
            buffers.current.forEach((b) => b.dispose());
            buffers.current.clear();
            masterRef.current?.dispose();
            masterRef.current = null;
        };
    }, [stopRaf]);

    return { ready, playing, currentSec, play, pause, seek, setMasterVolume, loadError };
}
