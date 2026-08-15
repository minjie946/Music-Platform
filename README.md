# 音乐工作台 · Music Studio

一个集 **音乐生成**、**音轨分离**、**音乐编辑器** 与 **SVC 人声转换** 于一体的本地音乐工作台。顶部可切换主要功能，并在「⚙ 设置」旁提供「? 手册」入口。

- **音轨分离**：上传音乐文件，拆分为多条独立音轨（主唱、伴唱、鼓、贝斯、原声木吉他、电吉他、钢琴、合成器、弦乐、其余），工作台中展示当前任务、历史分离记录、在线播放、单条下载或一键打包下载全部。
- **音乐生成**（ACE-Step 1.5）：填写风格描述 / 歌词 / 时长等参数，本地生成音乐；工作台中展示当前生成、历史歌曲、播放器、生成参数；生成结果和历史歌曲都可一键「→ 分离」进入分轨流程。
- **音乐编辑器**：进入编辑面板对多轨进行混音——顶栏管理时间码/BPM/拍号/调性/主音量/撤销重做/保存/导出；底部效果 Dock 提供人声效果器（叠声）、Autotune 音高校正、混响；侧边标签支持人声旋律、歌词、和声、素材、收藏，可本地生成调内旋律线（librosa 分析伴奏 key/bpm）。
- **SVC 人声转换**：上传自己的清唱/说话样本训练专属音色；音乐生成可开启「人声模式」，生成后自动分离人声、转换为所选音色并混回伴奏。

完整用户手册见 [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md)，应用内也可点击右上角「? 手册」查看。

**安装/启动时会自动检测电脑配置**（NVIDIA CUDA / Apple MPS / 纯 CPU 与显存/内存），据此决定音乐生成是否可用、推荐哪个 ACE-Step 档位（模型/设备/offload），界面也会相应开关功能。

分轨引擎采用**可插拔架构**，引擎能力是**动态**的（前端按当前引擎/模型实际可分的轨自动渲染、不支持的标灰）：

- **默认 Demucs**（开源、本地、免费）：`htdemucs_6s` 可分 6 轨——主唱（人声）、鼓、贝斯、钢琴、其余等。
  - 可选**级联**（设置里开启）：额外把人声拆成主唱/伴唱，约 7 轨（路线 A）。
  - 可选**自训练 10 轨模型**：训练后引擎自动开放全部 10 轨（路线 B）。
- **LALAL.AI**（云端、付费）：在设置页配置 API Key 后切换，可解锁全部 10 种细分轨。

## 技术栈

- 前端：React + TypeScript + Vite + Tailwind CSS + wavesurfer.js + Tone.js（编辑器实时混音，懒加载 + 分包）
- 后端：FastAPI + Celery（`generation` / `default` 双队列）+ Redis
- 分轨：Demucs (`htdemucs_6s`) / 级联 karaoke (`audio-separator`) / LALAL.AI REST API
- 生成：[ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) 作为独立 REST 服务（sidecar，:8001），后端代理编排
- 编辑：本地开源引擎——Autotune / 叠声（librosa/scipy）、调内旋律生成（librosa 分析 + 随机游走 → MIDI）、SoundFont 合成
- SVC：独立 FastAPI sidecar（:8002）+ `so-vits-svc-fork`，后端代理训练、音源管理和转换
- 硬件检测：`backend/app/hardware.py`（探测 CUDA/MPS/CPU + 显存/内存，推算 ACE-Step 档位，结果缓存）
- 转码：ffmpeg
- 本地零系统依赖：Redis 由 `redislite`、ffmpeg 由 `static-ffmpeg` 随项目提供

## 架构

```
浏览器 ──REST/SSE──> FastAPI (api) ──入队──> Redis ──> Celery worker ──> 分轨引擎
                                                                  ├─ DemucsEngine (本地)
                                                                  └─ LalalEngine (云端)
                                              输出 mp3 ──> data/outputs/{job_id}/
                                              历史分离 ──> 工作台左侧列表 + 右侧详情

         音乐生成：FastAPI (api) ──入队──> Redis ──> Celery worker ──HTTP──> ACE-Step REST (:8001)
                                                              下载生成音频 ──> data/generation/{job_id}/
                                                              完成归档 ──> data/generation_history/{job_id}/

         音乐编辑：FastAPI (api) ──入队──> Redis ──> Celery worker ──> 多轨混音/Autotune/叠声/混响
                                                              导出成品 ──> data/edits/outputs/{job_id}/

         SVC 音源：FastAPI (api) ──HTTP──> SVC REST (:8002) ──> so-vits-svc
                                                        ├─ 训练音源 ──> data/svc_models/
                                                        └─ 人声转换 ──> 生成「人声模式」混音
```

- `api`：接收上传、建任务入队、查询进度、回传/打包文件。
- `worker`：执行重计算（Demucs 推理 / LALAL 调用 / 生成结果人声转换编排 / 编辑混音），分阶段上报进度。Celery 采用 `generation`（长耗时）与 `default`（短任务）双队列，避免分轨/编辑被生成任务阻塞。
- `redis`：Celery broker/result + 进度发布（SSE 基于 Redis pubsub 实时推送）。
- `svc_service`：独立 SVC sidecar，提供音源训练、音源列表、试听转换和生成链路中的人声转换。
- 进度阶段：加载模型 → 分离音轨 → 导出转码 → 完成。
- 前端工作台：音轨分离和音乐生成均采用左右结构，左侧为当前/历史列表，右侧为选中任务详情、播放器和参数。

## Docker 启动（分轨基础服务）

需要安装 Docker。

```bash
docker compose up --build
```

- 前端：http://localhost:8080
- 后端 API：http://localhost:8000/api/health

> 首次运行 Demucs 会自动下载模型权重（约数百 MB），缓存在 `model-cache` 卷中。

> 当前 `docker-compose.yml` 主要覆盖分轨基础服务（redis/api/worker/frontend）。如需同时使用 ACE-Step 音乐生成和 SVC 人声模式，推荐使用下面的 `./start.sh` 本地一键脚本。

## 本地开发

前置依赖：**Python 3.12（项目锁定版本，见 `.python-version`）**、Node 22。Python 依赖用 **[uv](https://docs.astral.sh/uv/)** 管理（`start.sh` 缺失时会自动安装 uv，并用 uv 拉取 3.12 解释器，无需系统预装 Python）。锁定 3.12 是因为 `torch==2.5.1` 等依赖只对特定 Python 版本提供预编译 wheel——例如 Python 3.14 会报 `No matching distribution for torch==2.5.1`，3.9 会报 `TypeError: ... 'float | None'`。**ffmpeg 与 Redis 由项目内的 `static-ffmpeg` / `redislite` 提供，无需系统安装。**

> `start.sh` 用 `uv venv --python 3.12` 创建 venv；若现有 `backend/.venv` 不是 3.12，请先 `rm -rf backend/.venv` 再重建。

> 重要：分轨需要 **Redis + API + Celery worker** 三者同时运行。**不要只单独运行 `uvicorn`**——那样上传会返回 503（缺 Redis/worker）。请用下面的方式启动。

### 方式一：一键脚本（推荐）

```bash
./start.sh
```

> 若提示 `Permission denied`，先加可执行权限 `chmod +x start.sh`，或直接用 `bash start.sh` 运行。

首次会自动创建后端 venv、安装依赖、`npm install`，随后同时拉起：

- SVC 歌声转换服务（:8002，后台启动；首次 `uv sync` 会安装 so-vits-svc / torch 等依赖，较慢）
- Redis（redislite，:6390）+ FastAPI（:8000）+ Celery worker
- 前端 Vite dev server（:5173）

ACE-Step 音乐生成服务（:8001）改为**按需启动**：打开「音乐生成」标签后，首次会先展示模型/目录设置页；保存后再启动 ACE-Step、下载/加载模型。已下载过模型时会直接启动并加载，不会重复下载。

Ctrl+C 一并退出。浏览器打开 http://localhost:5173。

`start.sh` 每次运行都会创建独立日志目录：`logs/runs/YYYYMMDD_HHMMSS/`。ACE-Step 与 SVC 日志分别写入该目录下的 `acestep.log`、`svc.log`，旧版本根目录日志会归档到 `logs/archive/`，默认清理 7 天前日志（可用 `LOG_RETENTION_DAYS` 调整）。前端「设置 → 运行日志」可实时查看并复制日志命令。

> 只想用「音轨分离」、不启动 SVC：`SKIP_SVC=1 ./start.sh`。

> 不需要「人声模式」、只跳过 SVC：`SKIP_SVC=1 ./start.sh`。

### 方式二：分步启动

后端（`run_local.py` 一条命令同时起 redis + api + worker，并自动把 `APP_REDIS_URL` 指向本地 6390）。依赖用 uv 安装（未装 uv 见 [安装指引](https://docs.astral.sh/uv/getting-started/installation/)）：

```bash
cd backend
uv venv --python 3.12 .venv && source .venv/bin/activate
# torch 用 CPU 轮子；其余依赖含 redislite/static-ffmpeg
uv pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 torchaudio==2.5.1
uv pip install -r requirements-dev.txt
python run_local.py
```

前端：

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173，已代理 /api -> :8000
```

> 如果你确实想分进程手动起（高级）：先自备一个 Redis，再设 `APP_REDIS_URL` 指向它，然后分别运行 `uvicorn app.main:app` 与 `celery -A app.celery_app.celery_app worker --beat --pool=solo`。否则请用上面两种方式。

## 配置 LALAL.AI（解锁 10 轨）

1. 打开界面右上角「⚙ 设置」。
2. 粘贴你的 LALAL.AI API Key 并保存。
3. 在左侧引擎选择切换为 `LALAL.AI`，即可选择全部 10 种分轨类型。

API Key 持久化在 `backend/data/settings.json`，界面回显时自动掩码。

## 音轨分离工作台与历史记录

「音轨分离」右侧是工作台：

- 左侧列表展示**当前分离任务**和历史分离记录，当前任务置顶，历史按时间倒序排列。
- 右侧展示选中记录的详情：进度、播放器、一键播放、单轨下载、一键下载全部。
- 从「音乐生成」里点击「→ 分离」跳转过来的任务，也会作为当前任务出现在左侧列表并自动选中。
- 分离完成后会在输出目录写入 `job.json`，即使 Redis 中任务过期，历史记录仍可播放/下载。

### 自定义分离结果目录

打开「设置 → 音轨分离 → 分离结果存放目录」可以设置分离结果保存路径：

- 留空默认：`backend/data/outputs/`。
- 新任务会写入当前设置的目录。
- 历史分离列表、单轨播放/下载、一键下载全部都会从该目录读取。
- 切换目录不会自动迁移旧目录中的历史记录，如需保留旧历史，请手动迁移目录内容。

## 音乐生成（ACE-Step 1.5）

音乐生成由 [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) 提供，作为**独立 REST 服务**运行（默认 `http://127.0.0.1:8001`），本项目后端把生成请求代理给它，复用同一套 job + SSE 进度。

### 启动生成服务

生成服务现在是**按需启动**：`./start.sh` 先启动后端和前端；进入「音乐生成」标签后，前端通过后端启动 ACE-Step sidecar。

首次点击「音乐生成」时会：

1. 若是首次使用且模型尚未下载，先展示模型、模型目录、成品保存目录等设置。
2. 保存设置后启动 ACE-Step sidecar，启动脚本会读取 `backend/data/settings.json` 中的模型目录。
3. 首次将 ACE-Step-1.5 克隆到 `external/ACE-Step-1.5`（可用环境变量 `ACESTEP_DIR` 覆盖）。
4. `uv sync` 安装其依赖（**首次很慢，且会下载数 GB 依赖/模型**）。
5. **检测本机硬件**（CUDA / Apple MPS / CPU + 显存/内存），按档位自动选择 DiT 模型 / LM 模型 / 后端 / offload，写入 `ACESTEP_*` 环境变量。
6. 后台运行 `uv run acestep-api` 启动 :8001 服务，并调用 `/v1/init` 下载/加载模型。

> 只想完全禁用音乐生成按需启动：`SKIP_ACESTEP=1 ./start.sh`。

> 硬件档位（近似 ACE-Step 官方表）：≤6GB 显存仅 turbo+offload+int8；6–16GB turbo + 0.6B/1.7B LM；20GB+ 可上 XL。**Apple Silicon** 走 MPS + pt 后端（vllm 仅限 CUDA）。**纯 CPU** 能跑但极慢，默认关闭生成，需设 `APP_ALLOW_CPU_GENERATION=1` 强制开启。

### 首次使用：初始化（下载大模型）

ACE-Step 服务和模型都默认**懒加载**。首次进入「音乐生成」标签，如果服务/模型尚未启动或加载，界面会显示一个**初始化页面**：

- 服务未启动且首次使用 → 先配置模型/目录，保存后自动启动 ACE-Step 并开始下载/加载；
- 服务未启动但已配置/已下载 → 自动启动 ACE-Step，模型已存在时只加载不重复下载；
- 服务已启动但模型未就绪 → 点击「开始下载并初始化」，后端调用 ACE-Step `/v1/init` 下载（首次数 GB）并加载模型，期间显示进度（已就绪体积 + 阶段）；
- 完成后页面自动切换为生成表单，**只有就绪后才能生成**。

判定逻辑：后端用 ACE-Step `/health` 的 `models_initialized` 判断「已加载」，并扫描模型目录判断「已下载」，前端据此渲染初始化页或生成页。

填好左侧描述/歌词/时长等参数（界面会按检测到的硬件钳制时长与生成数量上限）后，右侧工作台展示当前任务和历史歌曲。

### 音乐生成工作台与历史歌曲

「音乐生成」右侧也是左右结构工作台：

- 左侧展示当前生成任务和历史歌曲列表，当前任务置顶，历史按时间倒序排列。
- 右侧展示选中歌曲详情：播放器、下载、发送分离、生成参数。
- 生成中会展示进度条和播放器形态的骨架屏。
- 生成参数默认展开，提示词和歌词支持一键复制，历史歌曲支持下载参数。
- 历史歌曲和当前歌曲都支持「→ 分离」，会创建新的音轨分离任务并跳转到「音轨分离」工作台。

### 提示词/歌词辅助

生成表单内置两个便捷入口（需 ACE-Step 服务已启动）：

- **一键润色**：把当前描述/歌词交给 LM 优化扩写（后端 `/api/generation/format-input` 代理 ACE-Step `/format_input`）。
- **随机示例**：一键填入一组随机的风格/歌词/参数（`/api/generation/random-sample` 代理 `/create_random_sample`），方便快速试玩。

### LoRA 风格适配器

生成面板可选挂载 LoRA 适配器，在基础 DiT 模型上叠加特定风格（当前内置「纯音乐 / 器乐」「流行 / 电子」两类预设）：

- 前端 `LoraSelect` 列出目录内 LoRA，展示本地下载状态与和当前 DiT 底模的兼容性（不兼容会标记）。
- 未下载的 LoRA 可按需下载（`POST /api/generation/loras/download`），进度可查询。
- 生成参数带 `lora_id` 时，后端会校验其已下载并挂载。
- LoRA 存放目录 `lora_dir` 可配置，留空 = `<workspace>/ace/models/loras`（回退到 `<checkpoints>/loras`）。

### 自定义路径（界面「⚙ 设置」可改）

设置面板的「音乐生成路径」可配置：

- **模型存放目录**：留空 = ACE-Step 默认 `external/ACE-Step-1.5/checkpoints`。改后会写入 `backend/data/settings.json`；ACE-Step 按需启动时会读取并导出 `ACESTEP_CHECKPOINTS_DIR`。若 ACE-Step 已经在运行，改完需停止/重新启动生成服务才会影响 sidecar；多个安装可指向同一目录避免重复下载。
- **历史歌曲存放目录**：留空 = `backend/data/generation_history`。生成完成后歌曲会归档到这里，历史记录、播放和下载都从这里读取。
- **生成缓存目录（暂存）**：留空 = `backend/data/generation`。生成时先暂存到这里，完成后移动到历史目录。
- **临时缓存目录**：留空 = `external/ACE-Step-1.5/.cache/acestep/tmp`。ACE-Step 生成过程中的临时音频缓存，改后需重启 sidecar 才生效。

### 相关配置（环境变量，前缀 `APP_`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_ACESTEP_API_URL` | `http://127.0.0.1:8001` | ACE-Step 服务地址（可指向远程 GPU 主机） |
| `APP_ACESTEP_API_KEY` | 空 | ACE-Step 鉴权 Key（服务端开启时需要） |
| `APP_ACESTEP_DIR` | `../external/ACE-Step-1.5` | ACE-Step 仓库位置（用于推断默认模型目录） |
| `APP_ALLOW_CPU_GENERATION` | `false` | 纯 CPU 机器强制开启生成（很慢） |

> 模型目录也可直接用 ACE-Step 原生环境变量 `ACESTEP_CHECKPOINTS_DIR` 指定；启动脚本会优先采用已显式设置的该变量。

> 远程/云端 GPU：把 ACE-Step 部署在有 GPU 的机器并暴露 :8001，本机只需设置 `APP_ACESTEP_API_URL` 指向它即可，无需本地 GPU。

### 桌面应用（Tauri + 内置后端 runtime）

项目已接入 **Tauri** 桌面壳，当前 MVP 会加载前端静态资源，并由桌面壳自动启动本机后端：

- 后端桌面启动器：`backend/desktop_launcher.py`
- 桌面壳目录：`frontend/src-tauri/`
- 桌面数据目录由 Tauri 的 `app_data_dir` 决定，例如 macOS `~/Library/Application Support/com.musicstudio.desktop`
- API/Redis 使用动态本地端口，避免和用户已有服务冲突
- 生产包内置 `desktop-runtime/backend-runtime.tar.gz`，包含 CPython 3.12、后端依赖、Torch/Torchaudio、Demucs、RedisLite 和 static-ffmpeg；首次启动会解压到桌面数据目录后运行，不要求用户安装 Python/uv/ffmpeg/Redis
- SVC/ACE-Step 仍是可选 sidecar，模型资源由用户按需下载或配置目录；安装包不内置大模型

前置依赖：Node 22、Rust/Cargo（见下方安装指引）。首次可用脚本准备前端依赖和后端 Python 3.12 环境：

```bash
cd frontend
npm run desktop:bootstrap
```

启动开发版桌面应用（推荐用一键脚本，自动确保后端 venv、前端依赖、端口检测，再拉起 Tauri dev）：

```bash
./start-desktop.sh
```

> 只想用「音轨分离」、不启动 SVC：`SKIP_SVC=1 ./start-desktop.sh`。脚本每次运行会创建独立日志目录 `logs/runs/YYYYMMDD_HHMMSS/`（`launcher/api/worker/acestep/svc` 各一份日志）。

也可直接用底层 npm 命令：

```bash
cd frontend
npm run desktop:dev
```

构建当前平台安装包：

```bash
cd frontend
npm run desktop:build
```

构建 macOS 可分发 zip：

```bash
cd frontend
npm run desktop:build:zip
```

构建全部 Tauri 默认 bundle：

```bash
cd frontend
npm run desktop:build:all
```

macOS DMG 需要 `hdiutil` 访问 `/dev/rdisk*`；在受限沙箱里可能失败，可在本机终端运行：

```bash
cd frontend
npm run desktop:build:dmg
```

构建产物：

- `.app`：`frontend/src-tauri/target/release/bundle/macos/Music Studio.app`
- `.zip`：`frontend/src-tauri/target/release/bundle/Music_Studio_1.0.0_aarch64.app.zip`
- `.dmg`：`frontend/src-tauri/target/release/bundle/dmg/Music Studio_1.0.0_aarch64.dmg`（需单独构建）
- Windows：由 Windows CI 生成，位于 `frontend/src-tauri/target/release/bundle/` 下，例如 NSIS `.exe`

多平台 CI：

- 工作流：`.github/workflows/desktop-packages.yml`
- 覆盖：macOS arm64、macOS x64、Windows x64
- 每个平台都会在本机 runner 上生成对应架构的 `backend-runtime.tar.gz`，避免跨平台复制 Python 运行时
- ACE-Step runtime 统一由 `resources/ACE-Step-1.5-main.zip` 构建为 `acestep-runtime.tar.gz`，不再使用旧的 `acestep-windows-runtime.tar.gz` 包名。

如果 `desktop:dev` 或 `desktop:build` 提示缺少 `cargo/rustc`，请先安装 Rust（国内网络建议使用镜像加速）：

```bash
# 中国大陆用户（中科大镜像，速度更快）
export RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static
export RUSTUP_UPDATE_ROOT=https://mirrors.ustc.edu.cn/rust-static/rustup
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

```bash
# 国际用户（官方源）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

安装后关闭并重新打开终端（或执行 `source ~/.zshrc` / `source ~/.bashrc`），确认 `cargo --version` 正常即可。cargo 镜像源会在下次执行 `desktop:preflight` 时自动配置（USTC 镜像，仅首次）。

`desktop:preflight` 会在启动前检查 Node、Tauri、Rust、uv 和桌面构建脚本。

项目已在 `frontend/.npmrc` 中预置了 npmmirror 镜像和较长超时设置，`npm install` 会自动使用。如需手动切换或恢复官方源：

```bash
cd frontend
npm config set registry https://registry.npmmirror.com
npm config set replace-registry-host always
npm config set fetch-retries 5
npm config set fetch-retry-mintimeout 20000
npm config set fetch-retry-maxtimeout 120000
npm config set fetch-timeout 600000
npm ci
```

如果需要恢复官方源：

```bash
npm config set registry https://registry.npmjs.org
npm config delete replace-registry-host
```

> 当前阶段已跑通 macOS「桌面壳 + 内置后端 Python runtime + 前端动态 API 地址」。CI 覆盖 macOS arm64、macOS x64、Windows x64；Windows 使用文件队列 fallback，不依赖 RedisLite。

## 音乐编辑器

进入编辑面板后，音乐生成/分轨的多条音轨会加载进 Tone.js 实时混音链，支持逐轨音量/声像/静音、主音量总线与效果处理。编辑混音走独立的 `/api/edit` job（与生成同构的 create → status → SSE → 下载流程），重计算在 Celery worker 里执行。

- **顶栏**（`EditorTopBar`）：时间码、BPM、拍号、调性、主音量、撤销/重做、保存、导出。
- **底部效果 Dock**（`EffectsDock`）：人声效果器（一键叠声）、Autotune 音高校正、混响（距离 + 强度）。
- **侧边标签**（`SidePanel`）：人声旋律、歌词、智能演唱、和声、素材、收藏。
- **旋律生成**：`POST /api/edit/melody` 可选分析某条伴奏轨的 key/bpm，基于调内随机游走生成 MIDI 音符（本地 librosa，无需联网）。
- **SoundFont**：MIDI 合成使用的 SoundFont 路径可配置，解析优先级为 `APP_SOUNDFONT` > 设置 `soundfont_path` > `<workspace>/soundfont/*.sf2|*.sf3` > `backend/assets`。
- 编辑导出成品写入 `edit_output_dir`（默认 `<workspace>/edits/outputs`），完成后写 `job.json`，历史记录可回放/下载。

## 目录外移与自定义存储

大型模型权重、vendor 运行时依赖、ACE-Step 源码包等非源码文件默认存放在 workspace（如 `ai_output/`）而非项目内，保持仓库精简。目录解析优先级统一为：**显式环境变量 > `settings.json` 配置 > `<workspace>/子目录` > 项目内路径（向后兼容）**。

- **统一工作目录**：设置页可设 `workspace_dir`，一处指定后模型、生成缓存、历史、分轨结果、临时缓存、SVC 音源等子目录都会落到 `<workspace>/…`（各子目录仍可单独覆盖）。
- **数据迁移**：更新设置时勾选「迁移已有数据」（`migrate_existing_data`），后端会把旧目录内容合并搬到新目录，并返回迁移摘要。
- `vendor_dir`（`VENDOR_DIR`）：运行时依赖目录（ffmpeg / micromamba），空 = `<workspace>/vendor`。
- `resources_dir`：ACE-Step 源码包目录，空 = `<workspace>/resources`。
- `SVC_PRETRAINED_DIR`：SVC 大文件权重（content-vec / HuBERT / 底模），首次启动按需从 HF 镜像下载，可自定义目录。
- 设置面板提供「浏览」按钮（`/api/settings/browse-directory`）调起系统目录选择器，并展示各目录的实际解析位置；`start.sh` / `launch_acestep.sh` / `desktop_launcher.py` 会读取设置并透传。

## SVC 人声转换

SVC（Singing Voice Conversion）由 `svc_service/` 下的独立 sidecar 提供，默认监听 `http://127.0.0.1:8002`。后端通过 `/api/svc/*` 代理它，前端提供「SVC 音源」标签页管理音色，并在「音乐生成」中提供「人声模式」。

### 使用流程

1. 用 `./start.sh` 启动完整服务，确保终端出现 `SVC 音源 : http://127.0.0.1:8002`。
2. 打开「SVC 音源」标签，上传自己的清唱/说话样本并填写音源名称。
3. 选择 `so-vits-svc` 引擎，设置训练轮数，点击「开始训练」。
4. 训练完成后，音源会出现在「我的音源」列表，可上传一段音频进行「试听」转换。
5. 打开「音乐生成」，开启「人声模式（用你的音色演唱）」，选择已就绪音源并生成歌曲。

「人声模式」会在生成完成后自动执行：分离生成音频的人声与伴奏 → 将人声送入 SVC 转换 → 把转换后人声与伴奏混音 → 覆盖生成结果供播放/下载。

> 音源可**导出为压缩包**备份或在多台机器间迁移（`GET /api/svc/voices/{voice_id}/export`），再通过**导入**（`POST /api/svc/voices/import`）恢复，无需重新训练。

### 样本建议

- 建议准备 **5-30 分钟** 干净、单人、无伴奏的人声素材。
- 可上传多个 `wav/mp3/flac` 等音频文件；推荐切成多个 5-15 秒片段。
- 样本越清晰、发音/音域越覆盖目标歌曲，转换效果通常越稳定。
- CPU/MPS 上训练会比较慢，建议先用较小训练轮数验证链路，再提高 `max_epochs`。

### SVC 启动与路径

`./start.sh` 会自动启动 SVC sidecar，并从设置中读取音源模型目录：

- 默认音源目录：`backend/data/svc_models`。
- 设置面板的「SVC 音源」页可配置「音源存放目录」；改完后需要重启 `./start.sh`，让 sidecar 读取新的 `SVC_MODELS_DIR`。
- 可设置 `SKIP_SVC=1` 跳过 SVC，跳过后「SVC 音源」和生成「人声模式」不可用。

如需单独启动 SVC 服务：

```bash
cd svc_service
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8002
```

### 相关配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_SVC_API_URL` | `http://127.0.0.1:8002` | 后端访问 SVC sidecar 的地址，可指向远程机器 |
| `SVC_MODELS_DIR` | `svc_service/voices` | sidecar 直接读取的音源模型目录；`./start.sh` 默认会设为 `backend/data/svc_models` 或设置页配置值 |
| `SVC_WORK_DIR` | `svc_service/.work` | SVC 训练/转换临时工作目录 |

> SVC 服务本身可在缺少 so-vits 依赖时启动，但 `/capabilities` 会报告不可训练/不可推理原因，界面会禁用训练按钮并展示提示。

## 让 Demucs 支持更多分轨（10 轨）

原生 `htdemucs_6s` 只能分 6 轨。两条增强路线：

### 路线 A：级联拆分主唱/伴唱（开箱即用）

打开右上角「设置」→ 勾选「Demucs 级联拆分主唱/伴唱」。它在 6 轨基础上，对人声再用一个 karaoke 模型（经 `audio-separator`）拆出主唱与伴唱，能力矩阵会自动放开 `伴唱`。

需要安装可选依赖（独立文件，避免与主依赖冲突）：

```bash
cd backend && source .venv/bin/activate
uv pip install -r requirements-cascade.txt   # 首次运行会下载 karaoke 模型
```

### 路线 B：训练自定义 10 轨模型（完整工程已就绪）

`backend/training/` 提供了 MoisesDB→10 轨数据集脚本、dora 训练命令与接入说明，训练出 10 源模型后，引擎按模型实际 `sources` 自动开放全部 10 轨。详见 [backend/training/README.md](backend/training/README.md)。

引擎能力是**动态**的：它根据当前模型的源列表（`APP_DEMUCS_SOURCES` / 已知模型表）+ 级联开关计算可用分轨，前端据此渲染，无需改业务代码。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/jobs` | 上传文件 + `stems`(JSON 数组) + `engine`，创建并入队任务 |
| GET | `/api/jobs/{id}` | 查询任务状态/进度 |
| GET | `/api/jobs/history` | 查询历史分离记录（按输出目录扫描，最新在前） |
| GET | `/api/jobs/{id}/events` | SSE 实时进度推送 |
| GET | `/api/jobs/{id}/download-all` | 打包下载全部分轨 (zip) |
| GET | `/api/stems/{id}/{stem}` | 播放/下载单条分轨（`?download=true`） |
| GET | `/api/engine/capabilities` | 当前引擎支持的分轨类型 |
| GET/PUT | `/api/settings` | 读取/更新默认引擎与 LALAL.AI Key |
| POST | `/api/settings/browse-directory` | 打开系统目录选择器/校验目录，供设置页选路径 |
| GET | `/api/hardware` | 硬件检测结果（设备/显存/内存/推荐档位） |
| GET | `/api/generation/capabilities` | 生成是否可用 + 硬件 + 模型就绪/下载状态 + 路径 |
| POST | `/api/generation/initialize` | 触发模型下载+加载（返回 init 任务，复用 SSE 进度） |
| POST | `/api/generation` | 提交生成任务（JSON 参数），复用 job/SSE |
| POST | `/api/generation/format-input` | 用 LM 润色描述/歌词（代理 ACE-Step `/format_input`） |
| POST | `/api/generation/random-sample` | 生成一组随机示例表单参数（代理 `/create_random_sample`） |
| GET | `/api/generation/loras` | 列出 LoRA 风格适配器（含本地下载状态与底模兼容性） |
| POST | `/api/generation/loras/download` | 按需下载指定 LoRA 适配器 |
| GET | `/api/generation/history` | 查询历史歌曲列表（按历史目录扫描，最新在前） |
| GET | `/api/generation/history/{id}/file` | 播放/下载历史歌曲文件（`name=...&download=true`） |
| GET | `/api/generation/history/{id}/params` | 下载历史歌曲参数快照 |
| PATCH | `/api/generation/history/{id}/rename` | 重命名历史歌曲 |
| DELETE | `/api/generation/history/{id}` | 删除历史歌曲文件夹 |
| GET | `/api/generation/{id}` | 查询生成任务状态/进度 |
| GET | `/api/generation/{id}/events` | SSE 实时进度推送 |
| GET | `/api/generation/{id}/track/{i}` | 播放/下载第 i 条生成音轨（`?download=true`） |
| POST | `/api/generation/{id}/to-separation?index=i` | 把生成音轨送入分轨流程，返回新分轨任务 |
| POST | `/api/generation/service/start` | 按需启动 ACE-Step sidecar |
| POST | `/api/generation/service/restart` | 重启 ACE-Step sidecar |
| POST | `/api/generation/service/stop` | 停止 ACE-Step sidecar |
| POST | `/api/edit/melody` | 本地生成一条调内旋律线（可选分析伴奏 key/bpm），返回 MIDI 音符 |
| POST | `/api/edit` | 提交多轨混音/编辑任务（JSON），复用 job/SSE |
| POST | `/api/edit/upload` | 暂存外部音频作为「添加乐器」附加轨 |
| GET | `/api/edit/{job_id}` | 查询编辑任务状态/进度 |
| GET | `/api/edit/{job_id}/events` | SSE 实时进度推送 |
| GET | `/api/edit/{job_id}/result` | 播放/下载编辑导出成品（`?download=true`） |
| GET | `/api/logs/{acestep\|svc}` | 读取本次运行日志 |
| GET | `/api/logs/{acestep\|svc}/events` | SSE 实时日志流 |
| GET | `/api/svc/capabilities` | SVC 服务状态、设备和各引擎训练/推理可用性 |
| GET | `/api/svc/voices` | 获取已训练音源列表 |
| POST | `/api/svc/train` | 上传声音样本训练音源（multipart：`files[]`、`name`、`engine`、`max_epochs`） |
| GET | `/api/svc/train/{train_id}` | 查询 SVC 训练状态/进度 |
| POST | `/api/svc/voices/{voice_id}/preview` | 上传音频并用指定音源试听转换 |
| GET | `/api/svc/voices/{voice_id}/export` | 导出音源为压缩包（备份/迁移） |
| POST | `/api/svc/voices/import` | 导入音源压缩包 |
| POST | `/api/svc/service/restart` | 重启 SVC sidecar |
| DELETE | `/api/svc/voices/{voice_id}` | 删除音源 |

## 引擎扩展机制

引擎能力由**模型实际源列表**动态决定：

- `backend/app/engines/mapping.py`：模型 `source → 规范 stem` 别名表 + 已知模型源注册表（用于在不加载模型的情况下计算 `capabilities`）。
- `backend/app/engines/demucs_engine.py`：`supported_stems()` 根据源列表（`APP_DEMUCS_SOURCES` 或已知模型表）+ 级联开关动态计算；`_load_model()` 支持按名称（`get_model`）或路径（`load_model`）加载自训练模型。
- 新增引擎只需实现 `backend/app/engines/base.py` 的 `SeparationEngine` 并在 `factory.py` 注册。

接入自训练 10 轨模型后无需改前端：界面与能力矩阵会按新 `sources` 自动放开对应复选框。详见 [backend/training/README.md](backend/training/README.md)。

## 常见问题（Troubleshooting）

- **上传报 503 / 控制台 `Connection refused localhost:6379`**：只单独运行了 `uvicorn`，没有 Redis/worker。请改用 `./start.sh` 或 `python run_local.py`。
- **`音轨分离失败: [Errno 2] No such file or directory: 'ffmpeg'`**：`static-ffmpeg` 的二进制未就位（其首次联网下载在部分机器上因 SSL 证书校验失败）。`start.sh` 已内置 curl 兜底下载；若仍缺失，可手动安装系统 ffmpeg，或设 `APP_FFMPEG_EXE` / `APP_FFPROBE_EXE` 指向可执行文件。**装好后需重启 worker**（路径有缓存）。
- **`Could not find a version that satisfies the requirement torch==2.5.1` / `No matching distribution`**：venv 用的 Python 版本没有对应的 torch wheel（如 Python 3.14 太新）。本项目锁定 **3.12**：`rm -rf backend/.venv` 后用 `python3.12` 重建（或 `./start.sh`）。
- **`TypeError: unsupported operand type(s) for |` / `Unable to evaluate type annotation 'float | None'`**：venv 用了 Python 3.9，但本项目锁定 3.12。`rm -rf backend/.venv` 后重跑 `./start.sh`。
- **`./start.sh: Permission denied`**：脚本缺执行权限。`chmod +x start.sh` 后重试，或用 `bash start.sh`。
- **`uvicorn: command not found` / `pip install` 报 externally-managed-environment**：没有激活虚拟环境。先 `source backend/.venv/bin/activate`（或直接用 `./start.sh`）。
- **`No module named 'demucs.api'`**：本项目不依赖该模块，使用底层 `demucs.pretrained`/`demucs.apply`；若仍出现请重启 worker 让其加载最新代码（Celery 不热重载）。
- **改了后端代码不生效**：worker 不会热重载，需重启 `./start.sh` / `run_local.py`。
- **首次分轨很久没反应**：在下载 Demucs 模型权重（数百 MB），看 worker 日志进度。
- **自定义分离目录后看不到旧历史**：历史分离记录只扫描当前「分离结果存放目录」。旧目录不会自动迁移，请手动复制旧 `outputs/{job_id}` 到新目录。
- **看不到运行日志或日志不更新**：确认是通过 `./start.sh` 启动；日志在 `logs/runs/YYYYMMDD_HHMMSS/`，设置页「运行日志」读取的是本次运行目录。
- **「音乐生成当前不可用」**：多数是 ACE-Step 服务还在按需启动/下载依赖，或被 `SKIP_ACESTEP=1` 禁用了。打开「音乐生成」页后会自动启动或展示初始化页。纯 CPU 默认关闭生成，需 `APP_ALLOW_CPU_GENERATION=1`。
- **生成超时/失败**：看运行 `./start.sh` 的终端里 `[acestep]` 相关日志；显存不足可在 `external/ACE-Step-1.5/.env` 里降档（`ACESTEP_CONFIG_PATH=acestep-v15-turbo` + `ACESTEP_OFFLOAD_TO_CPU=true`）。
- **「SVC 音源服务未启动」**：确认没有设置 `SKIP_SVC=1`，并用 `./start.sh` 启动完整服务；单独调试时可进入 `svc_service/` 执行 `uv run uvicorn app.main:app --host 127.0.0.1 --port 8002`。
- **SVC 训练按钮不可用**：查看界面里的引擎提示，通常是 so-vits 依赖未安装成功或当前设备不满足训练条件；可在 `svc_service/` 下重跑 `uv sync --system-certs`。
- **开启人声模式后生成变慢**：生成完成后还会额外执行分离、人声转换和混音，属于预期；CPU/MPS 上会更慢。

## 生产化要点

- 上传大小/格式校验（`app/config.py`），流式落盘防止内存爆。
- Celery `concurrency=1`、`prefetch=1`，避免多个 Demucs 推理同时 OOM；`generation` / `default` 双队列隔离长短任务。
- 性能缓存：Demucs 模型按 `(model, repo, device)` 进程级缓存；硬件检测结果落盘缓存；历史列表接口用 TTL 缓存并绑定目录 mtime。
- 定时任务 `cleanup_old_jobs` 按 `APP_JOB_TTL_HOURS` 清理过期 job 目录。
- 下载与打包均为流式响应。
- Redis 不可达时，API 启动会打印警告、上传返回清晰的 503，而非 500 堆栈。
