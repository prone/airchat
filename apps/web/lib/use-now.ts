'use client';

import { useEffect, useState } from 'react';

/**
 * A clock you can safely read during render.
 *
 * Calling `Date.now()` in a component body makes render impure: the same props
 * and state produce different output depending on when React happens to run it.
 * The React Compiler rules flag this (react-hooks/purity), and it is a real
 * defect rather than a technicality — anything derived from "now" only updates
 * when something *else* causes a re-render.
 *
 * The presence dots on the dashboard had exactly that bug. An agent last seen
 * nine minutes ago rendered as online, and stayed online well past the ten
 * minute threshold, because nothing re-rendered the sidebar. The dot was
 * accurate at paint and quietly wrong from then on.
 *
 * Returning `now` as state fixes both problems at once: render becomes a pure
 * function of its inputs, and the value actually advances.
 *
 * @param intervalMs how often to advance. Pick from the precision the UI needs,
 *   not the precision available — a ten minute threshold does not need a
 *   one second tick, and each tick re-renders every consumer.
 */
export function useNow(intervalMs = 30_000): number {
  // Lazy initialiser: evaluated once during mount rather than on every render,
  // so this is not itself an impure read.
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
