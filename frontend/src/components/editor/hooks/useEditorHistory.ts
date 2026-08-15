import { useCallback, useRef, useState } from "react";

interface History<T> {
  state: T;
  set: (updater: T | ((prev: T) => T)) => void;
  /** 重置为新初始值并清空历史（用于外部 initialTracks 变化）。 */
  reset: (value: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 50;

/**
 * 带撤销/重做的状态容器。每次 set 把上一状态压入 past 栈；undo/redo 在 past/future 间搬移。
 */
export function useEditorHistory<T>(initial: T): History<T> {
  const [state, setState] = useState<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const set = useCallback(
    (updater: T | ((prev: T) => T)) => {
      setState((prev) => {
        const next =
          typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
        if (next === prev) return prev;
        past.current.push(prev);
        if (past.current.length > MAX_HISTORY) past.current.shift();
        future.current = [];
        rerender();
        return next;
      });
    },
    [rerender],
  );

  const reset = useCallback(
    (value: T) => {
      past.current = [];
      future.current = [];
      setState(value);
      rerender();
    },
    [rerender],
  );

  const undo = useCallback(() => {
    setState((prev) => {
      if (past.current.length === 0) return prev;
      const previous = past.current.pop() as T;
      future.current.unshift(prev);
      rerender();
      return previous;
    });
  }, [rerender]);

  const redo = useCallback(() => {
    setState((prev) => {
      if (future.current.length === 0) return prev;
      const next = future.current.shift() as T;
      past.current.push(prev);
      rerender();
      return next;
    });
  }, [rerender]);

  return {
    state,
    set,
    reset,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
