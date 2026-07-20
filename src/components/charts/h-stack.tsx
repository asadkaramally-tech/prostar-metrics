"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { tipHide, tipShow, tipTitle } from "./tooltip";
import { useContainerWidth } from "./use-container-width";

/* Horizontal stacked bars (capacity): container-true width, hover, compact
   mode — a 1:1 port of kit.js hStack. The cap marker is a dark tick; the
   right-side note turns red for over-capacity rows. */

export type HStackSegment = { v: number; color: string };

export type HStackRow = {
  name: string;
  segs: HStackSegment[];
  cap?: number;
  note?: string;
  noteShort?: string;
  noteColor?: string;
  over?: boolean;
  /** Tooltip body (HTML string built with tipRow), appended after the title. */
  tip?: string;
};

export type HStackProps = {
  rows: HStackRow[];
  rowH?: number;
  labelW?: number;
  noteW?: number;
  w?: number;
  className?: string;
  style?: CSSProperties;
};

export function HStack(props: HStackProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const W = props.w || measuredW;
  const rows = props.rows;
  const compact = W < 520;
  const rowH = compact ? 54 : props.rowH || 38;
  const L = compact ? 0 : props.labelW || 126;
  const R = compact ? 54 : props.noteW || 124;
  const T = 6;
  const H = T + rows.length * rowH + 6;
  const iw = W - L - R;
  const maxV = Math.max(...rows.map((r) => Math.max(r.cap || 0, r.segs.reduce((s, x) => s + x.v, 0)))) * 1.04;

  const enter = (r: HStackRow) => (e: ReactPointerEvent<SVGRectElement>) => {
    if (r.tip) tipShow(tipTitle(r.name) + r.tip, e.clientX, e.clientY);
  };
  const leave = (r: HStackRow) => () => {
    if (r.tip) tipHide();
  };

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch">
        {rows.map((r, ri) => {
          const y = T + ri * rowH + (compact ? 26 : (rowH - 16) / 2), bh = 16;
          let x = L;
          const segs = r.segs.map((sg, sgi) => {
            const w = (sg.v / maxV) * iw;
            const seg = w > 0.5 ? <rect key={sgi} x={x} y={y} width={w} height={bh} fill={sg.color} /> : null;
            x += w;
            return seg;
          });
          return (
            <g key={ri}>
              <text x={0} y={compact ? y - 9 : y + bh / 2 + 4} fontSize={13.5} fontWeight={600} fill="#2a3140">
                {r.name}
              </text>
              <rect x={L} y={y} width={iw} height={bh} rx={5} fill="#f3f4f8" />
              {segs}
              <rect x={L} y={y} width={iw} height={bh} rx={5} fill="none" stroke="#e9ebf0" />
              {r.cap ? (
                <rect x={L + (r.cap / maxV) * iw - 1} y={y - 4} width={2} height={bh + 8} rx={1} fill="#1c2230" />
              ) : null}
              <text
                x={L + iw + 12}
                y={y + bh / 2 + 4}
                className="tnum"
                fontSize={compact ? 11 : 12}
                fontWeight={700}
                fill={r.noteColor || (r.over ? "#d0463a" : "#5c6474")}
              >
                {(compact ? r.noteShort ?? r.note : r.note) || ""}
              </text>
              <rect
                x={L}
                y={y - 6}
                width={iw + R}
                height={bh + 12}
                fill="transparent"
                onPointerEnter={enter(r)}
                onPointerLeave={leave(r)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
