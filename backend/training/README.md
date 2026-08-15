# 训练自定义 10 轨 Demucs（路线 B）

目标：训练一个 **10 源** 的 Demucs 模型，源名直接使用项目的规范 stem id：

```
lead_vocals, backing_vocals, drums, bass, acoustic_guitar,
electric_guitar, piano, synth, strings, other
```

训练完成并接入后，引擎会**按模型实际 sources 自动开放这 10 个分轨**（前端复选框自动放开），无需改业务代码。

> 说明：从零训练 Demucs 需要 GPU（建议多卡）、合适数据集与数小时~数天时间。这里提供完整工程脚手架，训练在你的机器上跑。

## 1. 准备环境

```bash
uv pip install -U demucs               # 训练用，自带 dora/hydra
uv pip install moisesdb soundfile numpy librosa
```

## 2. 准备数据集（MoisesDB → Demucs wav 数据集）

[MoisesDB](https://github.com/moises-ai/moises-db) 含细粒度分轨（lead/backing 人声、acoustic/electric 吉他、bowed strings 弦乐、piano、other_keys 等），适合训练这 10 轨。下载后：

```bash
python prepare_moisesdb.py \
  --moisesdb /path/to/moisesdb_v0.1 \
  --out      /path/to/dataset_10stem
```

脚本把每首歌转成 Demucs 需要的目录结构（每个 track 目录含 `mixture.wav` + 10 个 stem 的 wav，缺失的轨写静音）。子类型→规范轨的映射规则见 `prepare_moisesdb.py` 顶部的 `SUBTYPE_RULES` / `STEM_FALLBACK`，请对照你下载的副本核对微调。

## 3. 训练

Demucs 用 [dora](https://github.com/facebookresearch/dora) 管理实验。用命令行覆盖数据集与源列表（从零训练 htdemucs 架构）：

```bash
dora run -d \
  dset.wav=/path/to/dataset_10stem \
  dset.use_musdb=false \
  dset.sources="['lead_vocals','backing_vocals','drums','bass','acoustic_guitar','electric_guitar','piano','synth','strings','other']" \
  model=htdemucs \
  variant=default
```

要点：
- `dset.sources` 决定模型输出多少个源（这里 10 个），顺序即输出顺序。
- 显存不足时调小 `batch_size`、`model.segment`，或减少 `epochs` 先跑通。
- 多卡：`dora run -d` 默认用全部可见 GPU；可用 `CUDA_VISIBLE_DEVICES` 控制。
- 不同 demucs 版本的字段可能略有差异，详见 `demucs/docs/training.md`。

训练产物在 dora 的实验目录（XP），形如 `outputs/xps/<signature>/`。

## 4. 导出可用模型

把训练 checkpoint 导出成 Demucs「打包模型」（单个 `.th`，可被 `demucs.states.load_model` 直接加载）。在 demucs 源码仓库里：

```bash
python -m tools.export <signature>     # 生成 release_models/<signature>.th
```

把导出的 `.th` 拷到本项目，例如 `backend/models/my10stem.th`。

## 5. 接入应用

引擎已支持加载自定义模型（`app/engines/demucs_engine.py` 的 `_load_model`：路径走 `load_model`，名称走 `get_model`）。配置环境变量（或 `.env`）：

```bash
# 指向打包好的 .th
APP_DEMUCS_MODEL=/abs/path/backend/models/my10stem.th

# 让 capabilities 在不加载模型的情况下也能报告 10 轨（逗号分隔，顺序需与训练一致）
APP_DEMUCS_SOURCES=lead_vocals,backing_vocals,drums,bass,acoustic_guitar,electric_guitar,piano,synth,strings,other
```

重启后端后，`GET /api/engine/capabilities` 会显示这 10 轨全部 supported，前端复选框自动放开。

## 与路线 A（级联）的关系

- 路线 A（设置里「级联拆分主唱/伴唱」）用 karaoke 模型在 6 轨基础上补出主唱/伴唱，今天就能用。
- 路线 B 训练出的 10 源模型一旦接入，`sources` 已含 `lead_vocals`/`backing_vocals`，可直接区分，无需级联；此时可关闭级联开关。
