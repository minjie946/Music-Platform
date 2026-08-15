"""按需下载 SVC 大文件权重（content-vec / HuBERT + 训练底模 D_0/G_0）。

设计目标：权重不再打包进项目，首次启动时若检测缺失则自动从 HuggingFace（默认走
hf-mirror 国内镜像）下载到用户可配置目录（见 config.pretrained_dir）。已就位则跳过。

下载在后台线程执行，不阻塞服务启动；进度打印到 svc.log。
"""
from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path

from . import config

# content-vec / HuBERT 特征模型仓库（推理 + 训练都要）。
CONTENT_VEC_REPO = "lengyue233/content-vec-best"

# 训练底模（768 维，匹配默认 so-vits-svc-4.0v1 模板）。
BASE_MODEL_REPO = "ms903/sovits4.0-768vec-layer12"
BASE_MODEL_SUBDIR = "sovits_768l12_pre_large_320k"
BASE_MODEL_FILES = {
    "D_0.pth": f"{BASE_MODEL_SUBDIR}/clean_D_320000.pth",
    "G_0.pth": f"{BASE_MODEL_SUBDIR}/clean_G_320000.pth",
}

# 国内默认镜像；可用 HF_ENDPOINT 覆盖（设为空字符串则用官方源）。
DEFAULT_HF_ENDPOINT = "https://hf-mirror.com"

_lock = threading.Lock()
_state = {"status": "idle", "detail": ""}


def status() -> dict:
    """当前权重就绪 / 下载状态，供 /capabilities 等接口查询。"""
    with _lock:
        return dict(_state)


def _set(status_: str, detail: str = "") -> None:
    with _lock:
        _state["status"] = status_
        _state["detail"] = detail
    print(f"[svc-pretrained] {status_}: {detail}", flush=True)


def content_vec_ready() -> bool:
    return (config.hf_home_dir() / "hub").is_dir()


def base_models_ready() -> bool:
    return len(config.base_model_files()) == 2


def all_ready() -> bool:
    return content_vec_ready() and base_models_ready()


def _resolved_endpoint() -> str | None:
    """返回要使用的 HF endpoint；None 表示用库默认（官方源）。"""
    if "HF_ENDPOINT" in os.environ:
        return os.environ["HF_ENDPOINT"] or None
    return DEFAULT_HF_ENDPOINT


def _download_content_vec(hf_home: Path, endpoint: str | None) -> None:
    from huggingface_hub import snapshot_download

    hf_home.mkdir(parents=True, exist_ok=True)
    # snapshot 落到 hf_home/hub 缓存格式，之后 from_pretrained 可离线命中。
    snapshot_download(
        repo_id=CONTENT_VEC_REPO,
        cache_dir=str(hf_home / "hub"),
        endpoint=endpoint,
    )


def _download_base_models(base_dir: Path, endpoint: str | None) -> None:
    from huggingface_hub import hf_hub_download

    base_dir.mkdir(parents=True, exist_ok=True)
    for local_name, repo_path in BASE_MODEL_FILES.items():
        dest = base_dir / local_name
        if dest.is_file():
            continue
        cached = hf_hub_download(
            repo_id=BASE_MODEL_REPO,
            filename=repo_path,
            repo_type="dataset",
            endpoint=endpoint,
        )
        shutil.copy2(cached, dest)
        print(f"[svc-pretrained] 底模就位：{local_name} <- {repo_path}", flush=True)


def ensure_downloaded() -> None:
    """幂等地确保权重就位；缺失才下载。异常不抛出，只置为 error 状态。"""
    if all_ready():
        _set("ready", "权重已就位")
        return
    endpoint = _resolved_endpoint()
    try:
        if not content_vec_ready():
            _set("downloading", f"下载 content-vec（{CONTENT_VEC_REPO}）...")
            _download_content_vec(config.hf_home_dir(), endpoint)
        if not base_models_ready():
            _set("downloading", f"下载训练底模（{BASE_MODEL_REPO}）...")
            _download_base_models(config.base_models_dir(), endpoint)
        _set("ready", "权重下载完成")
    except Exception as exc:  # 下载失败不应拖垮服务；训练/推理时再报明确错误。
        _set(
            "error",
            f"权重下载失败：{exc}。可稍后重试，或手动放置到 {config.pretrained_dir()}。",
        )


def ensure_async() -> None:
    """后台触发一次 ensure_downloaded，不阻塞服务启动。"""
    with _lock:
        if _state["status"] == "downloading":
            return
    threading.Thread(target=ensure_downloaded, name="svc-pretrained", daemon=True).start()
