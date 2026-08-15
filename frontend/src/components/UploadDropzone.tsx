import { useCallback, useRef, useState } from "react";

interface Props {
  file: File | null;
  onFile: (file: File) => void;
  disabled?: boolean;
}

const ACCEPT = ".mp3,.wav,.flac,.m4a,.aac,.ogg";

export function UploadDropzone({ file, onFile, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      const f = e.dataTransfer.files?.[0];
      if (f) onFile(f);
    },
    [disabled, onFile],
  );

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (disabled) return;
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={[
        "rounded-xl border-2 border-dashed p-6 text-center transition cursor-pointer select-none",
        dragging ? "border-brand-500 bg-brand-500/10" : "border-gray-600 hover:border-brand-400",
        disabled ? "opacity-50 cursor-not-allowed" : "",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          if (disabled) return;
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <div className="text-3xl mb-2">🎵</div>
      {file ? (
        <div>
          <div className="font-medium text-gray-100 break-all">{file.name}</div>
          <div className="text-xs text-gray-400 mt-1">
            {(file.size / 1024 / 1024).toFixed(1)} MB · 点击重新选择
          </div>
        </div>
      ) : (
        <div>
          <div className="font-medium text-gray-200">拖拽音频到此处，或点击上传</div>
          <div className="text-xs text-gray-400 mt-1">支持 mp3 / wav / flac / m4a / aac / ogg</div>
        </div>
      )}
    </div>
  );
}
