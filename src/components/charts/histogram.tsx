"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { ValueFormatter } from "./fmt";
import { autoStride, histogramLayout, niceTicks } from "./geometry";
import { tipHide, tipRow, tipShow, tipText, tipTitle } from "./tooltip";
import { useContainerWidth } from "./use-container-width";

/* Histogram with hover — a 1:1 port of kit.js histogram. Bars have
   top-rounded corners only (path, not rect); small bucket counts (n ≤ 3)
   cap the slot width and centre the group. */

export type HistogramBucket = {
  label: string;
  count: number;
  tipLabel?: string;
  /** Red bar (losses). */
  neg?: boolean;
  /** Accent (indigo) bar with a forced value + emphasised x label. */
  accent?: boolean;
  /** Extra plain text appended after the count row. */
  extra?: string;
};

export type HistogramProps = {
  buckets: HistogramBucket[];
  yFmt?: ValueFormatter;
  valFmt?: (v: number) => string;
  seriesName?: string;
  w?: number;
  h?: number;
  className?: string;
  style?: CSSProperties;
};

export function Histogram(props: HistogramProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const W = props.w || measuredW, H = props.h || 220;
  const L = 10, R = 46, T = 22, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const buckets = props.buckets;
  const { ticks, hi } = niceTicks(0, Math.max(...buckets.map((b) => b.count)), 3);
  const Y = (v: number) => T + ih - (v / hi) * ih;
  const n = buckets.length;
  const { slot, xoff, bw } = histogramLayout(n, iw, L);
  const vf = props.valFmt || String;
  const stride = autoStride(n, iw);

  const enter = (b: HistogramBucket, fill: string) => (e: ReactPointerEvent<SVGPathElement>) =>
    tipShow(
      tipTitle(b.tipLabel || b.label) + tipRow(fill, props.seriesName || "Jobs", vf(b.count)) + (b.extra ? tipText(b.extra) : ""),
      e.clientX,
      e.clientY,
    );

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch">
        {ticks.map((v) => (
          <g key={`t${v}`}>
            <line x1={L} x2={L + iw} y1={Y(v)} y2={Y(v)} stroke="#eff1f5" />
            <text x={W - R + 10} y={Y(v) + 3.5} fontSize={12} fill="#6b7383" className="tnum">
              {(props.yFmt || ((x: number) => Math.round(x)))(v)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const cx = xoff + slot * i + slot / 2;
          const fill = b.neg ? "#d0463a" : b.accent ? "#5b63d3" : "#8a92a4";
          const by = Y(b.count), bhh = Math.max(1.5, T + ih - by), r0 = Math.min(5, bw / 2, bhh);
          const d = `M${(cx - bw / 2).toFixed(1)},${(by + bhh).toFixed(1)}V${(by + r0).toFixed(1)}Q${(cx - bw / 2).toFixed(1)},${by.toFixed(1)} ${(cx - bw / 2 + r0).toFixed(1)},${by.toFixed(1)}H${(cx + bw / 2 - r0).toFixed(1)}Q${(cx + bw / 2).toFixed(1)},${by.toFixed(1)} ${(cx + bw / 2).toFixed(1)},${(by + r0).toFixed(1)}V${(by + bhh).toFixed(1)}Z`;
          const isLast = i === n - 1;
          return (
            <g key={i}>
              <path d={d} fill={fill} onPointerEnter={enter(b, fill)} onPointerLeave={tipHide} />
              {n <= 8 || b.accent || i % stride === 0 ? (
                <text
                  x={cx}
                  y={Y(b.count) - 7}
                  fontSize={12.5}
                  fontWeight={700}
                  fill={b.neg ? "#d0463a" : "#2a3140"}
                  className="tnum"
                  textAnchor="middle"
                >
                  {vf(b.count)}
                </text>
              ) : null}
              {n <= 8 || isLast || (i % stride === 0 && n - 1 - i >= stride * 0.7) ? (
                <text
                  x={cx}
                  y={H - 9}
                  fontSize={12}
                  fill={b.accent ? "#101422" : "#6b7383"}
                  fontWeight={b.accent ? 700 : 400}
                  textAnchor="middle"
                >
                  {b.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
