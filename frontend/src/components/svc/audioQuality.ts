/**
 * 录音的本地处理：解码 → 计算合格指标 → 编码为单声道 WAV。
 *
 * 全程在浏览器内完成（Web Audio + 手写 WAV 编码），不上传、不联网，
 * 因此录完即可当场看到「是否合格」以及不合格的原因。
 *
 * 合格标准对齐飞书文档《录音脚本 + 朗读指南》的红线：
 * 干净（无爆音、底噪低）、稳定（音量适中一致）、单人有效人声、时长达标。
 */

export type CheckLevel = "pass" | "warn" | "fail";

export interface QualityIssue {
  level: CheckLevel;
  message: string;
}

export interface QualityReport {
  /** 有效人声时长（去掉首尾静音，秒）。 */
  durationSec: number;
  /** 采样率。 */
  sampleRate: number;
  /** 峰值电平（0-1）。 */
  peak: number;
  /** RMS 响度（dBFS，负值，越接近 0 越响）。 */
  rmsDb: number;
  /** 粗略信噪比估计（dB）。 */
  snrDb: number;
  /** 是否检测到爆音/削波。 */
  clipping: boolean;
  /** 综合判定：pass 可用于训练；warn 可用但有隐患；fail 不达标。 */
  level: CheckLevel;
  issues: QualityIssue[];
}

/** 目标采样率：so-vits 训练偏好 44.1kHz。 */
const TARGET_SAMPLE_RATE = 44100;
const MIN_PEAK = 0.05; // 峰值太低说明几乎没录到声音
const CLIP_THRESHOLD = 0.985; // 接近满幅视为削波/爆音
const MIN_SNR_DB = 12; // 低于此值底噪偏重
const SILENCE_FLOOR = 0.015; // 判定有效人声的振幅门限

/** 解码任意录音 Blob 为单声道 PCM（Float32，采样率取解码结果）。 */
export async function decodeToMono(
  blob: Blob,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const buf = await blob.arrayBuffer();
  const Ctor: typeof AudioContext =
    window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctor();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const mono = downmix(decoded);
    return { samples: mono, sampleRate: decoded.sampleRate };
  } finally {
    ctx.close();
  }
}

function downmix(buffer: AudioBuffer): Float32Array {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  if (ch === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < len; i += 1) out[i] += data[i] / ch;
  }
  return out;
}

/** 基于 PCM 计算合格报告。 */
export function analyzeSamples(samples: Float32Array, sampleRate: number): QualityReport {
  const total = samples.length;
  let peak = 0;
  let clipCount = 0;
  let sumSq = 0;
  for (let i = 0; i < total; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
    if (abs >= CLIP_THRESHOLD) clipCount += 1;
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / Math.max(1, total));
  const rmsDb = toDb(rms);

  // 有效人声区间（首尾静音裁掉后的时长），并据此粗估信噪比。
  const { start, end, voiceEnergy, noiseEnergy } = voiceSpan(samples);
  const durationSec = Math.max(0, (end - start) / sampleRate);
  const snrDb =
    noiseEnergy > 0 && voiceEnergy > 0
      ? 10 * Math.log10(voiceEnergy / noiseEnergy)
      : voiceEnergy > 0
        ? 40
        : 0;
  const clipping = clipCount > sampleRate * 0.001; // 超过约 1ms 的削波样本

  const issues: QualityIssue[] = [];
  if (peak < MIN_PEAK) {
    issues.push({ level: "fail", message: "几乎没录到声音，请靠近麦克风或提高音量后重录。" });
  }
  if (clipping) {
    issues.push({ level: "fail", message: "检测到爆音/削波，离麦太近或音量过大，请调低后重录。" });
  }
  if (snrDb > 0 && snrDb < MIN_SNR_DB) {
    issues.push({ level: "warn", message: `底噪偏重（信噪比约 ${snrDb.toFixed(0)}dB），建议关空调/风扇、换安静环境。` });
  }
  if (rmsDb > -6) {
    issues.push({ level: "warn", message: "整体偏响，注意峰值别过载，可稍微离麦远一点。" });
  } else if (rmsDb < -32 && peak >= MIN_PEAK) {
    issues.push({ level: "warn", message: "整体偏轻，可离麦近一点或提高音量。" });
  }

  const level = worstLevel(issues, durationSec);
  return { durationSec, sampleRate, peak, rmsDb, snrDb, clipping, level, issues };
}

/** 结合最短时长要求给出最终判定。 */
export function finalizeReport(report: QualityReport, minSec: number): QualityReport {
  const issues = [...report.issues];
  if (report.durationSec < minSec) {
    issues.unshift({
      level: "fail",
      message: `有效人声约 ${report.durationSec.toFixed(1)} 秒，未达建议的 ${minSec} 秒，请把内容读/唱完整。`,
    });
  }
  return { ...report, issues, level: worstLevel(issues, report.durationSec) };
}

function worstLevel(issues: QualityIssue[], durationSec: number): CheckLevel {
  if (durationSec <= 0) return "fail";
  if (issues.some((i) => i.level === "fail")) return "fail";
  if (issues.some((i) => i.level === "warn")) return "warn";
  return "pass";
}

function voiceSpan(samples: Float32Array): {
  start: number;
  end: number;
  voiceEnergy: number;
  noiseEnergy: number;
} {
  const total = samples.length;
  let start = 0;
  let end = total;
  while (start < total && Math.abs(samples[start]) < SILENCE_FLOOR) start += 1;
  while (end > start && Math.abs(samples[end - 1]) < SILENCE_FLOOR) end -= 1;

  // 人声段能量 vs. 静音段（噪声）能量，用于粗估信噪比。
  let voiceSum = 0;
  let voiceN = 0;
  let noiseSum = 0;
  let noiseN = 0;
  for (let i = 0; i < total; i += 1) {
    const e = samples[i] * samples[i];
    if (i >= start && i < end && Math.abs(samples[i]) >= SILENCE_FLOOR) {
      voiceSum += e;
      voiceN += 1;
    } else {
      noiseSum += e;
      noiseN += 1;
    }
  }
  return {
    start,
    end,
    voiceEnergy: voiceN ? voiceSum / voiceN : 0,
    noiseEnergy: noiseN ? noiseSum / noiseN : 0,
  };
}

function toDb(v: number): number {
  if (v <= 1e-8) return -100;
  return 20 * Math.log10(v);
}

/** 线性重采样到目标采样率（简单够用，训练前引擎还会再重采样）。 */
function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = to / from;
  const outLen = Math.round(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** 把单声道 PCM 编码为 16-bit WAV（单声道，默认 44.1kHz）。 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
  targetRate = TARGET_SAMPLE_RATE,
): Blob {
  const pcm = resample(samples, sampleRate, targetRate);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(view, 36, "data");
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcm.length; i += 1) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

function writeStr(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
}
