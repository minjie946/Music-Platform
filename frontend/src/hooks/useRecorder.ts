import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 麦克风录音 hook：封装 getUserMedia + MediaRecorder，并提供实时电平，
 * 供录音界面画出简单的音量条。停止后回调一个音频 Blob（浏览器原生格式，
 * 后续由 audioQuality 解码/分析/转 WAV）。
 */

export type RecorderState = "idle" | "requesting" | "recording" | "error";

interface UseRecorderResult {
  state: RecorderState;
  /** 当前录音时长（秒）。 */
  elapsed: number;
  /** 实时输入电平（0-1），用于音量条与「有没有收到声音」的直观反馈。 */
  level: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

export function useRecorder(): UseRecorderResult {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startTsRef = useRef(0);

  const teardown = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async () => {
    setError(null);
    setElapsed(0);
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      recorderRef.current = recorder;

      // 实时电平监测
      const Ctor: typeof AudioContext =
        window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctor();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          const abs = Math.abs(data[i]);
          if (abs > peak) peak = abs;
        }
        setLevel(peak);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      startTsRef.current = Date.now();
      timerRef.current = window.setInterval(() => {
        setElapsed((Date.now() - startTsRef.current) / 1000);
      }, 200);

      setState("recording");
    } catch (e: any) {
      teardown();
      setState("error");
      const name = e?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("麦克风权限被拒绝，请在系统/浏览器设置中允许后重试。");
      } else if (name === "NotFoundError") {
        setError("未检测到麦克风设备，请连接后重试。");
      } else {
        setError("无法开始录音，请检查麦克风设备与权限。");
      }
    }
  }, [teardown]);

  const stop = useCallback(async (): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    if (!recorder) {
      teardown();
      setState("idle");
      return null;
    }
    return new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        const blob = chunksRef.current.length
          ? new Blob(chunksRef.current, { type })
          : null;
        teardown();
        setState("idle");
        resolve(blob);
      };
      recorder.stop();
    });
  }, [teardown]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    teardown();
    setState("idle");
    setElapsed(0);
  }, [teardown]);

  return { state, elapsed, level, error, start, stop, cancel };
}
