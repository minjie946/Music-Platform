import { useState } from "react";
import { browseDirectory as apiBrowse } from "../api";

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function DirectoryPicker({
  value,
  onChange,
  placeholder,
  disabled,
  title = "选择目录",
  className = "",
}: Props) {
  const [browsing, setBrowsing] = useState(false);

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const result = await apiBrowse(title);
      if (!result.cancelled && result.path) {
        onChange(result.path);
      }
    } catch {
      // ignore
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <div className={`flex gap-2 ${className}`}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled || browsing}
        className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={handleBrowse}
        disabled={disabled || browsing}
        className="flex items-center gap-1.5 rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-gray-200 hover:bg-gray-600 disabled:opacity-50 shrink-0"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
          />
        </svg>
        {browsing ? "..." : "浏览"}
      </button>
    </div>
  );
}