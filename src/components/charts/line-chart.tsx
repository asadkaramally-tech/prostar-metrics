"use client";

import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { tipHide, tipShow } from "./tooltip";
import { useContainerWidth } from "./use-container-width";

/* LineChart — a 1:1 React port of the approved mockup chart engine
   (docs/approved-design/mockups/assets/charts.js lineChart). Straight
   polylines on a single axis, horizontal gridlines with right-side labels,
   dotted 1px reference lines whose labels sit on a surface chip drawn ABOVE
   the series strokes, annotations clamped inside the plot and nudged clear
   of refline label bands, x-label collision skipping (first + last always
   kept), optional count columns, and a crosshair + per-series markers wired
   to the shared tooltip. Renders at the container's real pixel width and
   re-renders on resize (useContainerWidth), so glyphs stay ~11px at any
   viewport — never a fixed viewBox scaled down. */

export type LineSeries = {
  name: string;
  vals: (number | null)[];
  color: string;
  width?: number;
  /** Data dash — allowed only where no refline ambiguity exists. */
  dash?: string;
};

export type LineRefline = { v: number; text: string; anchor?: "start" | "end" };

export type LineAnnotation = {
  /** Series index the marker anchors to. */
  s: number;
  i: number;
  /** Multi-line via \n; first line 11.5/600 ink-2, rest 11/500 faint. */
  text: string;
  dy?: number;
  dx?: number;
  anchor?: "start" | "middle" | "end";
};

export type LineChartProps = {
  labels: string[];
  series: LineSeries[];
  yFmt: (v: number) => string;
  ymax: number;
  ymin?: number;
  h?: number;
  ticks?: number;
  reflines?: LineRefline[];
  annotations?: LineAnnotation[];
  /** false = panel above a paired small-multiple; the bottom panel carries the axis. */
  xlabels?: boolean;
  /** Count columns drawn behind the series on the same axis. */
  bars?: { vals: (number | null)[]; color?: string };
  /** Tooltip body for month i (build with tipTitle/tipRow). */
  tip?: (i: number) => string;
  ariaLabel?: string;
  w?: number;
  className?: string;
  style?: CSSProperties;
};

/* Palette resolved from the app tokens (SVG presentation attributes cannot
   carry var()): surface #fff, grid --chart-grid, guide --n300, bar --n150,
   axis text --faint, annotation ink --ink-2. */
const C = {
  surface: "#fff",
  grid: "#eff1f5",
  guide: "#c3cad6",
  bar: "#e4e7ed",
  axis: "#6d7585",
  ink2: "#2a3140",
};

/** Text-width estimator shared by refline labels, x labels and annotations. */
const est = (t: string) => t.length * 6.4;

export function LineChart(props: LineChartProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const guideRef = useRef<SVGLineElement | null>(null);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);

  const W = props.w || measuredW;
  const narrow = W < 720;
  const H = narrow ? Math.min(220, props.h || 300) : props.h || 300;
  const padL = 8;
  const padR = narrow ? 46 : 56;
  const padT = 26;
  const padB = props.xlabels === false ? 10 : 26;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const n = props.labels.length;
  const x = (i: number) => padL + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const ymin = props.ymin ?? 0;
  const ymax = props.ymax > ymin ? props.ymax : ymin + 1;
  const y = (v: number) => padT + ih - ((v - ymin) / (ymax - ymin)) * ih;

  /* Horizontal gridlines + right axis labels. */
  const tickCount = props.ticks || 4;
  const gridlines: ReactNode[] = [];
  for (let t = 0; t <= tickCount; t += 1) {
    const v = ymin + ((ymax - ymin) * t) / tickCount;
    const yy = y(v);
    gridlines.push(
      <g key={t}>
        <line x1={padL} x2={W - padR + 6} y1={yy} y2={yy} stroke={C.grid} strokeWidth={1} />
        <text x={W - padR + 10} y={yy + 4} fontSize={11} fontWeight={500} fill={C.axis} className="tnum">
          {props.yFmt(v)}
        </text>
      </g>,
    );
  }

  /* Count columns behind the series, on the same axis. */
  const bars: ReactNode[] = [];
  if (props.bars) {
    const bw = Math.min(26, (iw / Math.max(n, 1)) * 0.5);
    props.bars.vals.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) return;
      const top = y(v);
      bars.push(
        <rect
          key={i}
          x={x(i) - bw / 2}
          y={top}
          width={bw}
          height={Math.max(padT + ih - top, 0)}
          rx={2}
          fill={props.bars?.color || C.bar}
        />,
      );
    });
  }

  /* Reference lines: dotted 1px `1 3` so a reference never reads as a data
     series. The label is drawn AFTER the series on a surface chip; its box is
     remembered so annotations can dodge it. Narrow mode keeps the fact and
     drops the clause after the em dash. */
  const refBoxes: Array<{ x1: number; x2: number; y: number }> = [];
  const refLines: ReactNode[] = [];
  const refLabels: ReactNode[] = [];
  (props.reflines || []).forEach((r, ri) => {
    const yy = y(r.v);
    const txt = narrow ? r.text.split(" — ")[0] : r.text;
    const ranchor = r.anchor || "end";
    const rx = ranchor === "start" ? padL + 4 : W - padR;
    const rx1 = ranchor === "start" ? rx : rx - est(txt);
    refBoxes.push({ x1: rx1, x2: rx1 + est(txt), y: yy - 6 });
    refLines.push(
      <line key={ri} x1={padL} x2={W - padR + 6} y1={yy} y2={yy} stroke={C.guide} strokeWidth={1} strokeDasharray="1 3" />,
    );
    refLabels.push(
      <g key={ri}>
        <rect x={rx1 - 4} y={yy - 15} width={est(txt) + 8} height={13} rx={3} fill={C.surface} opacity={0.92} />
        <text x={rx} y={yy - 6} fontSize={11} fontWeight={500} fill={C.axis} textAnchor={ranchor}>
          {txt}
        </text>
      </g>,
    );
  });

  /* Series: straight polylines, round join/cap; null values split the line
     into honest segments (no bridging across missing months). */
  const seriesLayers = props.series.map((sr, si) => {
    const segments: string[] = [];
    let run: string[] = [];
    sr.vals.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) {
        if (run.length > 0) segments.push(run.join(" "));
        run = [];
        return;
      }
      run.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
    });
    if (run.length > 0) segments.push(run.join(" "));
    return (
      <g key={si}>
        {segments.map((pts, k) => (
          <polyline
            key={k}
            points={pts}
            fill="none"
            stroke={sr.color}
            strokeWidth={sr.width || 2}
            strokeDasharray={sr.dash}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </g>
    );
  });

  /* X labels — drop any label that would collide at the current width; the
     first and last always survive; the last renders bold ink. */
  const xLabels: ReactNode[] = [];
  if (props.xlabels !== false) {
    const lastI = n - 1;
    const lastLeft = x(lastI) - est(props.labels[lastI] || "");
    let prevRight = -Infinity;
    props.labels.forEach((l, i) => {
      if (l === "") return;
      const anchor = i === lastI ? "end" : i === 0 ? "start" : "middle";
      const left = anchor === "start" ? x(i) : anchor === "end" ? x(i) - est(l) : x(i) - est(l) / 2;
      if (i !== 0 && i !== lastI && (left + est(l) > lastLeft - 14 || left < prevRight + 14)) return;
      prevRight = left + est(l);
      xLabels.push(
        <text
          key={i}
          x={x(i)}
          y={H - 8}
          fontSize={11}
          fontWeight={i === lastI ? 700 : 500}
          fill={i === lastI ? C.ink2 : C.axis}
          textAnchor={anchor}
        >
          {l}
        </text>,
      );
    });
  }

  /* Annotations — 9px series-colored marker on a 2px surface ring; text
     clamped inside the plot for every anchor, then nudged clear of any
     refline label band so no two text spans can overprint. */
  const annotations = (props.annotations || []).map((a, ai) => {
    const sr = props.series[a.s];
    if (!sr) return null;
    const v = sr.vals[a.i];
    if (v == null || !Number.isFinite(v)) return null;
    const ax = x(a.i);
    const ay = y(v);
    const lines = a.text.split("\n");
    const tw = Math.max(...lines.map((t) => t.length)) * 6.6;
    const anchor = a.anchor || "middle";
    let tx = ax + (a.dx || 0);
    const capR = W - padR + 2;
    if (anchor === "middle") tx = Math.min(Math.max(tx, tw / 2 + 4), capR - tw / 2);
    else if (anchor === "end") tx = Math.min(Math.max(tx, tw + 4), capR);
    else tx = Math.min(Math.max(tx, 4), capR - tw);
    let ty = ay + (a.dy ?? -12);
    ty = Math.min(Math.max(ty, 14), H - padB - 4 - (lines.length - 1) * 13);
    const sx1 = anchor === "middle" ? tx - tw / 2 : anchor === "end" ? tx - tw : tx;
    const sx2 = sx1 + tw;
    for (let guard = 0; guard < 3; guard += 1) {
      const hit = refBoxes.find(
        (b) => sx2 > b.x1 - 8 && sx1 < b.x2 + 8 && lines.some((_, k) => Math.abs(ty + k * 13 - b.y) < 12),
      );
      if (!hit) break;
      const above = hit.y - 12 - (lines.length - 1) * 13;
      ty = above >= 14 ? above : hit.y + 15;
    }
    return (
      <g key={ai}>
        <circle cx={ax} cy={ay} r={6.5} fill={C.surface} />
        <circle cx={ax} cy={ay} r={4.5} fill={sr.color} />
        {lines.map((ln, k) => (
          <text
            key={k}
            x={tx}
            y={ty + k * 13}
            fontSize={k === 0 ? 11.5 : 11}
            fontWeight={k === 0 ? 600 : 500}
            fill={k === 0 ? C.ink2 : C.axis}
            textAnchor={anchor}
            className="tnum"
          >
            {ln}
          </text>
        ))}
      </g>
    );
  });

  /* Hover layer: crosshair + per-series markers, tooltip via the shared
     white tooltip (values never live tooltip-only — they are also in the
     adjacent table/labels). */
  const onPointerMove = (e: ReactPointerEvent<SVGRectElement>) => {
    if (!props.tip) return;
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / iw) * (n - 1))));
    const xx = x(i);
    const guide = guideRef.current;
    if (guide) {
      guide.setAttribute("x1", String(xx));
      guide.setAttribute("x2", String(xx));
      guide.setAttribute("opacity", "1");
    }
    props.series.forEach((sr, si) => {
      const dot = dotRefs.current[si];
      const v = sr.vals[i];
      if (!dot) return;
      if (v == null || !Number.isFinite(v)) {
        dot.setAttribute("opacity", "0");
        return;
      }
      dot.setAttribute("cx", String(xx));
      dot.setAttribute("cy", String(y(v)));
      dot.setAttribute("opacity", "1");
    });
    tipShow(props.tip(i), e.clientX, e.clientY);
  };
  const onPointerLeave = () => {
    guideRef.current?.setAttribute("opacity", "0");
    dotRefs.current.forEach((d) => d?.setAttribute("opacity", "0"));
    tipHide();
  };

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="ch" role="img" aria-label={props.ariaLabel || "chart"}>
        {gridlines}
        {bars}
        {refLines}
        {seriesLayers}
        {refLabels}
        {xLabels}
        {annotations}
        <line ref={guideRef} x1={0} x2={0} y1={padT} y2={padT + ih} stroke={C.guide} strokeWidth={1} opacity={0} />
        {props.series.map((sr, si) => (
          <circle
            key={si}
            ref={(el) => {
              dotRefs.current[si] = el;
            }}
            r={4.5}
            fill={sr.color}
            stroke={C.surface}
            strokeWidth={2}
            opacity={0}
          />
        ))}
        <rect
          x={padL}
          y={padT - 6}
          width={iw}
          height={ih + 12}
          fill="transparent"
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
        />
      </svg>
    </div>
  );
}
