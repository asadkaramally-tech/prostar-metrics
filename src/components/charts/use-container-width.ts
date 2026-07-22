"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Desktop-first server/client fallback. The dashboard is primarily used on
 * desktop; starting charts at the old 560px fallback made every client-side
 * page navigation briefly render narrow/mobile chart geometry before the
 * ResizeObserver reported the real container width.
 */
export const DEFAULT_CONTAINER_WIDTH = 960;

/* Container-true sizing, matching the kit's `opts.w || container.clientWidth
   || 560` contract, plus a redraw on every resize via ResizeObserver. */
export function useContainerWidth<T extends HTMLElement>(fixedW?: number) {
  const ref = useRef<T | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);

  useIsoLayoutEffect(() => {
    if (fixedW) return;
    const node = ref.current;
    if (!node) return;
    const measure = () => setMeasured(node.clientWidth || null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [fixedW]);

  const width = fixedW || measured || DEFAULT_CONTAINER_WIDTH;
  return [ref, width] as const;
}
