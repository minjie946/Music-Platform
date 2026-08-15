import { Drawer } from "./Drawer";

interface UserManualDrawerProps {
  open: boolean;
  onClose: () => void;
}

const steps = [
  {
    title: "1. 首次启动",
    body: [
      "开发模式用 ./start.sh；桌面开发模式用 ./start-desktop.sh。",
      "首次启动会自动准备后端、前端、SVC 和 ACE-Step 的基础运行目录。",
      "进入音乐生成页后，ACE-Step 会按需启动并加载模型。",
    ],
  },
  {
    title: "2. 音乐生成",
    body: [
      "打开“音乐生成”，先完成模型目录和初始化。",
      "填写风格、歌词、时长等参数后开始生成。",
      "生成结果会进入历史歌曲，可下载，也可一键发送到“音轨分离”。",
    ],
  },
  {
    title: "3. 音轨分离",
    body: [
      "打开“音轨分离”，上传音频，选择需要的 stem。",
      "完成后可试听、单轨下载，或一键打包下载全部音轨。",
      "历史记录来自分离输出目录，切换目录不会自动迁移旧记录。",
    ],
  },
  {
    title: "4. SVC 音源",
    body: [
      "打开“设置”先配置 SVC 音源目录。",
      "在“SVC 音源”中导入、训练或管理音源。",
      "音乐生成的人声模式会先分离主唱，再转成选中的 SVC 音色并回混。",
    ],
  },
];

export function UserManualDrawer({ open, onClose }: UserManualDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="使用手册"
      width={920}
      contentClassName="flex-1 min-h-0 overflow-y-auto px-6 py-5"
    >
      <div className="space-y-5 text-sm text-gray-300">
        <section className="rounded-2xl border border-gray-800 bg-gray-950/40 p-5">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-brand-300">Music Studio</div>
          <h3 className="mt-2 text-xl font-semibold text-gray-100">本地音乐工作台使用手册</h3>
          <p className="mt-2 leading-6 text-gray-400">
            这里汇总当前项目的主要使用路径：音乐生成、音轨分离、SVC 音源和桌面端资源管理。
          </p>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          {steps.map((item) => (
            <section key={item.title} className="rounded-2xl border border-gray-800 bg-gray-900/40 p-4">
              <h4 className="font-semibold text-gray-100">{item.title}</h4>
              <ul className="mt-3 space-y-2">
                {item.body.map((line) => (
                  <li key={line} className="leading-6 text-gray-400">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <section className="rounded-2xl border border-amber-700/50 bg-amber-950/20 p-5">
          <h4 className="font-semibold text-amber-100">常见问题</h4>
          <div className="mt-3 space-y-3 leading-6 text-amber-100/80">
            <p>音乐生成需要先在“设置”里配置模型目录并完成初始化，才能开始生成。</p>
            <p>人声模式依赖 SVC 音源服务，请先在“SVC 音源”里准备好可用音色。</p>
            <p>如果本地处理很慢，这是正常的。Mac 适合小规模试跑，重负载更推荐 Linux + NVIDIA GPU。</p>
          </div>
        </section>
      </div>
    </Drawer>
  );
}
