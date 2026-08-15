interface HintProps {
  text: string;
}

/** Small info icon that reveals an explanatory tooltip on hover/focus. */
export function Hint({ text }: HintProps) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <span
        tabIndex={0}
        title={text}
        aria-label={text}
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-gray-600 text-[10px] leading-none text-gray-400 hover:border-gray-400 hover:text-gray-200"
      >
        i
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-60 -translate-x-1/2 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-[11px] font-normal leading-relaxed text-gray-200 opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
