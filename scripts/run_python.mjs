#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("[run-python] missing script argument");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectPython = process.platform === "win32"
  ? resolve(root, "backend", ".venv", "Scripts", "python.exe")
  : resolve(root, "backend", ".venv", "bin", "python");

const candidates = process.platform === "win32"
  ? [
    [projectPython, []],
    ["python", []],
    ["py", ["-3"]],
    ["python3", []],
  ]
  : [
    [projectPython, []],
    ["python3", []],
    ["python", []],
  ];

for (const [command, prefix] of candidates) {
  const env = {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const probe = spawnSync(
    command,
    [...prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
    { stdio: "ignore", env },
  );
  if (probe.status === 0) {
    const result = spawnSync(command, [...prefix, ...args], { stdio: "inherit", env });
    process.exit(result.status ?? 1);
  }
}

console.error("[run-python] Python >= 3.10 is required but was not found.");
process.exit(1);
