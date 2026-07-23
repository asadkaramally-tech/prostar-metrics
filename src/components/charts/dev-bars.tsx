"use client";

import type { CSSProperties, KeyboardEvent } from "react";
import type { ValueFormatter } from "./fmt";
import { devBarsDomain } from "./geometry";
import { useContainerWidth } from "./use-container-width";

/* Deviation bars anchored at a reference (Few/Cleveland: encode the
   difference, not two lengths) — a 1:1 port of kit.js devBars. Bars extend
   left (below ref, red) or right (above, green). */

export type DevBarRow = { name: string; v: number | null; cov?: string; id?: string; ariaLabel?: string };

export type DevBarsProps = {
  rows: DevBarRow[];
  /** Reference value the bars deviate from (default 0; kit option `ref`). */
  refValue?: number;
  min?: number;
  max?: number;
  pad?: number;
  fmt?: ValueFormatter;
  labelW?: number;
  refLabel?: string;
  pos?: string;
  neg?: string;
  w?: number;
  className?: string;
  style?: CSSProperties;
  onRowClick?: (row: DevBarRow, index: number) => void;
};

export function DevBars(props: DevBarsProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const W = props.w || measuredW;
  const rows = props.rows;
  const compact = W < 520;
  const rowH = compact ? 46 : 34;
  const L = compact ? 0 : props.labelW || 126;
  const R = compact ? 68 : 128;
  const T = 8, B = 24;
  const H = T + rows.length * rowH + B;
  const iw = W - L - R;
  const { ref, lo, hi } = devBarsDomain(rows, { ref: props.refValue, min: props.min, max: props.max, pad: props.pad });
  const X = (v: number) => L + ((v - lo) / (hi - lo)) * iw;
  const f = props.fmt || ((v: number) => v.toFixed(2));

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch">
        <line x1={X(ref)} x2={X(ref)} y1={T - 2} y2={T + rows.length * rowH} stroke="#c9cfda" strokeWidth={1.2} />
        <text x={X(ref)} y={T + rows.length * rowH + 15} fontSize={12} fill="#6b7383" textAnchor="middle">
          {props.refLabel || String(ref)}
        </text>
        {rows.map((r, ri) => {
          const interactive = typeof props.onRowClick === "function";
          const activate = () => props.onRowClick?.(r, ri);
          const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
            if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            activate();
          };
          const y = T + ri * rowH + (compact ? 22 : (rowH - 14) / 2), bh = 14;
          const name = (
            <text
              x={0}
              y={compact ? y - 7 : y + bh / 2 + 4}
              fontSize={13.5}
              fontWeight={600}
              fill="#2a3140"
              stroke="#fff"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {r.name}
            </text>
          );
          if (r.v == null) {
            return (
              <g
                key={r.id ?? ri}
                role={interactive ? "button" : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={interactive ? r.ariaLabel ?? `${r.name}: no covered jobs` : undefined}
                onClick={interactive ? activate : undefined}
                onKeyDown={onKeyDown}
                style={interactive ? { cursor: "pointer" } : undefined}
              >
                {interactive ? <rect x={0} y={T + ri * rowH} width={W} height={rowH} fill="transparent" /> : null}
                {name}
                <text x={X(ref) + 9} y={y + bh / 2 + 4} fontSize={12.5} fill="#6b7383">
                  no covered jobs
                </text>
              </g>
            );
          }
          const up = r.v >= ref;
          const x0 = Math.min(X(ref), X(r.v)), w = Math.max(2, Math.abs(X(r.v) - X(ref)));
          return (
            <g
              key={r.id ?? ri}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? r.ariaLabel ?? `${r.name}: ${f(r.v)}` : undefined}
              onClick={interactive ? activate : undefined}
              onKeyDown={onKeyDown}
              style={interactive ? { cursor: "pointer" } : undefined}
            >
              {interactive ? <rect x={0} y={T + ri * rowH} width={W} height={rowH} fill="transparent" /> : null}
              {name}
              <rect x={x0} y={y} width={w} height={bh} rx={4} fill={up ? props.pos || "#1a8a5a" : props.neg || "#d0463a"} />
              <text
                x={up ? X(r.v) + 9 : X(r.v) - 9}
                y={y + bh / 2 + 4}
                className="tnum"
                fontSize={compact ? 11 : 12}
                fontWeight={700}
                fill="#2a3140"
                stroke="#fff"
                strokeWidth={3}
                paintOrder="stroke"
                textAnchor={up ? "start" : "end"}
              >
                {f(r.v) + (r.cov && !compact ? ` · ${r.cov}` : "")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
