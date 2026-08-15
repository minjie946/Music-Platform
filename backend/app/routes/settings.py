"""Runtime settings endpoints (default engine + LALAL.AI API key)."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from .. import hardware
from ..config import (
    configured_runtime_dir,
    configured_runtime_dir_text,
    ensure_runtime_dirs,
    load_runtime_settings,
    save_runtime_settings,
    settings,
)
from ..models import RuntimeSettingsIn, RuntimeSettingsOut

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ---------------------------------------------------------------------------
# Directory browser (invokes OS-native folder picker)
# ---------------------------------------------------------------------------

class BrowseDirRequest(BaseModel):
    title: str = "选择目录"


class BrowseDirResponse(BaseModel):
    path: str = ""
    cancelled: bool = False


@router.post("/browse-directory", response_model=BrowseDirResponse)
def browse_directory(payload: BrowseDirRequest) -> BrowseDirResponse:
    """Open the OS-native folder picker and return the selected path."""
    try:
        path = _pick_folder()
    except Exception:
        path = ""
    return BrowseDirResponse(path=path or "", cancelled=not path)


def _pick_folder() -> str | None:
    plat = sys.platform
    prompt = "选择目录"
    try:
        if plat == "darwin":
            # macOS: osascript is always available
            script = f'POSIX path of (choose folder with prompt "{prompt}")'
            result = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0:
                return result.stdout.strip()
            return None  # user cancelled

        elif plat == "win32":
            # Windows: PowerShell FolderBrowserDialog
            ps_script = """
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '选择目录'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }
"""
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_script],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0:
                return result.stdout.strip() or None
            return None

        else:
            # Linux: try zenity, then kdialog
            for cmd in [
                ["zenity", "--file-selection", "--directory", f"--title={prompt}"],
                ["kdialog", "--getexistingdirectory", prompt],
            ]:
                try:
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
                    if result.returncode == 0:
                        return result.stdout.strip()
                except FileNotFoundError:
                    continue
            return None

    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None


def _mask(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 4:
        return "*" * len(key)
    return f"{key[:2]}{'*' * (len(key) - 4)}{key[-2:]}"


def _to_out(rs, migration_summary: list[str] | None = None) -> RuntimeSettingsOut:
    return RuntimeSettingsOut(
        default_engine=rs.default_engine,
        lalal_api_key_set=bool(rs.lalal_api_key),
        lalal_api_key_masked=_mask(rs.lalal_api_key),
        cascade_vocal_split=rs.cascade_vocal_split,
        karaoke_model=rs.karaoke_model,
        workspace_dir=rs.workspace_dir,
        acestep_checkpoints_dir=rs.acestep_checkpoints_dir,
        generation_output_dir=rs.generation_output_dir,
        history_output_dir=rs.history_output_dir,
        separation_output_dir=rs.separation_output_dir,
        acestep_tmp_dir=rs.acestep_tmp_dir,
        gen_dit_model=rs.gen_dit_model,
        gen_lm_model=rs.gen_lm_model,
        generation_performance_mode=hardware.normalize_performance_mode(rs.generation_performance_mode),
        svc_models_dir=rs.svc_models_dir,
        vendor_dir=rs.vendor_dir,
        resources_dir=rs.resources_dir,
        effective_checkpoints_dir=configured_runtime_dir_text("acestep_checkpoints_dir", rs),
        effective_generation_dir=configured_runtime_dir_text("generation_output_dir", rs),
        effective_history_dir=configured_runtime_dir_text("history_output_dir", rs),
        effective_separation_dir=configured_runtime_dir_text("separation_output_dir", rs),
        effective_acestep_tmp_dir=configured_runtime_dir_text("acestep_tmp_dir", rs),
        effective_uploads_dir=configured_runtime_dir_text("uploads_dir", rs),
        effective_svc_models_dir=configured_runtime_dir_text("svc_models_dir", rs),
        path_migration_summary=migration_summary or [],
    )


@router.get("", response_model=RuntimeSettingsOut)
def get_settings() -> RuntimeSettingsOut:
    return _to_out(load_runtime_settings())


@router.put("", response_model=RuntimeSettingsOut)
def put_settings(payload: RuntimeSettingsIn) -> RuntimeSettingsOut:
    rs = load_runtime_settings()
    old_checkpoints_dir = configured_runtime_dir("acestep_checkpoints_dir", rs)
    old_history_dir = configured_runtime_dir("history_output_dir", rs)
    old_separation_dir = configured_runtime_dir("separation_output_dir", rs)
    old_uploads_dir = configured_runtime_dir("uploads_dir", rs)
    old_temp_dir = configured_runtime_dir("acestep_tmp_dir", rs)
    old_svc_models_dir = configured_runtime_dir("svc_models_dir", rs)
    migration_summary: list[str] = []
    if payload.default_engine is not None:
        rs.default_engine = payload.default_engine
    if payload.lalal_api_key is not None:
        # Empty string clears the key; otherwise replace it.
        rs.lalal_api_key = payload.lalal_api_key.strip()
    if payload.cascade_vocal_split is not None:
        rs.cascade_vocal_split = payload.cascade_vocal_split
    if payload.karaoke_model is not None and payload.karaoke_model.strip():
        rs.karaoke_model = payload.karaoke_model.strip()
    if payload.workspace_dir is not None:
        rs.workspace_dir = payload.workspace_dir.strip()
        if rs.workspace_dir:
            rs.acestep_checkpoints_dir = ""
            rs.generation_output_dir = ""
            rs.history_output_dir = ""
            rs.separation_output_dir = ""
            rs.acestep_tmp_dir = ""
            rs.svc_models_dir = ""
    if payload.acestep_checkpoints_dir is not None:
        rs.acestep_checkpoints_dir = payload.acestep_checkpoints_dir.strip()
    if payload.generation_output_dir is not None:
        rs.generation_output_dir = payload.generation_output_dir.strip()
    if payload.history_output_dir is not None:
        rs.history_output_dir = payload.history_output_dir.strip()
    if payload.separation_output_dir is not None:
        rs.separation_output_dir = payload.separation_output_dir.strip()
    if payload.acestep_tmp_dir is not None:
        rs.acestep_tmp_dir = payload.acestep_tmp_dir.strip()
    if payload.gen_dit_model is not None:
        rs.gen_dit_model = payload.gen_dit_model.strip()
    if payload.gen_lm_model is not None:
        rs.gen_lm_model = payload.gen_lm_model.strip()
    if payload.generation_performance_mode is not None:
        rs.generation_performance_mode = hardware.normalize_performance_mode(
            payload.generation_performance_mode
        )
    if payload.svc_models_dir is not None:
        rs.svc_models_dir = payload.svc_models_dir.strip()
    # vendor / resources 是独立的大文件目录（可指向大盘），不随 workspace 清空。
    # 留空表示回退到 <workspace>/vendor、<workspace>/resources，最后回退项目内。
    if payload.vendor_dir is not None:
        rs.vendor_dir = payload.vendor_dir.strip()
    if payload.resources_dir is not None:
        rs.resources_dir = payload.resources_dir.strip()
    save_runtime_settings(rs)
    if payload.migrate_existing_data:
        new_checkpoints_dir = configured_runtime_dir("acestep_checkpoints_dir", rs)
        new_history_dir = configured_runtime_dir("history_output_dir", rs)
        new_separation_dir = configured_runtime_dir("separation_output_dir", rs)
        new_uploads_dir = configured_runtime_dir("uploads_dir", rs)
        new_svc_models_dir = configured_runtime_dir("svc_models_dir", rs)
        if old_checkpoints_dir is not None and new_checkpoints_dir is not None:
            migration_summary.extend(
                _migrate_path_contents("ACE-Step 模型", old_checkpoints_dir, new_checkpoints_dir)
            )
        if old_history_dir is not None and new_history_dir is not None:
            migration_summary.extend(
                _migrate_path_contents("历史歌曲", old_history_dir, new_history_dir)
            )
        if old_separation_dir is not None and new_separation_dir is not None:
            migration_summary.extend(
                _migrate_path_contents("分轨结果", old_separation_dir, new_separation_dir)
            )
        if old_uploads_dir is not None and new_uploads_dir is not None:
            migration_summary.extend(
                _migrate_path_contents("上传暂存", old_uploads_dir, new_uploads_dir)
            )
        if old_svc_models_dir is not None and new_svc_models_dir is not None:
            migration_summary.extend(
                _migrate_path_contents("SVC 音源", old_svc_models_dir, new_svc_models_dir)
            )
    if payload.cleanup_old_temp_cache:
        new_temp_dir = configured_runtime_dir("acestep_tmp_dir", rs)
        if old_temp_dir is not None and new_temp_dir is not None:
            migration_summary.extend(_cleanup_old_temp_cache(old_temp_dir, new_temp_dir))
    if rs.workspace_dir.strip():
        ensure_runtime_dirs((
            "acestep_checkpoints_dir",
            "generation_output_dir",
            "history_output_dir",
            "separation_output_dir",
            "uploads_dir",
            "acestep_tmp_dir",
            "svc_models_dir",
        ), rs)
    return _to_out(rs, migration_summary)


def _cleanup_old_temp_cache(old_dir: Path, new_dir: Path) -> list[str]:
    old_dir = old_dir.expanduser().resolve()
    new_dir = new_dir.expanduser().resolve()
    if old_dir == new_dir:
        return []
    if not old_dir.exists():
        return []
    if not old_dir.is_dir():
        return [f"旧临时缓存未清理：旧路径不是目录：{old_dir}"]
    if _contains_path(old_dir, new_dir) or _contains_path(new_dir, old_dir):
        return [f"旧临时缓存未清理：新旧目录存在包含关系，请手动整理：{old_dir} -> {new_dir}"]
    if _is_protected_cleanup_dir(old_dir):
        return [f"旧临时缓存未清理：路径过于宽泛或受保护，请手动确认后清理：{old_dir}"]

    deleted = 0
    skipped = 0
    for item in old_dir.iterdir():
        try:
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()
            deleted += 1
        except OSError:
            skipped += 1

    removed_dir = False
    try:
        old_dir.rmdir()
        removed_dir = True
    except OSError:
        pass

    if deleted and skipped:
        return [f"旧临时缓存已清理 {deleted} 项，{skipped} 项因权限或占用未删除。"]
    if deleted:
        suffix = "，旧缓存目录已删除。" if removed_dir else "。"
        return [f"旧临时缓存已清理 {deleted} 项{suffix}"]
    if skipped:
        return [f"旧临时缓存未完全清理：{skipped} 项因权限或占用未删除。"]
    if removed_dir:
        return ["旧临时缓存目录为空，已删除旧目录。"]
    return []


def _is_protected_cleanup_dir(path: Path) -> bool:
    home = Path.home().resolve()
    protected = {
        Path("/").resolve(),
        home,
        (home / "Desktop").resolve(),
        (home / "Documents").resolve(),
        (home / "Downloads").resolve(),
        (home / "Movies").resolve(),
        (home / "Music").resolve(),
        (home / "Pictures").resolve(),
        settings.data_dir.expanduser().resolve(),
        Path.cwd().resolve(),
    }
    if path in protected:
        return True
    safe_markers = {"cache", ".cache", "tmp", "temp", "acestep"}
    parts = {part.lower() for part in path.parts}
    return not bool(parts & safe_markers)


def _migrate_path_contents(label: str, old_dir: Path, new_dir: Path) -> list[str]:
    old_dir = old_dir.expanduser().resolve()
    new_dir = new_dir.expanduser().resolve()
    if old_dir == new_dir:
        return []
    if not old_dir.exists():
        return []
    if not old_dir.is_dir():
        return [f"{label}未迁移：旧路径不是目录：{old_dir}"]
    try:
        if not any(old_dir.iterdir()):
            return []
    except OSError as exc:
        return [f"{label}未迁移：无法读取旧目录：{exc}"]
    if _contains_path(old_dir, new_dir) or _contains_path(new_dir, old_dir):
        return [f"{label}未迁移：新旧目录存在包含关系，请手动整理：{old_dir} -> {new_dir}"]

    new_dir.mkdir(parents=True, exist_ok=True)
    moved = 0
    skipped = 0
    for item in old_dir.iterdir():
        target = new_dir / item.name
        try:
            if target.exists():
                if item.is_dir() and target.is_dir():
                    sub_moved, sub_skipped = _merge_dir(item, target)
                    moved += sub_moved
                    skipped += sub_skipped
                    try:
                        item.rmdir()
                    except OSError:
                        pass
                else:
                    skipped += 1
                continue
            shutil.move(str(item), str(target))
            moved += 1
        except OSError:
            skipped += 1

    try:
        old_dir.rmdir()
    except OSError:
        pass

    if moved and skipped:
        return [f"{label}已迁移 {moved} 项到新目录，{skipped} 项因同名冲突或权限问题保留在旧目录。"]
    if moved:
        return [f"{label}已迁移 {moved} 项到新目录。"]
    if skipped:
        return [f"{label}未完成迁移：{skipped} 项因同名冲突或权限问题保留在旧目录。"]
    return []


def _merge_dir(src: Path, dst: Path) -> tuple[int, int]:
    moved = 0
    skipped = 0
    for item in src.iterdir():
        target = dst / item.name
        try:
            if target.exists():
                if item.is_dir() and target.is_dir():
                    sub_moved, sub_skipped = _merge_dir(item, target)
                    moved += sub_moved
                    skipped += sub_skipped
                    try:
                        item.rmdir()
                    except OSError:
                        pass
                else:
                    skipped += 1
                continue
            shutil.move(str(item), str(target))
            moved += 1
        except OSError:
            skipped += 1
    return moved, skipped


def _contains_path(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False
