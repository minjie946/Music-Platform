/** Format a duration in seconds as `m:ss`. */
export function fmtDuration(sec: number): string {
  if (!isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Format a byte count as MB/KB; empty string for non-positive sizes. */
export function fmtSize(bytes: number): string {
  if (bytes <= 0) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** Format an epoch (seconds) as `YYYY-MM-DD HH:MM`. */
export function fmtDate(epoch: number): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Format an epoch (seconds) using the user's locale; `fallback` when empty. */
export function fmtDateTime(ts: number, fallback = ""): string {
  if (!ts) return fallback;
  return new Date(ts * 1000).toLocaleString();
}
