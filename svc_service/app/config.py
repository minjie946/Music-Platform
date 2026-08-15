"""Sidecar configuration: paths and accelerator detection.

The backend passes the voice-model storage directory via ``SVC_MODELS_DIR`` so
trained voices land in a project- (and user-) configurable location. Everything
else is import-safe even when torch / the SVC engines are missing.
"""
from __future__ import annotations

import functools
import os
from pathlib import Path

# 兼容：旧版本把权重放在项目内 svc_service/pretrained。仍存在则继续认它。
_LEGACY_PRETRAINED_DIR = Path(__file__).resolve().parents[1] / "pretrained"


def pretrained_dir() -> Path:
    """大文件权重（content-vec / HuBERT / 底模）的存放目录。

    优先级：
      1. 环境变量 ``SVC_PRETRAINED_DIR``（用户自定义大文件目录）。
      2. ``SVC_MODELS_DIR`` 的同级 ``pretrained``（即 workspace/svc/pretrained），
         与 models/work 同级，随应用设置走，不占项目体积。
      3. 兜底：项目内旧目录 svc_service/pretrained（向后兼容）。
    """
    env = os.environ.get("SVC_PRETRAINED_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    models = os.environ.get("SVC_MODELS_DIR", "").strip()
    if models:
        return Path(models).expanduser().parent / "pretrained"
    return _LEGACY_PRETRAINED_DIR


def hf_home_dir() -> Path:
    """content-vec / HuBERT 的 HuggingFace 缓存目录。"""
    return pretrained_dir() / "hf_home"


def base_models_dir() -> Path:
    """训练底模 D_0.pth / G_0.pth 目录。"""
    return pretrained_dir() / "base"


def use_offline_pretrained() -> None:
    """若权重已就位，则把 HuggingFace 缓存指向该目录并强制离线。

    子进程（so-vits-svc CLI）继承 os.environ，因此只需在服务进程启动时设置一次。
    仅当缓存确实存在时才强制离线，避免误伤未预置/需联网下载的环境。
    """
    hf_home = hf_home_dir()
    if (hf_home / "hub").is_dir():
        os.environ.setdefault("HF_HOME", str(hf_home))
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")


def base_model_files() -> dict[str, Path]:
    """返回已就位的底模 {文件名: 路径}，仅包含实际存在的文件。"""
    found: dict[str, Path] = {}
    base = base_models_dir()
    for name in ("D_0.pth", "G_0.pth"):
        p = base / name
        if p.is_file():
            found[name] = p
    return found


def models_dir() -> Path:
    """Where trained voice models live (one subdir per voice)."""
    env = os.environ.get("SVC_MODELS_DIR", "").strip()
    if not env:
        raise RuntimeError("未配置 SVC_MODELS_DIR，拒绝使用默认音源目录启动 SVC。")
    base = Path(env).expanduser()
    base.mkdir(parents=True, exist_ok=True)
    return base


def work_dir() -> Path:
    """Scratch area for training runs and conversion temp files."""
    env = os.environ.get("SVC_WORK_DIR", "").strip()
    base = Path(env).expanduser() if env else Path(__file__).resolve().parents[1] / ".work"
    base.mkdir(parents=True, exist_ok=True)
    return base


@functools.lru_cache(maxsize=1)
def detect_device() -> str:
    """Return "cuda" | "mps" | "cpu" (best available accelerator)."""
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"
