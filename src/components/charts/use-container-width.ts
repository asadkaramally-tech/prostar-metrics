"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

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

  const width = fixedW || measured || 560;
  return [ref, width] as const;
}
