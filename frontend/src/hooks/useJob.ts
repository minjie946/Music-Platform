import { useCallback, useState } from "react";
import { createJob, fetchJob, jobEventsUrl } from "../api";
import type { JobStatus } from "../types";
import { useEventSourceJob } from "./useEventSourceJob";

interface UseJobResult {
  job: JobStatus | null;
  starting: boolean;
  error: string | null;
  start: (file: File, stems: string[], engine?: string, outputFormat?: string) => Promise<void>;
  adopt: (job: JobStatus) => void;
  reset: () => void;
}

export function useJob(): UseJobResult {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { subscribe, cleanup } = useEventSourceJob(jobEventsUrl, fetchJob, setJob);

  const start = useCallback(
    async (file: File, stems: string[], engine?: string, outputFormat?: string) => {
      setError(null);
      setStarting(true);
      try {
        const created = await createJob(file, stems, engine, outputFormat);
        setJob(created);
        subscribe(created.id);
      } catch (e: any) {
        setError(e?.response?.data?.detail ?? "上传失败，请重试");
      } finally {
        setStarting(false);
      }
    },
    [subscribe],
  );

  const adopt = useCallback(
    (incoming: JobStatus) => {
      setError(null);
      setJob(incoming);
      subscribe(incoming.id);
    },
    [subscribe],
  );

  const reset = useCallback(() => {
    cleanup();
    setJob(null);
    setError(null);
  }, [cleanup]);

  return { job, starting, error, start, adopt, reset };
}
