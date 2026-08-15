/** 阶段1 占位标签：展示标题与说明，功能后续接入。 */
export function PlaceholderTab({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-sm leading-relaxed text-gray-500">
        {desc}
      </div>
    </div>
  );
}
