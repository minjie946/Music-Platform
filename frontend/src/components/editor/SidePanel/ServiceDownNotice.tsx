/** 判断是否为「生成服务未启动」类错误（后端 503 / 文案含“服务未启动”）。 */
export function isServiceDownError(e: any): boolean {
  const status = e?.response?.status;
  const detail = e?.response?.data?.detail || e?.message || "";
  return status === 503 || /服务未启动|未启动生成服务|ACE-Step/.test(String(detail));
}

interface Props {
  onGoToGenerate?: () => void;
  className?: string;
}

/** 服务未启动时的友好提示 + 一键跳转到音乐生成页启动服务。 */
export function ServiceDownNotice({ onGoToGenerate, className }: Props) {
  return (
    <div
      className={[
        "rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200",
        className || "",
      ].join(" ")}
    >
      <p>歌词生成需要「音乐生成」服务在运行（与生成音乐用同一个模型）。</p>
      {onGoToGenerate && (
        <button
          type="button"
          onClick={onGoToGenerate}
          className="mt-2 rounded-md bg-amber-500/20 px-2.5 py-1 text-amber-100 transition hover:bg-amber-500/30"
        >
          前往音乐生成页启动 →
        </button>
      )}
    </div>
  );
}
