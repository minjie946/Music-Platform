import { useCallback, useState } from "react";
import {
  fetchGenerationJob,
  generationEventsUrl,
  type InitGuardDetail,
  initializeGeneration,
} from "../api";
import type { JobStatus } from "../types";
import { useEventSourceJob } from "./useEventSourceJob";

interface UseInitJobResult {
  job: JobStatus | null;
  starting: boolean;
  error: string | null;
  guard: InitGuardDetail | null;
  start: (opts?: { dit_model?: string; lm_model?: string; force_memory_guard?: boolean }) => Promise<void>;
}

/** Drives the ACE-Step model initialization (download + load) job. */
export function useInitJob(onDone?: () => void): UseInitJobResult {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guard, setGuard] = useState<InitGuardDetail | null>(null);

  const handleUpdate = useCallback(
    (data: JobStatus) => {
      setJob(data);
      if (data.state === "done") onDone?.();
    },
    [onDone],
  );

  const { subscribe } = useEventSourceJob(
    generationEventsUrl,
    fetchGenerationJob,
    handleUpdate,
  );

  const start = useCallback(async (opts?: { dit_model?: string; lm_model?: string; force_memory_guard?: boolean }) => {
    setError(null);
    setGuard(null);
    setStarting(true);
    try {
      const created = await initializeGeneration(opts);
      setJob(created);
      subscribe(created.id);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      if (detail && typeof detail === "object" && typeof detail.type === "string") {
        setGuard(detail as InitGuardDetail);
        setError((detail as InitGuardDetail).message || "初始化失败，请重试");
      } else {
        setError(detail ?? "初始化失败，请重试");
      }
    } finally {
      setStarting(false);
    }
  }, [subscribe]);

  return { job, starting, error, guard, start };
}
