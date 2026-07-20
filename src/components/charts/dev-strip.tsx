"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { ValueFormatter } from "./fmt";
import { tipHide, tipRow, tipShow, tipTitle } from "./tooltip";
import { useContainerWidth } from "./use-container-width";

/* Per-item diverging strip: one thin column per item around a zero axis —
   a 1:1 port of kit.js devStrip. Items arrive sorted by the caller.
   Positive variance renders red, negative green (variance = overrun). */

export type DevStripItem = { v: number; label?: string };

export type DevStripProps = {
  items: DevStripItem[];
  fmt?: ValueFormatter;
  unit?: string;
  h?: number;
  w?: number;
  className?: string;
  style?: CSSProperties;
};

export function DevStrip(props: DevStripProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const W = props.w || measuredW, H = props.h || 150;
  const L = 8, R = 64, T = 16, B = 20;
  const iw = W - L - R, ih = H - T - B;
  const items = props.items;
  if (items.length === 0) {
    return (
      <div ref={containerRef} className={props.className} style={props.style}>
        <svg viewBox={`0 0 ${W} ${H}`} className="ch" aria-hidden="true" />
      </div>
    );
  }
  const maxAbs = Math.max(...items.map((d) => Math.abs(d.v))) || 1;
  const Y = (v: number) => T + ih / 2 - (v / maxAbs) * (ih / 2);
  const slot = iw / items.length, bw = Math.max(2, Math.min(10, slot * 0.7));
  const f = props.fmt || ((v: number) => String(v));

  const enter = (d: DevStripItem, up: boolean) => (e: ReactPointerEvent<SVGRectElement>) =>
    tipShow(
      tipTitle(d.label || "") + tipRow(up ? "#d0463a" : "#1a8a5a", props.unit || "Variance", f(d.v)),
      e.clientX,
      e.clientY,
    );

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch">
        <line x1={L} x2={L + iw} y1={Y(0)} y2={Y(0)} stroke="#e2e6ec" strokeWidth={1.2} />
        {items.map((d, i) => {
          const cx = L + slot * i + slot / 2;
          const up = d.v > 0;
          return (
            <rect
              key={i}
              x={cx - bw / 2}
              y={Math.min(Y(0), Y(d.v))}
              width={bw}
              height={Math.max(1.5, Math.abs(Y(d.v) - Y(0)))}
              rx={1.5}
              fill={d.v === 0 ? "#d8dce6" : up ? "#d0463a" : "#1a8a5a"}
              onPointerEnter={enter(d, up)}
              onPointerLeave={tipHide}
            />
          );
        })}
        <text x={W - R + 8} y={Y(maxAbs) + 4} fontSize={12} fill="#6b7383" className="tnum">
          {"+" + f(maxAbs)}
        </text>
        <text x={W - R + 8} y={Y(0) + 4} fontSize={12} fill="#6b7383">
          0
        </text>
      </svg>
    </div>
  );
}
