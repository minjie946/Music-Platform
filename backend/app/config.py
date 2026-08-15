"""Application configuration.

Two layers:
- `Settings` (env-driven, immutable per process): infra config such as paths and
  Redis URL.
- `RuntimeSettings` (file-backed JSON, editable from the UI): default engine and
  the LALAL.AI API key.
"""
from __future__ import annotations

import threading
from pathlib import Path

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env", extra="ignore")

    data_dir: Path = Path("data")
    redis_url: str = "redis://localhost:6379/0"
    celery_filesystem_dir: Path = Path("data") / "celery"

    # Upload constraints
    max_upload_mb: int = 200
    allowed_extensions: tuple[str, ...] = (".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg")

    # Demucs
    demucs_model: str = "htdemucs_6s"
    # Optional folder of custom packaged models (*.th named by signature) passed
    # to demucs get_model(..., repo=...). Empty = use bundled pretrained repo.
    demucs_model_repo: str = ""
    # Override the model's source names for a CUSTOM model so capabilities can be
    # computed without loading the checkpoint. Comma-separated; empty = infer.
    demucs_sources: str = ""

    # ACE-Step music generation (sidecar REST service).
    acestep_api_url: str = "http://127.0.0.1:8001"
    acestep_api_key: str = ""

    # SVC (singing voice conversion) sidecar REST service.
    svc_api_url: str = "http://127.0.0.1:8002"
    # Path to the cloned ACE-Step repo (relative to the backend cwd by default).
    # Used to compute the default model checkpoints dir when not overridden.
    acestep_dir: Path = Path("..") / "external" / "ACE-Step-1.5"
    # Force-enable generation on CPU-only machines (very slow). Off by default.
    allow_cpu_generation: bool = False

    # Job retention in hours; cleanup task removes older jobs.
    job_ttl_hours: int = 24

    @property
    def generation_dir(self) -> Path:
        return self.data_dir / "generation"

    @property
    def generation_history_dir(self) -> Path:
        return self.data_dir / "generation_history"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def outputs_dir(self) -> Path:
        return self.data_dir / "outputs"

    @property
    def edits_dir(self) -> Path:
        return self.data_dir / "edits"

    @property
    def svc_models_dir_default(self) -> Path:
        return self.data_dir / "svc_models"

    @property
    def settings_file(self) -> Path:
        return self.data_dir / "settings.json"

    def ensure_dirs(self) -> None:
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        self.generation_dir.mkdir(parents=True, exist_ok=True)
        self.generation_history_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
settings.ensure_dirs()


class RuntimeSettings(BaseModel):
    """User-editable settings persisted to data/settings.json."""

    default_engine: str = "demucs"  # "demucs" | "lalal"
    lalal_api_key: str = ""

    # Cascade: after Demucs produces the vocals stem, run a karaoke model to
    # further split it into lead + backing vocals (route A). Requires the
    # optional `audio-separator` package (see requirements-dev.txt).
    cascade_vocal_split: bool = False
    karaoke_model: str = "UVR_MDXNET_KARA_2.onnx"

    # User-selected workspace root. When set, all runtime data directories are
    # derived from it and legacy per-directory fields below are ignored.
    workspace_dir: str = ""

    # Legacy per-directory fields kept for backward compatibility/migration.
    # Where ACE-Step stores model checkpoints. Must be configured by the user.
    # Passed to the sidecar as ACESTEP_CHECKPOINTS_DIR.
    acestep_checkpoints_dir: str = ""
    # Where music-generation LoRA adapters are stored. Empty = <workspace>/ace/models/loras.
    lora_dir: str = ""
    # Where the backend stages freshly generated audio (the "cache" area).
    # Must be configured by the user. Files are moved to the history dir on completion.
    generation_output_dir: str = ""
    # Permanent archive of generated songs. Completed songs are moved here from
    # the cache dir; history/play/download read from here. Must be configured.
    history_output_dir: str = ""
    # Where separated stems are written and later read as separation history.
    # Must be configured by the user.
    separation_output_dir: str = ""

    # User-selected generation models. Empty = use the hardware recommendation.
    # gen_lm_model special value "none" = explicitly no LM (DiT only).
    gen_dit_model: str = ""
    gen_lm_model: str = ""
    # Generation performance profile: conservative | standard | quality.
    generation_performance_mode: str = "conservative"
    # Where ACE-Step writes intermediate/temp audio (api_audio etc). Empty =
    # Must be configured by the user. Passed to the sidecar as ACESTEP_TMPDIR.
    acestep_tmp_dir: str = ""

    # Where the SVC sidecar stores trained voice models. Must be configured.
    # Passed to the sidecar as SVC_MODELS_DIR.
    svc_models_dir: str = ""

    # Runtime vendor dir (ffmpeg/micromamba, auto-installed on first ACE-Step run).
    # Empty = <workspace>/vendor, falling back to the in-project vendor/ dir.
    # Read by start.sh / launch_acestep.sh; large (~600M) so users can point it at a big disk.
    vendor_dir: str = ""
    # Where the ACE-Step source zip (ACE-Step-1.5-main.zip) is kept.
    # Empty = <workspace>/resources, falling back to the in-project resources/ dir.
    resources_dir: str = ""


_lock = threading.Lock()


def load_runtime_settings() -> RuntimeSettings:
    path = settings.settings_file
    if path.exists():
        try:
            return RuntimeSettings.model_validate_json(path.read_text("utf-8"))
        except Exception:
            pass
    return RuntimeSettings()


def save_runtime_settings(rs: RuntimeSettings) -> RuntimeSettings:
    with _lock:
        settings.settings_file.write_text(rs.model_dump_json(indent=2), "utf-8")
    return rs


import os


RUNTIME_DIR_LABELS = {
    "workspace_dir": "工作目录",
    "acestep_checkpoints_dir": "ACE-Step 模型存放目录",
    "lora_dir": "LoRA 存放目录",
    "generation_output_dir": "生成缓存目录",
    "history_output_dir": "历史歌曲存放目录",
    "separation_output_dir": "分轨结果存放目录",
    "acestep_tmp_dir": "ACE-Step 临时缓存目录",
    "uploads_dir": "上传暂存目录",
    "svc_models_dir": "SVC 音源存放目录",
    "edit_output_dir": "音乐编辑导出目录",
    "vendor_dir": "运行时依赖目录(ffmpeg/micromamba)",
    "resources_dir": "ACE-Step 源码包目录",
}

WORKSPACE_CHILDREN = {
    "acestep_checkpoints_dir": "ace/models",
    # LoRA adapters live under the checkpoints tree so the ACE-Step sidecar can
    # reach them without a separate mount/env var.
    "lora_dir": "ace/models/loras",
    "generation_output_dir": "ace/generation",
    "history_output_dir": "ace/generation_history",
    "separation_output_dir": "separation/outputs",
    "uploads_dir": "uploads",
    # Keep ACE-Step temp files under the ACE partition so generation, SVC, and
    # separation artifacts never share the same cache tree.
    "acestep_tmp_dir": "ace/generation/tmp",
    "svc_models_dir": "svc/models",
    "edit_output_dir": "edits/outputs",
}


def workspace_dir(rs: RuntimeSettings | None = None) -> Path | None:
    rs = rs or load_runtime_settings()
    value = rs.workspace_dir.strip()
    if not value:
        return None
    return Path(value).expanduser()


def configured_runtime_dir(key: str, rs: RuntimeSettings | None = None) -> Path | None:
    rs = rs or load_runtime_settings()
    root = workspace_dir(rs)
    if root is not None and key in WORKSPACE_CHILDREN:
        return root / WORKSPACE_CHILDREN[key]
    if key == "workspace_dir":
        return root
    value = str(getattr(rs, key, "") or "").strip()
    if not value:
        return None
    return Path(value).expanduser()


def configured_runtime_dir_text(key: str, rs: RuntimeSettings | None = None) -> str:
    path = configured_runtime_dir(key, rs)
    return str(path) if path is not None else ""


def missing_runtime_dirs(keys: list[str] | tuple[str, ...], rs: RuntimeSettings | None = None) -> list[str]:
    rs = rs or load_runtime_settings()
    if any(key in WORKSPACE_CHILDREN or key == "workspace_dir" for key in keys):
        if workspace_dir(rs) is None:
            return [RUNTIME_DIR_LABELS["workspace_dir"]]
        return []
    return [RUNTIME_DIR_LABELS.get(key, key) for key in keys if configured_runtime_dir(key, rs) is None]


def ensure_runtime_dirs(keys: list[str] | tuple[str, ...], rs: RuntimeSettings | None = None) -> None:
    rs = rs or load_runtime_settings()
    missing = missing_runtime_dirs(keys, rs)
    if missing:
        raise RuntimeError(f"请先在设置中配置目录：{'、'.join(missing)}。应用不会使用默认目录启动对应服务。")
    for key in keys:
        path = configured_runtime_dir(key, rs)
        if path is not None:
            path.mkdir(parents=True, exist_ok=True)


def effective_checkpoints_dir(rs: RuntimeSettings | None = None) -> Path:
    """Resolve where ACE-Step model checkpoints live.

    Priority: runtime override -> ACESTEP_CHECKPOINTS_DIR env -> <acestep_dir>/checkpoints.
    """
    rs = rs or load_runtime_settings()
    configured = configured_runtime_dir("acestep_checkpoints_dir", rs)
    if configured is not None:
        return configured
    if rs.acestep_checkpoints_dir.strip():
        return Path(rs.acestep_checkpoints_dir).expanduser()
    env_dir = os.environ.get("ACESTEP_CHECKPOINTS_DIR", "").strip()
    if env_dir:
        return Path(env_dir).expanduser()
    return (settings.acestep_dir / "checkpoints").resolve()


def effective_lora_dir(rs: RuntimeSettings | None = None) -> Path:
    """Resolve where music-generation LoRA adapters are stored.

    Priority: workspace child -> explicit lora_dir -> <checkpoints>/loras.
    Always kept under the checkpoints tree so the ACE-Step sidecar can read it.
    """
    rs = rs or load_runtime_settings()
    configured = configured_runtime_dir("lora_dir", rs)
    if configured is not None:
        p = configured
    elif rs.lora_dir.strip():
        p = Path(rs.lora_dir).expanduser()
    else:
        p = effective_checkpoints_dir(rs) / "loras"
    p.mkdir(parents=True, exist_ok=True)
    return p


def effective_generation_dir(rs: RuntimeSettings | None = None) -> Path:
    """Resolve where the backend saves generated audio for the user."""
    rs = rs or load_runtime_settings()
    configured = configured_runtime_dir("generation_output_dir", rs)
    if configured is not None:
        p = configured
    elif rs.generation_output_dir.strip():
        p = Path(rs.generation_output_dir).expanduser()
    else:
        p = settings.generation_dir
    p.mkdir(parents=True, exist_ok=True)
    return p


def effective_history_dir(rs: RuntimeSettings | None = None) -> Path:
    """Resolve where completed songs are permanently archived."""
    rs = rs or load_runtime_settings()
    configured = configured_runtime_dir("history_output_dir", rs)
    if configured is not None:
        p = configured
    elif rs.history_output_dir.strip():
        p = Path(rs.history_output_dir).expanduser()
    else:
        p = settings.generation_history_dir
    p.mkdir(parents=True, exist_ok=True)
    return p


def effective_separation_dir(rs: RuntimeSettings | None = None) -> Path:
    """Resolve where separated stem outputs are stored and read from."""
    rs = rs or load_runtime_settings()
    configured = configured_runtime_dir("separation_output_dir", rs)
    if configured is not None:
        p = configured
    elif rs.separation_output_dir.strip():
        p = Path(rs.separation_output_dir).expanduser()
    else:
        p = settings.outputs_dir
    p.mkdir(parents=True, exist_ok=True)
    return p


def effective_uploads_dir(rs: RuntimeSettings | None = None) -> Path:
    """Resolve where uploaded source/reference files are staged."""
    rs = rs or load_runtime_settings()
    configured = configured_runtime_dir("uploads_dir", rs)
    if configured is not None:
        p = configured
    else:
        p = settings.uploads_dir
    p.mkdir(parents=True, exist_ok=True)
    return p


def effective_edit_dir(rs: RuntimeSettings | None = None) -> Path:
    """Resolve where music-editor mixdown outputs are stored and read from."""
    rs = rs or load_runtime_settings()
    configured = configured_runtime_dir("edit_output_dir", rs)
    if configured is not None:
        p = configured
    else:
        p = settings.edits_dir
    p.mkdir(parents=True, exist_ok=True)
    return p
