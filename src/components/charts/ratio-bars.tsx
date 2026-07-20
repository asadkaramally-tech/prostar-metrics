"use client";

import type { CSSProperties } from "react";
import { useContainerWidth } from "./use-container-width";

/* Ratio bars with a dashed 1.00× reference line — a 1:1 port of kit.js
   ratioBars. Green at or above estimate, neutral within 10% under, red
   below 0.9×. */

export type RatioBarRow = { name: string; v: number | null; cov?: string };

export type RatioBarsProps = {
  rows: RatioBarRow[];
  max?: number;
  labelW?: number;
  w?: number;
  className?: string;
  style?: CSSProperties;
};

export function RatioBars(props: RatioBarsProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const W = props.w || measuredW;
  const rows = props.rows;
  const compact = W < 520;
  const rowH = compact ? 48 : 36;
  const L = compact ? 0 : props.labelW || 126;
  const R = compact ? 60 : 76;
  const T = 8, B = 24;
  const H = T + rows.length * rowH + B;
  const iw = W - L - R;
  const maxV = props.max || Math.max(1.25, ...rows.map((r) => r.v || 0)) * 1.08;
  const X = (v: number) => L + (v / maxV) * iw;

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch">
        <line x1={X(1)} x2={X(1)} y1={T - 2} y2={T + rows.length * rowH} stroke="#c9cfda" strokeWidth={1.2} strokeDasharray="3 3" />
        <text x={X(1)} y={T + rows.length * rowH + 15} fontSize={12} fill="#6b7383" textAnchor="middle">
          1.00× — estimate met exactly
        </text>
        {rows.map((r, ri) => {
          const y = T + ri * rowH + (compact ? 22 : (rowH - 14) / 2), bh = 14;
          const name = (
            <text x={0} y={compact ? y - 8 : y + bh / 2 + 4} fontSize={13.5} fontWeight={600} fill="#2a3140">
              {r.name}
            </text>
          );
          if (r.v == null) {
            return (
              <g key={ri}>
                {name}
                <text x={L} y={y + bh / 2 + 4} fontSize={12.5} fill="#6b7383">
                  no covered jobs
                </text>
              </g>
            );
          }
          const color = r.v >= 1 ? "#1a8a5a" : r.v >= 0.9 ? "#9aa2b2" : "#d0463a";
          return (
            <g key={ri}>
              {name}
              <rect x={L} y={y} width={Math.max(2, X(r.v) - L)} height={bh} rx={5} fill={color} />
              <text x={X(r.v) + 9} y={y + bh / 2 + 4} className="tnum" fontSize={compact ? 11 : 12} fontWeight={700} fill="#2a3140">
                {r.v.toFixed(2) + "×"}
              </text>
              {r.cov && !compact ? (
                <text x={L + iw + 12} y={y + bh / 2 + 4} fontSize={12} fill="#6b7383" className="tnum">
                  {r.cov}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
