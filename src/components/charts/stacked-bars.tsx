"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { fmt, type ValueFormatter } from "./fmt";
import { autoStride, niceTicks } from "./geometry";
import { tipHide, tipRow, tipShow, tipTitle, tipTrack } from "./tooltip";
import { useContainerWidth } from "./use-container-width";

/* Stacked bars (or single series): printed totals above every stack,
   selected-period band, tooltip with per-series breakdown + extras —
   a 1:1 port of kit.js stackedBars. */

export type StackedBarSeries = { name: string; color: string; values: number[] };

export type StackedBarsProps = {
  labels: string[];
  series: StackedBarSeries[];
  band?: number | null;
  yFmt?: ValueFormatter;
  totalFmt?: ValueFormatter;
  valFmt?: ValueFormatter;
  tipLabel?: (i: number) => string;
  tipExtra?: (i: number) => string;
  ticks?: number;
  w?: number;
  h?: number;
  className?: string;
  style?: CSSProperties;
};

export function StackedBars(props: StackedBarsProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const W = props.w || measuredW, H = props.h || 300;
  const L = 10, R = 52, T = 26, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const nx = props.labels.length;
  const totals = props.labels.map((_, i) => props.series.reduce((s, sr) => s + (sr.values[i] || 0), 0));
  const { ticks, hi } = niceTicks(0, Math.max(...totals), props.ticks || 4);
  const Y = (v: number) => T + ih - (v / hi) * ih;
  const slot = iw / nx, bw = Math.min(38, slot * 0.62);
  const stride = autoStride(nx, iw);

  const enter = (i: number, lb: string) => (e: ReactPointerEvent<SVGRectElement>) => {
    let html = tipTitle(props.tipLabel ? props.tipLabel(i) : lb);
    [...props.series].reverse().forEach((sr) => {
      html += tipRow(sr.color, sr.name, (props.valFmt || fmt.n)(sr.values[i] || 0));
    });
    if (props.tipExtra) html += props.tipExtra(i);
    tipShow(html, e.clientX, e.clientY);
  };
  const move = (e: ReactPointerEvent<SVGRectElement>) => tipTrack(e.clientX, e.clientY);

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch">
        {props.band != null ? (
          <rect
            x={L + slot * props.band + slot * 0.08}
            y={T - 6}
            width={slot * 0.84}
            height={ih + 10}
            rx={7}
            fill="rgba(91,99,211,.055)"
          />
        ) : null}
        {ticks.map((v) => (
          <g key={`t${v}`}>
            <line x1={L} x2={L + iw} y1={Y(v)} y2={Y(v)} stroke="#eff1f5" />
            <text x={W - R + 10} y={Y(v) + 3.5} fontSize={12} fill="#6b7383" className="tnum">
              {(props.yFmt || fmt.n)(v)}
            </text>
          </g>
        ))}
        {props.labels.map((lb, i) => {
          const isLast = i === nx - 1;
          const cx = L + slot * i + slot / 2;
          let run = 0;
          const segs = props.series.map((sr, sri) => {
            const v = sr.values[i] || 0;
            if (v <= 0) return null;
            const y0 = Y(run), y1 = Y(run + v);
            run += v;
            return <rect key={sri} x={cx - bw / 2} y={y1} width={bw} height={Math.max(1.5, y0 - y1)} rx={0} fill={sr.color} />;
          });
          return (
            <g key={i}>
              {segs}
              {/* rounded top on the stack */}
              <rect
                x={cx - bw / 2}
                y={Y(run)}
                width={bw}
                height={Math.min(6, Y(0) - Y(run))}
                rx={3}
                fill={props.series[props.series.length - 1].color}
              />
              <text
                x={cx}
                y={Y(run) - 7}
                fontSize={11.5}
                fontWeight={700}
                fill={props.band === i ? "#101422" : "#5c6474"}
                className="tnum"
                textAnchor="middle"
              >
                {(props.totalFmt || fmt.n)(totals[i])}
              </text>
              {isLast || (i % stride === 0 && nx - 1 - i >= stride * 0.7) ? (
                <text
                  x={cx}
                  y={H - 9}
                  fontSize={12}
                  fill={props.band === i ? "#101422" : "#6b7383"}
                  fontWeight={props.band === i ? 700 : 400}
                  textAnchor="middle"
                >
                  {lb}
                </text>
              ) : null}
              <rect
                x={L + slot * i}
                y={T - 6}
                width={slot}
                height={ih + 12}
                fill="transparent"
                onPointerEnter={enter(i, lb)}
                onPointerMove={move}
                onPointerLeave={tipHide}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
