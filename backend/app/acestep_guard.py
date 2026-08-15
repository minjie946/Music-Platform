"""Preflight guards for ACE-Step model initialization."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

import psutil


@dataclass
class MemoryGuardResult:
    ok: bool
    message: str = ""
    required_gb: float = 0.0
    available_gb: float = 0.0
    total_gb: float = 0.0
    kind: str = "memory_guard"
    can_continue: bool = False
    suggested_mode: str = "conservative"
    suggested_dit: str = "acestep-v15-turbo"
    suggested_lm: str = "none"

    def to_detail(self) -> dict:
        return {
            "type": self.kind,
            "message": self.message,
            "required_gb": self.required_gb,
            "available_gb": self.available_gb,
            "total_gb": self.total_gb,
            "can_continue": self.can_continue,
            "suggested_mode": self.suggested_mode,
            "suggested_dit": self.suggested_dit,
            "suggested_lm": self.suggested_lm,
        }


def estimate_init_memory_gb(dit_model: str | None, lm_model: str | None, device: str) -> float:
    """Approximate peak memory needed while ACE-Step deserializes + moves models.

    The goal is not exact accounting; it is a conservative guard against starting
    known oversized combinations on machines that are already under memory pressure.
    """
    dit = _model_name(dit_model)
    lm = _model_name(lm_model)

    if "xl" in dit:
        required = 30.0
    elif "sft" in dit or "base" in dit:
        required = 18.0
    else:
        required = 13.0

    if "4b" in lm:
        required += 22.0
    elif "1.7b" in lm:
        required += 10.0
    elif "0.6b" in lm:
        required += 5.0

    if device == "mps":
        required *= 1.25
    elif device == "cpu":
        required *= 1.15
    return round(required, 1)


def check_memory_before_init(
    *,
    dit_model: str | None,
    lm_model: str | None,
    device: str,
    performance_mode: str,
) -> MemoryGuardResult:
    vm = psutil.virtual_memory()
    total_gb = vm.total / (1024**3)
    available_gb = vm.available / (1024**3)
    required_gb = estimate_init_memory_gb(dit_model, lm_model, device)

    low_risk_combo = _is_low_risk_mps_combo(dit_model, lm_model, device, performance_mode)
    reserve_gb = max(2.0, total_gb * 0.04) if low_risk_combo else max(4.0, total_gb * 0.12)
    hard_min_total = required_gb + reserve_gb
    hard_min_available = required_gb + (min(reserve_gb, 3.0) if low_risk_combo else min(reserve_gb, 8.0))
    if total_gb < hard_min_total or available_gb < hard_min_available:
        mode_hint = "请切到「保守模式」，选择 Turbo，并把 LM 设为「不使用 LM」后再初始化。"
        if low_risk_combo:
            mode_hint = "你也可以继续强制加载，但可能导致系统变慢、触发内存压力或发生 swap。"
        elif performance_mode == "conservative" and not lm_model and "xl" not in _model_name(dit_model):
            mode_hint = "请关闭其他占用内存的应用后重试，或重启应用释放残留模型进程。"
        return MemoryGuardResult(
            ok=False,
            required_gb=required_gb,
            available_gb=round(available_gb, 1),
            total_gb=round(total_gb, 1),
            can_continue=True,
            message=(
                "初始化模型前内存保护已拦截："
                f"当前选择预计峰值需要约 {required_gb:.1f}GB，"
                f"系统可用约 {available_gb:.1f}GB / 总内存 {total_gb:.1f}GB。"
                f"{mode_hint}"
            ),
        )
    return MemoryGuardResult(
        ok=True,
        required_gb=required_gb,
        available_gb=round(available_gb, 1),
        total_gb=round(total_gb, 1),
    )


def find_acestep_processes() -> list[dict]:
    out: list[dict] = []
    current_pid = psutil.Process().pid
    for proc in psutil.process_iter(["pid", "ppid", "name", "cmdline", "memory_info"]):
        try:
            info = proc.info
            pid = int(info.get("pid") or 0)
            if pid == current_pid:
                continue
            cmdline = [str(v) for v in (info.get("cmdline") or [])]
            text = " ".join(cmdline).lower()
            name = str(info.get("name") or "")
            if not _looks_like_acestep(name, text):
                continue
            mem = info.get("memory_info")
            out.append(
                {
                    "pid": pid,
                    "ppid": int(info.get("ppid") or 0),
                    "name": name or Path(cmdline[0]).name if cmdline else name,
                    "rss_bytes": int(getattr(mem, "rss", 0) or 0),
                    "cmdline": " ".join(cmdline)[:300],
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    out.sort(key=lambda item: item.get("rss_bytes", 0), reverse=True)
    return out


def check_duplicate_acestep_processes() -> MemoryGuardResult:
    procs = find_acestep_processes()
    api_procs = [
        proc
        for proc in procs
        if "acestep-api" in str(proc.get("cmdline", "")).lower()
        or "launch_acestep_runtime.py" in str(proc.get("cmdline", "")).lower()
    ]
    groups: dict[str, list[dict]] = {}
    for proc in api_procs:
        key = _process_group_key(int(proc.get("pid") or 0))
        groups.setdefault(key, []).append(proc)
    if len(groups) <= 1:
        return MemoryGuardResult(ok=True)
    detail_parts = []
    for key, members in list(groups.items())[:4]:
        rss = sum(int(proc.get("rss_bytes", 0) or 0) for proc in members)
        pids = ",".join(str(proc.get("pid")) for proc in members[:4])
        detail_parts.append(f"group={key} pids={pids} rss={rss / (1024**3):.1f}GB")
    detail = "；".join(detail_parts)
    return MemoryGuardResult(
        ok=False,
        kind="duplicate_guard",
        message=(
            "检测到多个 ACE-Step 模型服务进程，继续初始化可能重复加载模型并导致系统内存暴涨。"
            f"请先在设置中重启生成服务，或退出应用后清理残留进程。当前进程：{detail}"
        ),
    )


def _model_name(value: str | None) -> str:
    if not value or value == "none":
        return ""
    return Path(str(value)).name.lower()


def _looks_like_acestep(name: str, cmdline: str) -> bool:
    lower_name = name.lower()
    return (
        "acestep" in lower_name
        or "ace-step" in cmdline
        or "acestep-api" in cmdline
        or "launch_acestep_runtime.py" in cmdline
        or "app_acestep_runtime_dir" in cmdline
    )


def _process_group_key(pid: int) -> str:
    if pid <= 0:
        return "pid:0"
    if os.name != "nt":
        try:
            return f"pgid:{os.getpgid(pid)}"
        except OSError:
            pass
    try:
        proc = psutil.Process(pid)
        root = proc
        while True:
            parent = root.parent()
            if parent is None or parent.pid <= 1:
                break
            if not _looks_like_acestep(parent.name(), " ".join(parent.cmdline()).lower()):
                break
            root = parent
        return f"root:{root.pid}"
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return f"pid:{pid}"


def _is_low_risk_mps_combo(
    dit_model: str | None,
    lm_model: str | None,
    device: str,
    performance_mode: str,
) -> bool:
    return (
        device == "mps"
        and (performance_mode or "").strip().lower() == "conservative"
        and _model_name(dit_model) in {"", "acestep-v15-turbo"}
        and _model_name(lm_model) in {"", "none"}
    )
