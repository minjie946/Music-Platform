"""Celery application and beat schedule."""
from __future__ import annotations

from celery import Celery

from .config import settings

USE_FILESYSTEM_BROKER = settings.redis_url == "filesystem://"

celery_app = Celery(
    "music_gui",
    broker=settings.redis_url,
    backend=None if USE_FILESYSTEM_BROKER else settings.redis_url,
)

filesystem_transport_options = {}
if USE_FILESYSTEM_BROKER:
    queue_dir = settings.celery_filesystem_dir / "queue"
    processed_dir = settings.celery_filesystem_dir / "processed"
    queue_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)
    filesystem_transport_options = {
        "data_folder_in": str(queue_dir),
        "data_folder_out": str(queue_dir),
        "processed_folder": str(processed_dir),
    }

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,
    worker_max_tasks_per_child=4,
    # Demucs is memory heavy; keep prefetch low so tasks spread across workers.
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    broker_transport_options=filesystem_transport_options,
    task_default_queue="default",
    # 队列拆分：长任务（音乐生成/初始化，GPU/大内存独占）走 generation 队列，
    # 短任务（分轨/编辑/清理）走 default 队列，由独立 worker 消费，互不阻塞。
    # 各队列内部仍是串行 FIFO（单 worker），保持顺序可预期。
    task_routes={
        "app.tasks.run_generation": {"queue": "generation"},
        "app.tasks.run_init": {"queue": "generation"},
        "app.tasks.run_separation": {"queue": "default"},
        "app.tasks.run_edit": {"queue": "default"},
        "app.tasks.cleanup_old_jobs": {"queue": "default"},
    },
    beat_schedule={
        "cleanup-old-jobs": {
            "task": "app.tasks.cleanup_old_jobs",
            "schedule": 3600.0,  # hourly
            "options": {"queue": "default"},
        }
    },
)

# Ensure tasks module is imported so tasks are registered.
from . import tasks  # noqa: E402,F401
