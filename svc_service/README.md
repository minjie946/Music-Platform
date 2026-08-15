# SVC 音源服务 (sidecar)

歌声转换（Singing Voice Conversion）独立服务，供「音乐工作台」的「人声模式」调用：
把生成歌曲分离出的人声转换成用户训练的音色，再与伴奏混音。

- 引擎：`so-vits-svc-fork`（跨平台训练+推理）。
- 默认监听 `127.0.0.1:8002`。
- 训练好的音源存放在 `SVC_MODELS_DIR`（由后端按「设置」传入；默认 `voices/`）。

## 大文件权重（按需下载，不入库）

content-vec/HuBERT 特征模型与训练底模 D_0/G_0 **不再打包进项目**，首次训练/推理时若缺失会自动从 HuggingFace（默认走 `hf-mirror.com` 镜像）下载。

- 存放目录优先级：`SVC_PRETRAINED_DIR` > `SVC_MODELS_DIR` 同级的 `pretrained/`（即 `workspace/svc/pretrained`）> 兜底项目内 `svc_service/pretrained/`。
- 想放到大盘/自定义目录：设置环境变量 `SVC_PRETRAINED_DIR`，或在应用「设置」里配置 `svc_pretrained_dir`。
- 换下载源：设置 `HF_ENDPOINT`（设为空字符串走官方源）。
- 权重就绪后服务自动走离线模式（`HF_HUB_OFFLINE`），不再联网。
- 相关接口：`GET /pretrained` 查询就绪/下载状态，`POST /pretrained/retry` 重试下载。

## 单独启动（一般由根目录的 `./start.sh` 自动拉起）

```bash
cd svc_service
uv sync                       # 首次安装依赖（较慢，会下载 torch 等）
uv run uvicorn app.main:app --host 127.0.0.1 --port 8002
```

## REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活探测 |
| GET | `/pretrained` | 大文件权重就绪/下载状态 + 目录 |
| POST | `/pretrained/retry` | 重试下载权重 |
| GET | `/capabilities` | 设备 + 各引擎 推理/训练 可用性 |
| GET | `/voices` | 已训练音源列表 |
| POST | `/convert` | multipart：人声 wav + `voice_id` (+`transpose`) → 转换后 wav |
| POST | `/train` | multipart：样本 `files[]` + `name` + `engine` (+`max_epochs`) → `{train_id}` |
| GET | `/train/{train_id}` | 训练进度/状态 |
| DELETE | `/voices/{voice_id}` | 删除音源 |

## 说明

- 服务本身可在缺少 so-vits 依赖时正常启动，并通过 `/capabilities` 报告不可用原因。
- so-vits 训练 `max_epochs` 默认较小以保证在有限时间内产出模型；样本越多/轮数越大效果越好但耗时显著增加。
