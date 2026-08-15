import { useCallback, useState } from "react";
import {
  createGeneration,
  fetchGenerationJob,
  generationEventsUrl,
} from "../api";
import type { GenerationParams, JobStatus } from "../types";
import { useEventSourceJob } from "./useEventSourceJob";

interface UseGenerationJobResult {
  job: JobStatus | null;
  starting: boolean;
  error: string | null;
  start: (params: GenerationParams) => Promise<void>;
  reset: () => void;
}

export function useGenerationJob(): UseGenerationJobResult {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { subscribe, cleanup } = useEventSourceJob(
    generationEventsUrl,
    fetchGenerationJob,
    setJob,
  );

  const start = useCallback(
    async (params: GenerationParams) => {
      setError(null);
      setStarting(true);
      try {
        const created = await createGeneration(params);
        setJob(created);
        subscribe(created.id);
      } catch (e: any) {
        setError(e?.response?.data?.detail ?? "提交生成失败，请重试");
      } finally {
        setStarting(false);
      }
    },
    [subscribe],
  );

  const reset = useCallback(() => {
    cleanup();
    setJob(null);
    setError(null);
  }, [cleanup]);

  return { job, starting, error, start, reset };
}
