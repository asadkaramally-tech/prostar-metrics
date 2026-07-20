"use client";

import { useId, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { fmt } from "./fmt";
import { tipHide, tipRow, tipShow, tipTitle } from "./tooltip";
import { useContainerWidth } from "./use-container-width";

/* Waterfall v2: glow on the net bar, refined dashed connectors, hover —
   a 1:1 port of kit.js waterfall. Checkpoint bars: "base" anchors the run,
   "minus" subtracts from it, "net" re-anchors at its own value. */

export type WaterfallStep = { label: string; value: number; kind?: "base" | "minus" | "net" };

export type WaterfallProps = {
  steps: WaterfallStep[];
  w?: number;
  h?: number;
  className?: string;
  style?: CSSProperties;
};

export function Waterfall(props: WaterfallProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const W = props.w || measuredW || 520, H = props.h || 300;
  const L = 12, R = 12, T = 34, B = 32;
  const iw = W - L - R, ih = H - T - B;
  const glowId = `gl${uid}`;
  const steps = props.steps;
  const max = steps[0].value;
  const Y = (v: number) => T + ih - (v / max) * ih;
  const n = steps.length, slot = iw / n, bw = Math.min(64, slot * 0.6);

  const enter = (s: WaterfallStep, fill: string) => (e: ReactPointerEvent<SVGRectElement>) =>
    tipShow(
      tipTitle(s.label) +
        tipRow(fill, s.kind === "minus" ? "Cost" : "Amount", (s.kind === "minus" ? "−" : "") + fmt.moneyFull(s.value)),
      e.clientX,
      e.clientY,
    );

  /* Running-total geometry, resolved in one pass before rendering. */
  const geo: { top: number; hgt: number; fill: string; runY: number }[] = [];
  {
    let run = 0;
    for (const s of steps) {
      let y0: number, y1: number;
      if (s.kind === "base") { y0 = Y(s.value); y1 = Y(0); run = s.value; }
      else if (s.kind === "minus") { y0 = Y(run); y1 = Y(run - s.value); run -= s.value; }
      else { y0 = Y(s.value); y1 = Y(0); }
      const fill = s.kind === "base" ? "#101422" : s.kind === "minus" ? "#c9cfda" : "#5b63d3";
      geo.push({ top: Math.min(y0, y1), hgt: Math.max(2, Math.abs(y1 - y0)), fill, runY: Y(run) });
    }
  }
  const layers = steps.map((s, i) => {
    const cx = L + slot * i + slot / 2;
    const { top, hgt, fill, runY } = geo[i];
    return (
      <g key={i}>
        <rect
          x={cx - bw / 2}
          y={top}
          width={bw}
          height={hgt}
          rx={5}
          fill={fill}
          filter={s.kind === "net" ? `url(#${glowId})` : undefined}
          onPointerEnter={enter(s, fill)}
          onPointerLeave={tipHide}
        />
        {i < n - 1 ? (
          <line
            x1={cx + bw / 2 + 3}
            x2={L + slot * (i + 1) + slot / 2 - bw / 2 - 3}
            y1={runY}
            y2={runY}
            stroke="#d3dae3"
            strokeWidth={1.2}
            strokeDasharray="2 3"
          />
        ) : null}
        <text
          x={cx}
          y={top - 9}
          fontSize={12.5}
          fontWeight={700}
          fill={s.kind === "minus" ? "#5c6474" : "#101422"}
          className="tnum"
          textAnchor="middle"
        >
          {(s.kind === "minus" ? "−" : "") + fmt.money(s.value)}
        </text>
        <text x={cx} y={H - 9} fontSize={12} fill="#6b7383" textAnchor="middle">
          {s.label}
        </text>
      </g>
    );
  });

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch">
        <defs>
          <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx={0} dy={6} stdDeviation={7} floodColor="#5b63d3" floodOpacity={0.35} />
          </filter>
        </defs>
        <line x1={L} x2={L + iw} y1={Y(0)} y2={Y(0)} stroke="#e2e6ec" strokeWidth={1.2} />
        {layers}
      </svg>
    </div>
  );
}
