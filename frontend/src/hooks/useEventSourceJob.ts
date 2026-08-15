import { useCallback, useEffect, useRef } from "react";
import type { JobStatus } from "../types";

const POLL_INTERVAL_MS = 2000;

function isTerminal(state: JobStatus["state"]): boolean {
  return state === "done" || state === "failed";
}

export interface EventSourceJobController {
  /** Open an SSE stream for `jobId`, falling back to polling on error. */
  subscribe: (jobId: string) => void;
  /** Close the SSE stream and stop any polling. */
  cleanup: () => void;
}

/**
 * Shared subscription lifecycle for job-style endpoints: listen to the `status`
 * SSE channel, and if the stream drops, fall back to polling `fetchJob`. Both
 * paths push updates through `onUpdate` and auto-clean up on a terminal state.
 */
export function useEventSourceJob(
  eventsUrl: (jobId: string) => string,
  fetchJob: (jobId: string) => Promise<JobStatus>,
  onUpdate: (data: JobStatus) => void,
): EventSourceJobController {
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;

  const cleanup = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const subscribe = useCallback(
    (jobId: string) => {
      cleanup();
      const es = new EventSource(eventsUrl(jobId));
      esRef.current = es;
      es.addEventListener("status", (ev) => {
        try {
          const data: JobStatus = JSON.parse((ev as MessageEvent).data);
          updateRef.current(data);
          if (isTerminal(data.state)) cleanup();
        } catch {
          /* ignore malformed */
        }
      });
      es.onerror = () => {
        // SSE dropped: fall back to polling.
        cleanup();
        pollRef.current = setInterval(async () => {
          try {
            const data = await fetchJob(jobId);
            updateRef.current(data);
            if (isTerminal(data.state)) cleanup();
          } catch {
            /* ignore */
          }
        }, POLL_INTERVAL_MS);
      };
    },
    [cleanup, eventsUrl, fetchJob],
  );

  useEffect(() => cleanup, [cleanup]);

  return { subscribe, cleanup };
}
