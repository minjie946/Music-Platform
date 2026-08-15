"""Hardware detection + ACE-Step tier recommendation.

The app supports music generation via ACE-Step, which needs very different
settings depending on the machine (NVIDIA CUDA / Apple MPS / CPU-only). We
detect the available accelerator and (V)RAM, then recommend an ACE-Step
configuration (DiT model, LM model, backend, offload flags) roughly following
the model's own "Which model should I choose?" table.

This module is import-safe even when torch is missing.
"""
from __future__ import annotations

import platform
import shutil
import subprocess
import os
from dataclasses import dataclass, field, asdict

# 全局可生成的最长时长（秒）。统一上限，作用于所有硬件档位。
MAX_DURATION_SEC = 270
PERFORMANCE_MODES = {"conservative", "standard", "quality"}

# 可选模型目录（name, 显示标签）。用于初始化界面与设置里的下拉选择。
DIT_CATALOG: list[tuple[str, str]] = [
    ("acestep-v15-turbo", "Turbo（默认 · 最快 · 主模型内置）"),
    ("acestep-v15-xl-turbo", "XL Turbo（4B · 质量更好 · 需较大显存）"),
    ("acestep-v15-xl-sft", "XL SFT（4B · 最高质量 · 需大显存）"),
    ("acestep-v15-sft", "SFT（精修版）"),
    ("acestep-v15-base", "Base（基础版）"),
]

# LM（语言模型）目录。"none" = 不加载 LM（最快，质量略低）。
LM_CATALOG: list[tuple[str, str]] = [
    ("none", "不使用 LM（最快）"),
    ("acestep-5Hz-lm-0.6B", "LM 0.6B（轻量）"),
    ("acestep-5Hz-lm-1.7B", "LM 1.7B（默认 · 主模型内置）"),
    ("acestep-5Hz-lm-4B", "LM 4B（最佳 · 需大显存/内存）"),
]


@dataclass
class AceStepRecommendation:
    dit_model: str = "acestep-v15-turbo"
    lm_model: str | None = None         # None => DiT only (no LM)
    lm_backend: str = "pt"              # "vllm" (CUDA only) or "pt"
    init_llm: bool = False
    offload_to_cpu: bool = False
    quantization: str | None = None     # e.g. "int8"
    max_batch_size: int = 2
    max_duration_sec: int = MAX_DURATION_SEC


@dataclass
class HardwareInfo:
    os: str = ""
    arch: str = ""
    torch_available: bool = False
    device: str = "cpu"                 # "cuda" | "mps" | "cpu"
    has_cuda: bool = False
    has_mps: bool = False
    gpu_name: str = ""
    vram_gb: float = 0.0
    ram_gb: float = 0.0
    cpu_count: int = 0
    # Feature gating
    separation_available: bool = True   # Demucs runs anywhere (CPU ok)
    generation_available: bool = False  # ACE-Step: discouraged on pure CPU
    generation_note: str = ""
    recommended: AceStepRecommendation = field(default_factory=AceStepRecommendation)


def _ram_gb() -> float:
    try:
        import psutil

        return round(psutil.virtual_memory().total / (1024**3), 1)
    except Exception:
        pass
    try:
        if platform.system() == "Darwin":
            out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True)
            return round(int(out.stdout.strip()) / (1024**3), 1)
        # Linux
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return round(kb / (1024**2), 1)
    except Exception:
        pass
    return 0.0


def _cpu_count() -> int:
    try:
        import os

        return os.cpu_count() or 0
    except Exception:
        return 0


def _recommend_cuda(vram_gb: float) -> AceStepRecommendation:
    """Mirror ACE-Step's GPU tier table (approximate)."""
    if vram_gb <= 6:
        return AceStepRecommendation(
            dit_model="acestep-v15-turbo", lm_model=None, lm_backend="pt",
            init_llm=False, offload_to_cpu=True, quantization="int8",
            max_batch_size=1, max_duration_sec=120,
        )
    if vram_gb <= 8:
        return AceStepRecommendation(
            dit_model="acestep-v15-turbo", lm_model="acestep-5Hz-lm-0.6B",
            lm_backend="pt", init_llm=True, offload_to_cpu=True,
            max_batch_size=2, max_duration_sec=180,
        )
    if vram_gb <= 16:
        return AceStepRecommendation(
            dit_model="acestep-v15-turbo", lm_model="acestep-5Hz-lm-1.7B",
            lm_backend="vllm", init_llm=True, offload_to_cpu=False,
            max_batch_size=4, max_duration_sec=240,
        )
    if vram_gb <= 24:
        return AceStepRecommendation(
            dit_model="acestep-v15-xl-turbo", lm_model="acestep-5Hz-lm-1.7B",
            lm_backend="vllm", init_llm=True, offload_to_cpu=vram_gb < 20,
            max_batch_size=4, max_duration_sec=300,
        )
    return AceStepRecommendation(
        dit_model="acestep-v15-xl-sft", lm_model="acestep-5Hz-lm-4B",
        lm_backend="vllm", init_llm=True, offload_to_cpu=False,
        max_batch_size=8, max_duration_sec=600,
    )


def normalize_performance_mode(mode: str | None) -> str:
    mode = (mode or "conservative").strip().lower()
    return mode if mode in PERFORMANCE_MODES else "conservative"


def apply_performance_mode(info: HardwareInfo, mode: str | None) -> HardwareInfo:
    """Adjust the detected recommendation according to the user's performance mode."""
    mode = normalize_performance_mode(mode)
    if info.has_mps:
        if mode == "quality":
            info.recommended = AceStepRecommendation(
                dit_model="acestep-v15-turbo",
                lm_model="acestep-5Hz-lm-1.7B" if info.ram_gb >= 32 else "acestep-5Hz-lm-0.6B",
                lm_backend="pt",
                init_llm=True,
                offload_to_cpu=True,
                max_batch_size=1,
                max_duration_sec=180 if info.ram_gb >= 32 else 120,
            )
            note = "高质量模式：会加载更大的 LM，可能触发 macOS 内存压力提示。"
        elif mode == "standard":
            info.recommended = AceStepRecommendation(
                dit_model="acestep-v15-turbo",
                lm_model="acestep-5Hz-lm-0.6B" if info.ram_gb >= 24 else None,
                lm_backend="pt",
                init_llm=info.ram_gb >= 24,
                offload_to_cpu=True,
                max_batch_size=1,
                max_duration_sec=120,
            )
            note = "标准模式：启用轻量 LM 0.6B，质量更好但内存占用更高。"
        else:
            info.recommended = AceStepRecommendation(
                dit_model="acestep-v15-turbo",
                lm_model=None,
                lm_backend="pt",
                init_llm=False,
                offload_to_cpu=True,
                max_batch_size=1,
                max_duration_sec=240 if info.ram_gb >= 32 else (120 if info.ram_gb >= 24 else 60),
            )
            note = "保守模式：默认关闭 LM、限制批量与时长，降低系统内存压力。"
        info.generation_note = (
            f"检测到 Apple Silicon（统一内存约 {info.ram_gb:.0f}GB，MPS），{note}"
        )
    elif info.has_cuda:
        base = _recommend_cuda(info.vram_gb)
        if mode == "conservative":
            base.max_batch_size = min(base.max_batch_size, 1)
            base.max_duration_sec = min(base.max_duration_sec, 120)
            if info.vram_gb <= 8:
                base.lm_model = None
                base.init_llm = False
        elif mode == "standard":
            base.max_batch_size = min(base.max_batch_size, 2)
            base.max_duration_sec = min(base.max_duration_sec, 180)
        info.recommended = base
    else:
        if mode != "conservative":
            info.recommended.max_duration_sec = min(90, MAX_DURATION_SEC)
        else:
            info.recommended.max_duration_sec = min(60, MAX_DURATION_SEC)

    info.recommended.max_duration_sec = min(info.recommended.max_duration_sec, MAX_DURATION_SEC)
    return info


def _detect_impl() -> HardwareInfo:
    info = HardwareInfo(
        os=platform.system(),
        arch=platform.machine(),
        ram_gb=_ram_gb(),
        cpu_count=_cpu_count(),
    )
    try:
        import torch  # noqa

        info.torch_available = True
        if torch.cuda.is_available():
            info.has_cuda = True
            info.device = "cuda"
            try:
                props = torch.cuda.get_device_properties(0)
                info.gpu_name = props.name
                info.vram_gb = round(props.total_memory / (1024**3), 1)
            except Exception:
                pass
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            info.has_mps = True
            info.device = "mps"
            info.gpu_name = "Apple Silicon (MPS)"
        else:
            info.device = "cpu"
    except Exception:
        info.torch_available = False
        info.device = "cpu"

    # Recommend an ACE-Step config + gate generation.
    if info.has_cuda:
        info.recommended = _recommend_cuda(info.vram_gb)
        info.generation_available = True
        info.generation_note = (
            f"检测到 NVIDIA GPU（{info.gpu_name}，约 {info.vram_gb:.0f}GB 显存），"
            f"推荐 {info.recommended.dit_model}。"
        )
    elif info.has_mps:
        info.recommended = AceStepRecommendation(
            dit_model="acestep-v15-turbo",
            lm_model=None,
            lm_backend="pt",
            init_llm=False,
            offload_to_cpu=True,
            max_batch_size=1,
            max_duration_sec=240 if info.ram_gb >= 32 else (120 if info.ram_gb >= 24 else 60),
        )
        info.generation_available = True
        info.generation_note = (
            f"检测到 Apple Silicon（统一内存约 {info.ram_gb:.0f}GB，MPS），"
            f"推荐 {info.recommended.dit_model}（默认保守模式，降低系统内存压力）。"
        )
    else:
        info.recommended = AceStepRecommendation(
            dit_model="acestep-v15-turbo", lm_model=None, lm_backend="pt",
            init_llm=False, offload_to_cpu=True,
            max_batch_size=1, max_duration_sec=60,
        )
        # Generation on pure CPU is possible but extremely slow; gate it off by
        # default and let the user force-enable.
        info.generation_available = False
        info.generation_note = (
            "未检测到 GPU（仅 CPU）。ACE-Step 在纯 CPU 上会非常慢，默认关闭音乐生成；"
            "如需强制开启可设置环境变量 APP_ALLOW_CPU_GENERATION=1。"
        )

    apply_performance_mode(info, os.environ.get("APP_GENERATION_PERFORMANCE_MODE") or "conservative")

    return info


# 硬件探测需 import torch + 查询 CUDA/MPS，较慢。GPU/设备在进程生命周期内不变，
# 故按 性能模式 缓存整份结果（被 /api/hardware、capabilities 每 15s 轮询反复调用）。
# 动态的 ram_gb 每次刷新，保证内存类信息不失真。
_DETECT_CACHE: dict = {}


def detect() -> HardwareInfo:
    mode = os.environ.get("APP_GENERATION_PERFORMANCE_MODE") or "conservative"
    cached = _DETECT_CACHE.get(mode)
    if cached is not None:
        cached.ram_gb = _ram_gb()  # 仅刷新动态字段
        return cached
    info = _detect_impl()
    _DETECT_CACHE[mode] = info
    return info


def detect_dict() -> dict:
    info = detect()
    d = asdict(info)
    return d
