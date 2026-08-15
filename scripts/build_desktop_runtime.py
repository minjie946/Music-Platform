#!/usr/bin/env python3
"""Build a relocatable desktop Python runtime archive for the current platform."""
from __future__ import annotations

import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import hashlib
import time
from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
SVC_SERVICE = ROOT / "svc_service"
FRONTEND = ROOT / "frontend"
RUNTIME = FRONTEND / "src-tauri" / "desktop-runtime"
WORK = FRONTEND / "src-tauri" / "target" / "desktop-runtime-build"
BUILDROOT = WORK / "desktop-runtime"
PYTHON_DST = BUILDROOT / "python" / "cpython"
VENV = BUILDROOT / "backend-runtime" / ".venv"
TOOLS_DST = BUILDROOT / "tools"
ARCHIVE = RUNTIME / "backend-runtime.tar.gz"
MARKER = RUNTIME / ".runtime-ready"
SVC_BUILDROOT = WORK / "svc-runtime"
SVC_PYTHON_DST = SVC_BUILDROOT / "python" / "cpython"
SVC_VENV = SVC_BUILDROOT / "service-runtime" / ".venv"
SVC_ARCHIVE = RUNTIME / "svc-runtime.tar.gz"
SVC_MARKER = RUNTIME / ".svc-runtime-ready"


def _read_setting(key: str) -> str:
    """读取运行时设置（与 shell 的 read_setting 一致）：打包/桌面用 APP_DATA_DIR，
    否则回退 backend/data/settings.json。取不到返回空串。"""
    import json

    candidates = []
    data_dir = os.environ.get("APP_DATA_DIR", "").strip()
    if data_dir:
        candidates.append(Path(data_dir).expanduser() / "settings.json")
    candidates.append(BACKEND / "data" / "settings.json")
    for path in candidates:
        try:
            if path.is_file():
                return str(json.loads(path.read_text("utf-8")).get(key) or "").strip()
        except Exception:
            continue
    return ""


def _resolve_acestep_source_zip() -> Path:
    """解析 ACE-Step 源码包路径，优先级与 launch_acestep.sh 保持一致：
    ACESTEP_SOURCE_ZIP 环境变量 > settings.resources_dir > <workspace>/resources > 项目内。"""
    env = os.environ.get("ACESTEP_SOURCE_ZIP", "").strip()
    if env:
        return Path(env).expanduser()
    rd = _read_setting("resources_dir")
    if rd:
        return Path(rd).expanduser() / "ACE-Step-1.5-main.zip"
    ws = _read_setting("workspace_dir")
    if ws:
        return Path(ws).expanduser() / "resources" / "ACE-Step-1.5-main.zip"
    return ROOT / "resources" / "ACE-Step-1.5-main.zip"


ACESTEP_SOURCE_ZIP = _resolve_acestep_source_zip()
ACESTEP_BUILDROOT = WORK / "acestep-runtime"
ACESTEP_SOURCE_DIR = ACESTEP_BUILDROOT / "ACE-Step-1.5"
ACESTEP_PYTHON_DST = ACESTEP_BUILDROOT / "python" / "cpython"
ACESTEP_VENV = ACESTEP_SOURCE_DIR / ".venv"
ACESTEP_ARCHIVE = RUNTIME / "acestep-runtime.tar.gz"
ACESTEP_MARKER = RUNTIME / ".acestep-runtime-ready"
ACESTEP_PATCH_VERSION = "checkpoints-dir-v3"
ACESTEP_WINDOWS_PART_SIZE = int(os.environ.get("ACESTEP_WINDOWS_PART_SIZE", str(256 * 1024 * 1024)))
IS_WINDOWS = os.name == "nt"
NETWORK_RETRIES = int(os.environ.get("NETWORK_RETRIES", "3"))
NETWORK_TIMEOUT = int(os.environ.get("NETWORK_TIMEOUT", "900"))
SHORT_NETWORK_TIMEOUT = int(os.environ.get("SHORT_NETWORK_TIMEOUT", "180"))
MIRROR_FALLBACK_ATTEMPTS = int(os.environ.get("MIRROR_FALLBACK_ATTEMPTS", "1"))
PYPI_MIRROR_URL = os.environ.get("PYPI_MIRROR_URL", "https://pypi.tuna.tsinghua.edu.cn/simple")
PYTORCH_CPU_MIRROR_URL = os.environ.get(
    "PYTORCH_CPU_MIRROR_URL",
    "https://mirror.sjtu.edu.cn/pytorch-wheels/cpu",
)


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def log(message: str) -> None:
    print(f"[desktop:runtime] {message}", flush=True)


def run_once(
    args: list[str],
    *,
    cwd: Path | None,
    env: dict[str, str],
    label: str,
    attempts: int = NETWORK_RETRIES,
    timeout: int = NETWORK_TIMEOUT,
) -> Exception | None:
    delay = 3
    for attempt in range(1, attempts + 1):
        try:
            log(f"{label}（第 {attempt}/{attempts} 次，超时 {timeout}s）：{' '.join(map(str, args))}")
            subprocess.run(
                args,
                cwd=str(cwd or ROOT),
                env=env,
                check=True,
                timeout=timeout,
            )
            return None
        except subprocess.TimeoutExpired as exc:
            last_error: Exception = exc
            log(f"命令超时：{' '.join(map(str, args))}")
        except subprocess.CalledProcessError as exc:
            last_error = exc
            log(f"命令失败 exit={exc.returncode}: {' '.join(map(str, args))}")
        if attempt < attempts:
            log(f"{delay}s 后重试...")
            time.sleep(delay)
            delay *= 2
    return last_error


def mirrored_command(args: list[str], env: dict[str, str]) -> tuple[list[str], dict[str, str], str] | None:
    cmd = [str(item) for item in args]
    mirrored_env = env.copy()
    if "uv" in Path(cmd[0]).name and cmd[1:3] == ["pip", "install"]:
        if "https://download.pytorch.org/whl/cpu" in cmd:
            if platform.system() == "Darwin":
                mirrored = [
                    item
                    for item in cmd
                    if item not in ("--index-url", "https://download.pytorch.org/whl/cpu")
                ]
                mirrored = mirrored[:3] + ["--index-url", PYPI_MIRROR_URL] + mirrored[3:]
                return mirrored, mirrored_env, f"macOS 临时切换到国内 PyPI 镜像：{PYPI_MIRROR_URL}"
            mirrored = [
                PYTORCH_CPU_MIRROR_URL if item == "https://download.pytorch.org/whl/cpu" else item
                for item in cmd
            ]
            return mirrored, mirrored_env, f"临时切换到国内 PyTorch CPU 镜像：{PYTORCH_CPU_MIRROR_URL}"
        if "-r" in cmd and "--index-url" not in cmd:
            mirrored = cmd[:3] + ["--index-url", PYPI_MIRROR_URL] + cmd[3:]
            return mirrored, mirrored_env, f"临时切换到国内 PyPI 镜像：{PYPI_MIRROR_URL}"
        if "--index-url" not in cmd:
            mirrored = cmd[:3] + ["--index-url", PYPI_MIRROR_URL] + cmd[3:]
            return mirrored, mirrored_env, f"临时切换到国内 PyPI 镜像：{PYPI_MIRROR_URL}"
    if "uv" in Path(cmd[0]).name and cmd[1:2] == ["sync"]:
        mirrored_env["UV_DEFAULT_INDEX"] = PYPI_MIRROR_URL
        mirrored = cmd[:2] + ["--default-index", PYPI_MIRROR_URL] + cmd[2:]
        return mirrored, mirrored_env, f"临时切换到国内 PyPI 镜像：{PYPI_MIRROR_URL}"
    if "uv" in Path(cmd[0]).name and cmd[1:3] == ["python", "install"] and os.environ.get("UV_PYTHON_INSTALL_MIRROR"):
        mirrored_env["UV_PYTHON_INSTALL_MIRROR"] = os.environ["UV_PYTHON_INSTALL_MIRROR"]
        return cmd, mirrored_env, f"临时使用 UV_PYTHON_INSTALL_MIRROR={os.environ['UV_PYTHON_INSTALL_MIRROR']}"
    return None


def run(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    merged_env = os.environ.copy()
    merged_env["UV_SYSTEM_CERTS"] = "1"
    if env:
        merged_env.update(env)
    mirror = mirrored_command(args, merged_env)
    attempts = MIRROR_FALLBACK_ATTEMPTS if mirror is not None else NETWORK_RETRIES
    timeout = SHORT_NETWORK_TIMEOUT if mirror is not None else NETWORK_TIMEOUT
    last_error = run_once(args, cwd=cwd, env=merged_env, label="运行命令", attempts=attempts, timeout=timeout)
    if last_error is None:
        return
    if mirror is not None:
        mirrored_args, mirrored_env, message = mirror
        log(f"默认源失败，{message}")
        last_error = run_once(mirrored_args, cwd=cwd, env=mirrored_env, label="运行镜像命令")
        if last_error is None:
            return
    raise SystemExit(f"[desktop:runtime] 命令多次失败：{' '.join(map(str, args))} ({last_error})")


def output(args: list[str], *, cwd: Path | None = None) -> str:
    env = os.environ.copy()
    env["UV_SYSTEM_CERTS"] = "1"
    delay = 3
    for attempt in range(1, NETWORK_RETRIES + 1):
        try:
            return subprocess.check_output(
                args,
                cwd=str(cwd or ROOT),
                env=env,
                text=True,
                timeout=NETWORK_TIMEOUT,
            ).strip()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            last_error: Exception = exc
            if attempt < NETWORK_RETRIES:
                log(f"命令输出读取失败，{delay}s 后重试：{' '.join(map(str, args))}")
                time.sleep(delay)
                delay *= 2
    raise SystemExit(f"[desktop:runtime] 命令多次失败：{' '.join(map(str, args))} ({last_error})")


def find_command(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    raise SystemExit(f"[desktop:runtime] 未找到 {name}，请先安装或加入 PATH")


def copy_uv_python(uv: str, version: str, destination: Path) -> Path:
    run([uv, "python", "install", version])
    py_src_bin = Path(output([uv, "python", "find", "--managed-python", version]))
    py_src_home = Path(
        output(
            [
                str(py_src_bin),
                "-c",
                "import sys; print(sys.base_prefix)",
            ]
        )
    )
    if not py_src_home.exists():
        raise SystemExit(f"[desktop:runtime] 无法定位 uv 管理的 Python {version}: {py_src_home}")
    if "Cellar" in str(py_src_home) or "Frameworks/Python.framework" in str(py_src_home):
        raise SystemExit(
            f"[desktop:runtime] 拒绝打包系统/Homebrew Python {version}: {py_src_home}。"
            "请确认 uv 支持 --managed-python，或先运行：uv python install "
            f"{version}"
        )
    shutil.copytree(py_src_home, destination, symlinks=True)
    return destination


def venv_python(venv: Path) -> Path:
    if IS_WINDOWS:
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def copied_python() -> Path:
    if IS_WINDOWS:
        return PYTHON_DST / "python.exe"
    return PYTHON_DST / "bin" / "python3.12"


def runtime_python(python_dst: Path, version: str) -> Path:
    if IS_WINDOWS:
        return python_dst / "python.exe"
    return python_dst / "bin" / f"python{version}"


def relative_home() -> str:
    if IS_WINDOWS:
        return r"..\..\..\python\cpython"
    return "../../../python/cpython/bin"


def patch_pyvenv_cfg() -> None:
    if IS_WINDOWS:
        return
    patch_venv_home(VENV, relative_home())


def patch_venv_home(venv: Path, home: str) -> None:
    cfg = venv / "pyvenv.cfg"
    lines = cfg.read_text("utf-8").splitlines()
    cfg.write_text(
        "\n".join(
            f"home = {home}" if line.startswith("home = ") else line
            for line in lines
        )
        + "\n",
        "utf-8",
    )


def patch_unix_python_symlinks() -> None:
    if IS_WINDOWS:
        return
    patch_unix_venv_python_symlinks(VENV, "../../../python/cpython/bin/python3.12", "3.12")


def patch_unix_venv_python_symlinks(venv: Path, target: str, version: str) -> None:
    if IS_WINDOWS:
        return
    bin_dir = venv / "bin"
    for name in ("python", "python3", f"python{version}"):
        try:
            (bin_dir / name).unlink()
        except FileNotFoundError:
            pass
    (bin_dir / "python").symlink_to(target)
    (bin_dir / "python3").symlink_to("python")
    (bin_dir / f"python{version}").symlink_to("python")


def normalize_permissions(path: Path) -> None:
    if IS_WINDOWS:
        return
    for item in path.rglob("*"):
        try:
            mode = item.stat().st_mode
            if item.is_dir():
                item.chmod(mode | stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
            else:
                item.chmod(mode | stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
        except OSError:
            pass


def archive_runtime() -> None:
    log("打包 runtime archive...")
    with tarfile.open(ARCHIVE, "w:gz", dereference=False) as tar:
        tar.add(BUILDROOT / "backend-runtime", arcname="backend-runtime")
        tar.add(BUILDROOT / "python", arcname="python")
        if TOOLS_DST.exists():
            tar.add(TOOLS_DST, arcname="tools")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def split_archive_for_windows(path: Path, part_size: int = ACESTEP_WINDOWS_PART_SIZE) -> int:
    if not IS_WINDOWS:
        return 0
    for old in path.parent.glob(f"{path.name}.part*"):
        old.unlink()
    index = 0
    with path.open("rb") as src:
        while True:
            chunk = src.read(part_size)
            if not chunk:
                break
            part = path.parent / f"{path.name}.part{index:03d}"
            part.write_bytes(chunk)
            index += 1
    if index:
        path.unlink()
        log(f"Windows ACE-Step runtime 已切分为 {index} 个资源块，避免 MSI/NSIS 处理超大单文件。")
    return index


def archive_or_parts_exist(path: Path) -> bool:
    return path.is_file() or any(path.parent.glob(f"{path.name}.part*"))


def files_sha256(paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(str(path.relative_to(ROOT)).encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_sha256(path).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def backend_requirements_hash() -> str:
    paths = [BACKEND / "requirements.txt"]
    if not IS_WINDOWS:
        paths.append(BACKEND / "requirements-dev.txt")
    return files_sha256([path for path in paths if path.is_file()])


def marker_matches(path: Path, expected: dict[str, str]) -> bool:
    if not path.is_file():
        return False
    try:
        values = dict(
            line.split("=", 1)
            for line in path.read_text("utf-8").splitlines()
            if "=" in line
        )
    except OSError:
        return False
    return all(values.get(key) == value for key, value in expected.items())


def install_backend_requirements(uv: str, py: Path) -> None:
    if IS_WINDOWS:
        run([uv, "pip", "install", "--python", str(py), "-r", str(BACKEND / "requirements.txt")])
        run([uv, "pip", "install", "--python", str(py), "static-ffmpeg==3.0"])
        return
    run([uv, "pip", "install", "--python", str(py), "-r", str(BACKEND / "requirements-dev.txt")])


def bundle_ffmpeg() -> None:
    """Bundle a self-contained ffmpeg/ffprobe into ``tools/``.

    We always fetch the *static* binaries via the ``static_ffmpeg`` package
    (downloaded on demand) rather than copying the build machine's system
    ffmpeg. System/Homebrew builds are dynamically linked and break on other
    machines when their shared libraries are missing; the static builds are
    relocatable and run anywhere. ``APP_FFMPEG_EXE``/``APP_FFPROBE_EXE`` still
    win when set, so CI can pre-provision known-good static binaries offline.
    """
    ffmpeg = os.environ.get("APP_FFMPEG_EXE")
    ffprobe = os.environ.get("APP_FFPROBE_EXE")
    if ffmpeg and ffprobe and Path(ffmpeg).is_file() and Path(ffprobe).is_file():
        log("使用 APP_FFMPEG_EXE/APP_FFPROBE_EXE 预置的 ffmpeg/ffprobe。")
    else:
        ffmpeg, ffprobe = _fetch_static_ffmpeg()

    if not ffmpeg or not ffprobe or not Path(ffmpeg).is_file() or not Path(ffprobe).is_file():
        raise SystemExit(
            "[desktop:runtime] 未能获取内置 ffmpeg/ffprobe。"
            " 打包会强制通过 static_ffmpeg 下载静态二进制，请检查网络，"
            " 或设置 APP_FFMPEG_EXE/APP_FFPROBE_EXE 指向可用的静态二进制。"
        )
    TOOLS_DST.mkdir(parents=True, exist_ok=True)
    for src, name in ((Path(ffmpeg), "ffmpeg"), (Path(ffprobe), "ffprobe")):
        dst = TOOLS_DST / (f"{name}.exe" if IS_WINDOWS else name)
        shutil.copy2(src, dst)
        if not IS_WINDOWS:
            dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    log(f"已内置 ffmpeg: {ffmpeg}")
    log(f"已内置 ffprobe: {ffprobe}")


def _fetch_static_ffmpeg() -> tuple[str, str]:
    """Download the platform static ffmpeg/ffprobe via the venv's static_ffmpeg.

    Returns (ffmpeg_path, ffprobe_path). Raises SystemExit after retries fail.
    """
    code = (
        "import os, glob\n"
        "from pathlib import Path\n"
        "import static_ffmpeg\n"
        "from static_ffmpeg import run\n"
        "ffmpeg = ffprobe = None\n"
        "for attr in ('get_or_fetch_platform_executables_else_raise', 'get_or_fetch_platform_executables'):\n"
        "    fn = getattr(run, attr, None)\n"
        "    if fn is None:\n"
        "        continue\n"
        "    got = fn()\n"
        "    if isinstance(got, (list, tuple)) and len(got) >= 2:\n"
        "        ffmpeg, ffprobe = got[0], got[1]\n"
        "        break\n"
        "if not ffmpeg or not ffprobe:\n"
        "    base = Path(static_ffmpeg.__file__).parent / 'bin'\n"
        "    def find(tool):\n"
        "        names = [tool + '.exe', tool] if os.name == 'nt' else [tool]\n"
        "        for name in names:\n"
        "            for item in glob.glob(str(base / '*' / name)):\n"
        "                if os.path.isfile(item):\n"
        "                    return item\n"
        "        return ''\n"
        "    ffmpeg = ffmpeg or find('ffmpeg')\n"
        "    ffprobe = ffprobe or find('ffprobe')\n"
        "print(ffmpeg)\n"
        "print(ffprobe)\n"
    )
    py = venv_python(VENV)
    last_exc: Exception | None = None
    for attempt in range(1, NETWORK_RETRIES + 1):
        try:
            log(f"下载静态 ffmpeg/ffprobe（第 {attempt}/{NETWORK_RETRIES} 次）...")
            out = subprocess.check_output([str(py), "-c", code], text=True).splitlines()
            if len(out) >= 2 and out[0] and out[1]:
                return out[0], out[1]
            last_exc = RuntimeError(f"static_ffmpeg 返回异常输出: {out!r}")
        except Exception as exc:
            last_exc = exc
            log(f"下载 ffmpeg 失败: {exc}")
        if attempt < NETWORK_RETRIES:
            time.sleep(3 * attempt)
    raise SystemExit(f"[desktop:runtime] 下载静态 ffmpeg/ffprobe 失败: {last_exc}")


def build_svc_runtime(uv: str, force: bool) -> None:
    if os.environ.get("BUILD_SVC_RUNTIME", "1") == "0":
        log("跳过 SVC runtime（BUILD_SVC_RUNTIME=0）。")
        SVC_ARCHIVE.unlink(missing_ok=True)
        SVC_MARKER.unlink(missing_ok=True)
        return
    expected_marker = {"platform": f"{platform.system()}-{platform.machine()}", "python": "3.11"}
    if not force and SVC_ARCHIVE.is_file() and marker_matches(SVC_MARKER, expected_marker):
        log("已存在 SVC runtime archive，跳过。")
        return

    log("构建 SVC 独立 runtime (Python 3.11)...")
    SVC_ARCHIVE.unlink(missing_ok=True)
    shutil.rmtree(SVC_BUILDROOT, ignore_errors=True)
    (SVC_BUILDROOT / "python").mkdir(parents=True, exist_ok=True)
    (SVC_BUILDROOT / "service-runtime").mkdir(parents=True, exist_ok=True)

    copy_uv_python(uv, "3.11", SVC_PYTHON_DST)
    svc_python = runtime_python(SVC_PYTHON_DST, "3.11")
    run([uv, "venv", "--python", str(svc_python), "--relocatable", "--link-mode", "copy", str(SVC_VENV)])
    py = venv_python(SVC_VENV)
    run([uv, "pip", "install", "--python", str(py), str(SVC_SERVICE)])
    run(
        [
            str(py),
            "-c",
            "import fastapi, uvicorn, so_vits_svc_fork, torch, torchaudio, sys; print('[desktop:runtime] verified svc python=' + sys.version.split()[0])",
        ]
    )

    if not IS_WINDOWS:
        patch_unix_venv_python_symlinks(SVC_VENV, "../../../python/cpython/bin/python3.11", "3.11")
        patch_venv_home(SVC_VENV, "../../../python/cpython/bin")
    normalize_permissions(SVC_BUILDROOT)
    log("打包 SVC runtime archive...")
    with tarfile.open(SVC_ARCHIVE, "w:gz", dereference=False) as tar:
        tar.add(SVC_BUILDROOT / "service-runtime", arcname="service-runtime")
        tar.add(SVC_BUILDROOT / "python", arcname="python")
    SVC_MARKER.write_text(
        "\n".join(
            [
                f"platform={platform.system()}-{platform.machine()}",
                "python=3.11",
                f"archive={SVC_ARCHIVE.name}",
                f"sha256={file_sha256(SVC_ARCHIVE)}",
            ]
        )
        + "\n",
        "utf-8",
    )
    log(f"完成：{SVC_ARCHIVE} ({SVC_ARCHIVE.stat().st_size / (1024 * 1024):.1f} MiB)")


def build_acestep_runtime_enabled() -> bool:
    return os.environ.get("BUILD_ACESTEP_RUNTIME", "1") != "0"


def env_flag(name: str) -> bool:
    return os.environ.get(name) == "1"


def extract_acestep_source() -> None:
    if not ACESTEP_SOURCE_ZIP.is_file():
        raise SystemExit(
            f"[desktop:runtime] 未找到本地 ACE-Step 源码包: {ACESTEP_SOURCE_ZIP}。"
            "开发和打包都不会再从 GitHub clone，请先放置 resources/ACE-Step-1.5-main.zip。"
        )
    log(f"解压本地 ACE-Step 源码包: {ACESTEP_SOURCE_ZIP}")
    tmp = ACESTEP_BUILDROOT / ".source-extract"
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(ACESTEP_SOURCE_DIR, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    with ZipFile(ACESTEP_SOURCE_ZIP) as zf:
        zf.extractall(tmp)
    entries = [p for p in tmp.iterdir() if p.name != "__MACOSX"]
    if len(entries) == 1 and entries[0].is_dir():
        shutil.move(str(entries[0]), str(ACESTEP_SOURCE_DIR))
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        shutil.move(str(tmp), str(ACESTEP_SOURCE_DIR))
    if not (ACESTEP_SOURCE_DIR / "pyproject.toml").is_file():
        raise SystemExit(f"[desktop:runtime] 解压后的 ACE-Step 源码缺少 pyproject.toml: {ACESTEP_SOURCE_DIR}")


def patch_acestep_checkpoint_resolution(repo: Path) -> None:
    patches = [
        (
            repo / "acestep" / "api" / "http" / "model_init_service.py",
            '    project_root = get_project_root()\n    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "http" / "model_init_service.py",
            '    llm = app_state.llm_handler\n    from acestep.model_downloader import get_checkpoints_dir\n',
            '    llm = app_state.llm_handler\n    project_root = get_project_root()\n    from acestep.model_downloader import get_checkpoints_dir\n',
        ),
        (
            repo / "acestep" / "api" / "startup_model_init.py",
            '    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "runtime_helpers.py",
            '        project_root = get_project_root()\n        checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '        from acestep.model_downloader import get_checkpoints_dir\n\n        checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "http" / "reinitialize_route.py",
            '                    project_root = get_project_root()\n                    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '                    from acestep.model_downloader import get_checkpoints_dir\n\n                    checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "http" / "model_service_routes.py",
            '    project_root = get_project_root()\n    checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '    from acestep.model_downloader import get_checkpoints_dir\n\n    checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "llm_readiness.py",
            '        project_root = get_project_root()\n        checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '        from acestep.model_downloader import get_checkpoints_dir\n\n        checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
        (
            repo / "acestep" / "api" / "http" / "sample_format_routes.py",
            '                project_root = get_project_root()\n                checkpoint_dir = os.path.join(project_root, "checkpoints")\n',
            '                from acestep.model_downloader import get_checkpoints_dir\n\n                checkpoint_dir = str(get_checkpoints_dir())\n',
        ),
    ]
    changed = []
    for path, old, new in patches:
        if not path.is_file():
            continue
        src = path.read_text("utf-8")
        if old in src:
            path.write_text(src.replace(old, new), "utf-8")
            changed.append(str(path.relative_to(repo)))
    if changed:
        log("已修补 ACE-Step checkpoints 目录解析，使用 ACESTEP_CHECKPOINTS_DIR:")
        for item in changed:
            log(f"  - {item}")


def build_acestep_runtime(uv: str, force: bool) -> None:
    if not build_acestep_runtime_enabled():
        log("跳过 ACE-Step runtime（BUILD_ACESTEP_RUNTIME=0）。")
        ACESTEP_ARCHIVE.unlink(missing_ok=True)
        ACESTEP_MARKER.unlink(missing_ok=True)
        return
    expected_marker = {
        "platform": f"{platform.system()}-{platform.machine()}",
        "python": "3.12",
        "source": ACESTEP_SOURCE_ZIP.name,
        "source_sha256": file_sha256(ACESTEP_SOURCE_ZIP) if ACESTEP_SOURCE_ZIP.is_file() else "",
        "patch": ACESTEP_PATCH_VERSION,
    }
    if not force and archive_or_parts_exist(ACESTEP_ARCHIVE) and marker_matches(ACESTEP_MARKER, expected_marker):
        log("已存在 ACE-Step runtime archive，跳过。")
        return

    log("构建 ACE-Step 独立 runtime (Python 3.12)...")
    ACESTEP_ARCHIVE.unlink(missing_ok=True)
    for old_part in ACESTEP_ARCHIVE.parent.glob(f"{ACESTEP_ARCHIVE.name}.part*"):
        old_part.unlink()
    shutil.rmtree(ACESTEP_BUILDROOT, ignore_errors=True)
    ACESTEP_BUILDROOT.mkdir(parents=True, exist_ok=True)
    extract_acestep_source()
    patch_acestep_checkpoint_resolution(ACESTEP_SOURCE_DIR)

    copy_uv_python(uv, "3.12", ACESTEP_PYTHON_DST)
    ace_python = runtime_python(ACESTEP_PYTHON_DST, "3.12")
    run([uv, "venv", "--python", str(ace_python), "--relocatable", "--link-mode", "copy", str(ACESTEP_VENV)])
    py = venv_python(ACESTEP_VENV)
    run([uv, "pip", "install", "--python", str(py), str(ACESTEP_SOURCE_DIR)], cwd=ACESTEP_SOURCE_DIR)
    run([uv, "pip", "install", "--python", str(py), "modelscope"], cwd=ACESTEP_SOURCE_DIR)
    run(
        [
            str(py),
            "-c",
            "import torch, acestep, modelscope, sys; print('[desktop:runtime] verified acestep python=' + sys.version.split()[0])",
        ],
        cwd=ACESTEP_SOURCE_DIR,
    )

    shutil.rmtree(ACESTEP_SOURCE_DIR / ".git", ignore_errors=True)
    if not IS_WINDOWS:
        patch_unix_venv_python_symlinks(ACESTEP_VENV, "../../../python/cpython/bin/python3.12", "3.12")
        patch_venv_home(ACESTEP_VENV, "../../../python/cpython/bin")
    normalize_permissions(ACESTEP_BUILDROOT)
    log("打包 ACE-Step runtime archive...")
    with tarfile.open(ACESTEP_ARCHIVE, "w:gz", dereference=False) as tar:
        tar.add(ACESTEP_SOURCE_DIR, arcname="ACE-Step-1.5")
        tar.add(ACESTEP_BUILDROOT / "python", arcname="python")
    ACESTEP_MARKER.write_text(
        "\n".join(
            [
                f"platform={platform.system()}-{platform.machine()}",
                "python=3.12",
                f"source={ACESTEP_SOURCE_ZIP.name}",
                f"source_sha256={file_sha256(ACESTEP_SOURCE_ZIP)}",
                f"patch={ACESTEP_PATCH_VERSION}",
                f"archive={ACESTEP_ARCHIVE.name}",
                f"sha256={file_sha256(ACESTEP_ARCHIVE)}",
                f"split={'windows-parts' if IS_WINDOWS else 'none'}",
            ]
        )
        + "\n",
        "utf-8",
    )
    size_mib = ACESTEP_ARCHIVE.stat().st_size / (1024 * 1024)
    split_count = split_archive_for_windows(ACESTEP_ARCHIVE)
    if split_count:
        log(f"完成：{ACESTEP_ARCHIVE.name} chunks={split_count} original_size={size_mib:.1f} MiB")
    else:
        log(f"完成：{ACESTEP_ARCHIVE} ({size_mib:.1f} MiB)")


def build_backend_runtime(uv: str) -> None:
    log("构建 backend runtime (Python 3.12)...")
    ARCHIVE.unlink(missing_ok=True)
    MARKER.unlink(missing_ok=True)
    shutil.rmtree(BUILDROOT, ignore_errors=True)
    shutil.rmtree(RUNTIME / "backend-runtime" / ".venv", ignore_errors=True)
    shutil.rmtree(RUNTIME / "python" / "cpython", ignore_errors=True)
    (BUILDROOT / "python").mkdir(parents=True, exist_ok=True)
    (BUILDROOT / "backend-runtime").mkdir(parents=True, exist_ok=True)
    RUNTIME.mkdir(parents=True, exist_ok=True)

    log("准备 CPython 3.12...")
    copy_uv_python(uv, "3.12", PYTHON_DST)

    log("创建可重定位后端 venv...")
    run([uv, "venv", "--python", str(copied_python()), "--relocatable", "--link-mode", "copy", str(VENV)])
    py = venv_python(VENV)
    if not py.is_file():
        raise SystemExit(f"[desktop:runtime] venv Python 不存在: {py}")

    log("安装 torch/torchaudio CPU 轮子...")
    run(
        [
            uv,
            "pip",
            "install",
            "--python",
            str(py),
            "--index-url",
            "https://download.pytorch.org/whl/cpu",
            "torch==2.5.1",
            "torchaudio==2.5.1",
        ]
    )

    log("安装后端依赖...")
    install_backend_requirements(uv, py)

    log("下载并内置静态 ffmpeg/ffprobe...")
    bundle_ffmpeg()

    log("验证关键模块...")
    verify_imports = "fastapi, uvicorn, celery, redis, demucs, torch, torchaudio, static_ffmpeg"
    if not IS_WINDOWS:
        verify_imports += ", redislite"
    python_version = output([str(py), "-c", "import sys; print(sys.version.split()[0])"])
    run(
        [
            str(py),
            "-c",
            f"import {verify_imports}, sys; print('[desktop:runtime] verified python=' + sys.version.split()[0])",
        ]
    )

    log("修正 runtime 可迁移路径...")
    patch_unix_python_symlinks()
    patch_pyvenv_cfg()

    log("规范化文件权限...")
    normalize_permissions(BUILDROOT)
    archive_runtime()

    MARKER.write_text(
        "\n".join(
            [
                f"platform={platform.system()}-{platform.machine()}",
                f"python={python_version}",
                f"requirements_sha256={backend_requirements_hash()}",
                f"archive={ARCHIVE.name}",
                f"sha256={file_sha256(ARCHIVE)}",
            ]
        )
        + "\n",
        "utf-8",
    )
    log(f"完成：{ARCHIVE} ({ARCHIVE.stat().st_size / (1024 * 1024):.1f} MiB)")


def main() -> int:
    configure_stdio()
    force_all = env_flag("FORCE_DESKTOP_RUNTIME")
    force_backend = force_all or env_flag("FORCE_BACKEND_RUNTIME")
    force_svc = force_all or env_flag("FORCE_SVC_RUNTIME")
    force_acestep = force_all or env_flag("FORCE_ACESTEP_RUNTIME")
    build_svc_enabled = os.environ.get("BUILD_SVC_RUNTIME", "1") != "0"
    build_ace_enabled = build_acestep_runtime_enabled()

    if not build_ace_enabled:
        ACESTEP_ARCHIVE.unlink(missing_ok=True)
        ACESTEP_MARKER.unlink(missing_ok=True)

    backend_marker_expected = {
        "platform": f"{platform.system()}-{platform.machine()}",
        "python": "3.12",
        "requirements_sha256": backend_requirements_hash(),
        "archive": ARCHIVE.name,
    }
    svc_marker_expected = {"platform": f"{platform.system()}-{platform.machine()}", "python": "3.11"}
    ace_marker_expected = {
        "platform": f"{platform.system()}-{platform.machine()}",
        "python": "3.12",
        "source": ACESTEP_SOURCE_ZIP.name,
        "source_sha256": file_sha256(ACESTEP_SOURCE_ZIP) if ACESTEP_SOURCE_ZIP.is_file() else "",
        "patch": ACESTEP_PATCH_VERSION,
    }

    backend_current = ARCHIVE.is_file() and marker_matches(MARKER, backend_marker_expected)
    svc_current = (not build_svc_enabled) or (SVC_ARCHIVE.is_file() and marker_matches(SVC_MARKER, svc_marker_expected))
    ace_current = (not build_ace_enabled) or (archive_or_parts_exist(ACESTEP_ARCHIVE) and marker_matches(ACESTEP_MARKER, ace_marker_expected))

    if not force_backend and backend_current:
        log(f"已存在 backend runtime archive，跳过：{ARCHIVE} ({ARCHIVE.stat().st_size / (1024 * 1024):.1f} MiB)")
    if build_svc_enabled and not force_svc and svc_current:
        log(f"已存在 SVC runtime archive，跳过：{SVC_ARCHIVE} ({SVC_ARCHIVE.stat().st_size / (1024 * 1024):.1f} MiB)")
    if build_ace_enabled and not force_acestep and ace_current:
        if ACESTEP_ARCHIVE.is_file():
            log(f"已存在 ACE-Step runtime archive，跳过：{ACESTEP_ARCHIVE} ({ACESTEP_ARCHIVE.stat().st_size / (1024 * 1024):.1f} MiB)")
        else:
            parts = sorted(ACESTEP_ARCHIVE.parent.glob(f"{ACESTEP_ARCHIVE.name}.part*"))
            log(f"已存在 ACE-Step runtime archive chunks，跳过：{len(parts)} 个分片")

    if (
        (not force_backend and backend_current)
        and (not force_svc and svc_current)
        and (not force_acestep and ace_current)
    ):
        log("desktop runtime archives 均已是最新，无需重建。")
        return 0

    uv = find_command("uv")

    RUNTIME.mkdir(parents=True, exist_ok=True)
    if force_backend or not backend_current:
        build_backend_runtime(uv)
    if build_svc_enabled:
        build_svc_runtime(uv, force_svc)
    else:
        build_svc_runtime(uv, force_svc)
    if build_ace_enabled:
        build_acestep_runtime(uv, force_acestep)
    else:
        build_acestep_runtime(uv, force_acestep)

    shutil.rmtree(WORK, ignore_errors=True)
    log("desktop runtime 准备完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
