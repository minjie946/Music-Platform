"""so-vits-svc adapter (via the ``so-vits-svc-fork`` ``svc`` CLI).

Cross-platform training path (CPU/MPS/CUDA). Training and inference are driven
through the engine's own CLI, executed in a per-voice working directory whose
default layout the CLI already expects:

    <voice>/work/
        dataset_raw/<speaker>/*.wav   (input samples)
        dataset/44k/...               (pre-resample output)
        configs/44k/config.json       (pre-config output)
        logs/44k/G_*.pth, config.json (train output -> the model)
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from .base import ProgressCb, SvcEngine, SvcEngineError, _module_present
from .. import config
from .. import pretrained

SPEAKER = "target"
MIN_TRAIN_SEGMENTS = 5


class SoVitsEngine(SvcEngine):
    name = "sovits"

    def infer_available(self) -> bool:
        return _module_present("so_vits_svc_fork")

    def train_available(self, device: str) -> tuple[bool, str]:
        if not _module_present("so_vits_svc_fork"):
            return (
                False,
                "未安装 so-vits-svc-fork。浏览器开发模式请在 svc_service 目录执行 `uv sync --system-certs`，完成后重启 ./start.sh；打包应用请重新打包内置 SVC runtime。",
            )
        if device == "cuda":
            return True, "CUDA 加速，训练较快"
        if device == "mps":
            return True, "Apple MPS：可训练但较慢（部分算子回退 CPU）"
        return True, "纯 CPU：可训练但很慢，建议样本简短、轮数少"

    # ------------------------------------------------------------------
    def _child_env(self) -> dict[str, str]:
        """子进程环境：确保 HF 缓存指向本地权重目录并离线，命中已下载的 content-vec。"""
        env = dict(os.environ)
        if pretrained.content_vec_ready():
            env.setdefault("HF_HOME", str(config.hf_home_dir()))
            env.setdefault("HF_HUB_OFFLINE", "1")
            env.setdefault("TRANSFORMERS_OFFLINE", "1")
        return env

    def _run(self, args: list[str], cwd: Path, progress_cb: ProgressCb, pct: int, stage: str) -> None:
        progress_cb(pct, stage)
        cmd = [sys.executable, "-m", "so_vits_svc_fork.__main__", *args]
        # so-vits-svc-fork exposes the `svc` console script; fall back to it.
        if shutil.which("svc"):
            cmd = ["svc", *args]
        env = self._child_env()
        print(f"[svc-engine:sovits] 开始阶段：{stage}，命令：{' '.join(cmd)}，cwd={cwd}", flush=True)
        proc = subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True, text=True)
        self._log_process_output(args[0], proc)
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "")[-800:]
            raise SvcEngineError(f"so-vits `{args[0]}` 失败: {tail}")
        print(f"[svc-engine:sovits] 完成阶段：{stage}", flush=True)

    def _log_process_output(self, step: str, proc: subprocess.CompletedProcess[str]) -> None:
        stdout = (proc.stdout or "").strip()
        stderr = (proc.stderr or "").strip()
        if stdout:
            print(f"[svc-engine:sovits:{step}:stdout]\n{self._tail(stdout)}", flush=True)
        if stderr:
            print(f"[svc-engine:sovits:{step}:stderr]\n{self._tail(stderr)}", flush=True)

    def _tail(self, text: str, max_chars: int = 4000) -> str:
        if len(text) <= max_chars:
            return text
        return "...<truncated>...\n" + text[-max_chars:]

    def train(
        self,
        samples: list[Path],
        voice_dir: Path,
        device: str,
        progress_cb: ProgressCb,
        max_epochs: int | None = None,
    ) -> None:
        if not self.infer_available():
            raise SvcEngineError("未安装 so-vits-svc-fork，无法训练")

        # 训练需要 content-vec + 底模，缺失则先下载（首次较慢，会联网）。
        if not pretrained.all_ready():
            progress_cb(8, "下载模型权重（首次，较慢）")
            pretrained.ensure_downloaded()
            if not pretrained.all_ready():
                raise SvcEngineError(pretrained.status().get("detail") or "模型权重未就绪")

        work = voice_dir / "work"
        if work.exists():
            shutil.rmtree(work, ignore_errors=True)
        raw = work / "dataset_raw" / SPEAKER
        raw.mkdir(parents=True, exist_ok=True)
        print(
            f"[svc-engine:sovits] 训练目录：{work}，样本数：{len(samples)}，device={device}，max_epochs={max_epochs}",
            flush=True,
        )
        for i, s in enumerate(samples):
            shutil.copy2(s, raw / f"sample_{i:03d}{s.suffix.lower() or '.wav'}")

        self._run(["pre-resample"], work, progress_cb, 15, "重采样样本")
        self._ensure_min_segments(work)
        self._run(["pre-config"], work, progress_cb, 30, "生成配置")

        # Limit epochs so a model is produced in finite time.
        cfg_path = work / "configs" / "44k" / "config.json"
        if cfg_path.exists():
            try:
                cfg = json.loads(cfg_path.read_text("utf-8"))
                epochs = int(max_epochs or 50)
                cfg.setdefault("train", {})
                cfg["train"]["epochs"] = epochs
                cfg["train"]["eval_interval"] = min(cfg["train"].get("eval_interval", 200), 200)
                cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
                print(f"[svc-engine:sovits] 已写入训练配置：epochs={epochs}, config={cfg_path}", flush=True)
            except Exception:
                print(f"[svc-engine:sovits] 训练配置更新失败，继续使用默认配置：{cfg_path}", flush=True)

        self._run(["pre-hubert"], work, progress_cb, 45, "提取特征")
        self._seed_base_models(work)
        self._run(["train"], work, progress_cb, 60, "训练中（耗时较长）")

        # Verify a generator checkpoint exists.
        if not self._latest_ckpt(work):
            raise SvcEngineError("训练结束但未找到模型权重（G_*.pth）")
        progress_cb(100, "完成")

    def _seed_base_models(self, work: Path) -> None:
        """把项目内预置底模拷进训练输出目录，命中引擎的 skip_if_exists 从而跳过联网下载。

        引擎在 train 阶段调用 ensure_pretrained_model(model_path, ...)，model_path
        即 work/logs/44k；download_file(skip_if_exists=True) 见文件已存在则直接返回。
        """
        seeded = config.base_model_files()
        if not seeded:
            return
        dest_dir = work / "logs" / "44k"
        dest_dir.mkdir(parents=True, exist_ok=True)
        for name, src in seeded.items():
            dest = dest_dir / name
            if dest.exists():
                continue
            try:
                shutil.copy2(src, dest)
                print(f"[svc-engine:sovits] 已预置底模：{name} <- {src}", flush=True)
            except Exception as exc:
                print(f"[svc-engine:sovits] 预置底模失败 {name}: {exc}（将回退为联网下载）", flush=True)

    def _ensure_min_segments(self, work: Path) -> None:
        """so-vits splits the dataset into train/val/test and needs 5+ clips."""
        speaker_dir = work / "dataset" / "44k" / SPEAKER
        wavs = sorted(speaker_dir.rglob("*.wav")) if speaker_dir.is_dir() else []
        valid = [p for p in wavs if self._duration_sec(p) >= 0.3]
        if len(valid) >= MIN_TRAIN_SEGMENTS:
            return
        raise SvcEngineError(
            "so-vits 训练样本太少：预处理后只有 "
            f"{len(valid)} 段有效音频，至少需要 {MIN_TRAIN_SEGMENTS} 段。"
            "请上传至少 5 段清晰人声音频，或先把一段长录音切成多个 5-15 秒片段后再训练。"
        )

    def _duration_sec(self, path: Path) -> float:
        try:
            import soundfile as sf

            info = sf.info(str(path))
            return float(info.frames) / float(info.samplerate or 1)
        except Exception:
            return 0.0

    def _latest_ckpt(self, work: Path) -> Path | None:
        logs = work / "logs" / "44k"
        if not logs.is_dir():
            return None
        ckpts = sorted(
            (p for p in logs.glob("G_*.pth") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
        )
        return ckpts[-1] if ckpts else None

    def _config(self, work: Path) -> Path | None:
        for cand in (work / "logs" / "44k" / "config.json", work / "configs" / "44k" / "config.json"):
            if cand.is_file():
                return cand
        return None

    def convert(
        self,
        input_wav: Path,
        voice_dir: Path,
        out_wav: Path,
        device: str,
        transpose: int = 0,
    ) -> Path:
        if not self.infer_available():
            raise SvcEngineError("未安装 so-vits-svc-fork，无法转换")
        # 推理需要 content-vec，缺失则先下载（首次较慢，会联网）。
        if not pretrained.content_vec_ready():
            pretrained.ensure_downloaded()
            if not pretrained.content_vec_ready():
                raise SvcEngineError(pretrained.status().get("detail") or "content-vec 权重未就绪")
        work = voice_dir / "work"
        ckpt = self._latest_ckpt(work)
        cfg = self._config(work)
        if not ckpt or not cfg:
            raise SvcEngineError("该音源缺少模型权重或配置，请重新训练")

        out_wav.parent.mkdir(parents=True, exist_ok=True)
        args = [
            "infer",
            str(input_wav),
            "-m",
            str(ckpt),
            "-c",
            str(cfg),
            "-o",
            str(out_wav),
            "-s",
            SPEAKER,
            "-na",  # no auto predict f0 issues; keep transpose explicit
            "-t",
            str(int(transpose)),
        ]
        cmd = ["svc", *args] if shutil.which("svc") else [sys.executable, "-m", "so_vits_svc_fork.__main__", *args]
        proc = subprocess.run(cmd, capture_output=True, text=True, env=self._child_env())
        if proc.returncode != 0 or not out_wav.exists():
            tail = (proc.stderr or proc.stdout or "")[-800:]
            raise SvcEngineError(f"so-vits 转换失败: {tail}")
        return out_wav
