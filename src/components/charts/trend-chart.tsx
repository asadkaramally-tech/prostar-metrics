"use client";

import { useId, useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { fmt, type ValueFormatter } from "./fmt";
import {
  annotationAnchor,
  autoStride,
  axis2Ticks,
  bandLabelAnchor,
  monotonePath,
  niceTicks,
  shouldDrawXLabel,
  type Point,
} from "./geometry";
import { tipHide, tipRow, tipShow, tipTitle } from "./tooltip";
import { useContainerWidth } from "./use-container-width";

/* Trend chart v2 — a 1:1 port of kit.js trendChart. Horizontal-only grid on
   nice round ticks, right-side axis labels, monotone lines, accent glow on
   the star series, selected-month highlight band, peak annotations and a
   guide-line tooltip. 1 viewBox unit ≈ 1px at the measured width. */

export type TrendSeries = {
  name: string;
  color: string;
  values: (number | null)[];
  /** Featured series: 2.8px stroke, drop-shadow glow, bigger end dot, end label. */
  star?: boolean;
  /** stroke-dasharray for context lines (e.g. "3 4"). Dashed series draw no end dot. */
  dash?: string;
  /** Gradient area fill under the line. */
  fill?: boolean;
  /** Secondary axis (left labels, tick-count aligned with the primary axis). */
  axis?: 1 | 2;
  /** Indices ≤ reprTo render dashed (representative), the rest solid (verified). */
  reprTo?: number;
  /** Point indices to mark with small dots. */
  dots?: number[];
  /** Set false to suppress the star series' end label. */
  endLabel?: boolean;
  /** Override the end-label text. */
  endText?: string;
  /** End-label vertical nudge (default −10). */
  endDy?: number;
  /** Tooltip value formatter for this series. */
  tipFmt?: ValueFormatter;
};

export type TrendAnnotation = {
  i: number;
  text: string;
  sub?: string;
  /** Series index to anchor to (default: the star series). */
  s?: number;
  /** dy ≥ 0 places the callout below the point. */
  dy?: number;
};

export type TrendChartProps = {
  labels: string[];
  series: TrendSeries[];
  yFmt?: ValueFormatter;
  y2Fmt?: ValueFormatter;
  w?: number;
  h?: number;
  yMax?: number;
  yMin?: number;
  y2Max?: number;
  ticks?: number;
  everyX?: number;
  /** Label index to highlight with the selected-period band. */
  band?: number | null;
  /** Anchored label above the band (or right-aligned when band is null). */
  bandLabel?: string;
  annotations?: TrendAnnotation[];
  tipLabel?: (i: number) => string;
  /** Extra tooltip rows (HTML string, built with tipRow). */
  tipExtra?: (i: number) => string;
  className?: string;
  style?: CSSProperties;
};

export function TrendChart(props: TrendChartProps) {
  const [containerRef, measuredW] = useContainerWidth<HTMLDivElement>(props.w);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const guideRef = useRef<SVGLineElement | null>(null);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);

  const W = props.w || measuredW;
  const H = props.h || 260;
  const hasA2 = props.series.some((s) => s.axis === 2);
  const hasAnn = W >= 520 && (props.annotations || []).length > 0;
  const L = hasA2 ? 56 : 10, R = 64, T = hasAnn ? 46 : 22, B = 30;
  const iw = W - L - R, ih = H - T - B;

  const a1 = props.series.filter((s) => s.axis !== 2);
  const a2 = props.series.filter((s) => s.axis === 2);
  const vals = (ser: TrendSeries[]) => ser.flatMap((s) => s.values).filter(isFiniteNumber);
  const base = a1.length ? a1 : a2;
  const all = vals(base);
  let dataMax = props.yMax != null ? props.yMax : all.length ? Math.max(...all) : 1;
  const dataMin = props.yMin != null ? props.yMin : all.length ? Math.min(0, Math.min(...all)) : 0;
  if (dataMax <= dataMin) dataMax = dataMin + 1;
  const { ticks, lo, hi } = niceTicks(dataMin, dataMax, props.ticks || 4);
  let lo2 = 0, hi2 = 1, ticks2: number[] = [];
  if (hasA2 && a1.length) {
    const all2 = vals(a2);
    const max2Raw = props.y2Max != null ? props.y2Max : all2.length ? Math.max(...all2) : 1;
    const max2 = max2Raw > 0 ? max2Raw : 1;
    ({ lo2, hi2, ticks2 } = axis2Ticks(max2, ticks.length));
  }
  const nx = props.labels.length;
  const X = (i: number) => L + (nx === 1 ? iw / 2 : (i / (nx - 1)) * iw);
  const Y = (v: number) => T + ih - ((v - lo) / (hi - lo)) * ih;
  const Y2 = (v: number) => T + ih - ((v - lo2) / (hi2 - lo2)) * ih;
  const yFor = (s: TrendSeries) => (s.axis === 2 && a1.length ? Y2 : Y);

  const ptsBySeries = useMemo(
    () => props.series.map((s) => s.values.map((v, i): Point | null => (!isFiniteNumber(v) ? null : [X(i), yFor(s)(v)]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.series, props.labels, W, H, lo, hi, lo2, hi2, hasAnn, hasA2],
  );

  const glowId = `gl${uid}`;
  const starColor = props.series.find((s) => s.star)?.color || "#5b63d3";
  const everyX = Math.max(props.everyX || 1, autoStride(nx, iw));

  /* Selected-period band geometry. */
  let bandRect: ReactNode = null;
  if (props.band != null) {
    const slot = nx > 1 ? iw / (nx - 1) : iw;
    const bx = Math.max(L, X(props.band) - slot / 2);
    const bw = Math.min(slot, L + iw - bx);
    bandRect = <rect x={bx} y={T - 6} width={bw} height={ih + 10} rx={7} fill="rgba(91,99,211,.055)" />;
  }
  let bandLabelText: ReactNode = null;
  if (props.bandLabel) {
    const bx0 = props.band != null ? X(props.band) : L + iw - 2;
    const anch = bandLabelAnchor(bx0, L, iw);
    bandLabelText = (
      <text x={bx0} y={14} fontSize={12.5} fontWeight={700} fill="#5b63d3" textAnchor={anch} className="tnum">
        {props.bandLabel}
      </text>
    );
  }

  /* Series layers (area fill, stroke incl. repr clips, dots, end marks). */
  const defs: ReactNode[] = [];
  const seriesLayers = props.series.map((s, si) => {
    const pts = ptsBySeries[si];
    const draw = pts.filter((p): p is Point => p != null);
    if (!draw.length) return null;
    const layer: ReactNode[] = [];
    if (s.fill) {
      const gid = `g${uid}f${si}`;
      defs.push(
        <linearGradient key={gid} id={gid} x1={0} y1={0} x2={0} y2={1}>
          <stop offset={0} stopColor={s.color} stopOpacity={0.16} />
          <stop offset={1} stopColor={s.color} stopOpacity={0} />
        </linearGradient>,
      );
      const area =
        monotonePath(draw) +
        `L${draw[draw.length - 1][0].toFixed(2)},${(T + ih).toFixed(2)}L${draw[0][0].toFixed(2)},${(T + ih).toFixed(2)}Z`;
      layer.push(<path key="area" d={area} fill={`url(#${gid})`} />);
    }
    const strokeProps = {
      fill: "none",
      stroke: s.color,
      strokeWidth: s.star ? 2.8 : 1.9,
      strokeLinecap: "round" as const,
      ...(s.dash ? { strokeDasharray: s.dash } : {}),
      ...(s.star ? { filter: `url(#${glowId})` } : {}),
    };
    if (s.reprTo != null && s.reprTo > 0) {
      /* Representative span drawn dashed, verified span solid — one curve, two clips. */
      const cut = X(Math.min(s.reprTo, s.values.length - 1));
      const c1 = `c${uid}a${si}`, c2 = `c${uid}b${si}`;
      defs.push(
        <clipPath key={c1} id={c1}>
          <rect x={0} y={0} width={cut} height={H} />
        </clipPath>,
        <clipPath key={c2} id={c2}>
          <rect x={cut} y={0} width={W - cut} height={H} />
        </clipPath>,
      );
      layer.push(
        <path key="repr" d={monotonePath(draw)} {...strokeProps} strokeDasharray="4 4.5" clipPath={`url(#${c1})`} />,
        <path key="verified" d={monotonePath(draw)} {...strokeProps} clipPath={`url(#${c2})`} />,
      );
    } else {
      layer.push(<path key="line" d={monotonePath(draw)} {...strokeProps} />);
    }
    for (const di of s.dots || []) {
      const p = pts[di];
      if (p) layer.push(<circle key={`dot${di}`} cx={p[0]} cy={p[1]} r={2.6} fill="#fff" stroke={s.color} strokeWidth={1.8} />);
    }
    const last = draw[draw.length - 1];
    if (!s.dash) {
      layer.push(
        <circle key="end" cx={last[0]} cy={last[1]} r={s.star ? 3.6 : 2.4} fill="#fff" stroke={s.color} strokeWidth={2} />,
      );
    }
    if (s.star && s.endLabel !== false) {
      const ty = Math.min(Math.max(last[1] + (s.endDy ?? -10), T + 8), T + ih - 4);
      const lastVal = s.values[s.values.length - 1];
      layer.push(
        <text key="endlab" x={last[0] - 8} y={ty} fontSize={12.5} fontWeight={700} fill={s.color} className="tnum" textAnchor="end">
          {s.endText != null ? s.endText : (props.yFmt || fmt.money)(lastVal as number)}
        </text>,
      );
    }
    return <g key={si}>{layer}</g>;
  });

  /* Annotations — suppressed on narrow charts; tooltips carry the values there. */
  const annotations = (W >= 520 ? props.annotations || [] : []).map((a, ai) => {
    const star = a.s != null ? props.series[a.s] : props.series.find((s) => s.star) || props.series[0];
    if (!star) return null;
    const v = star.values[a.i];
    if (!isFiniteNumber(v)) return null;
    const px = X(a.i), py = yFor(star)(v);
    const above = a.dy == null || a.dy < 0;
    const ly = above ? py - 30 : py + 34;
    const anchor = annotationAnchor(px, L, iw);
    return (
      <g key={ai}>
        <line
          x1={px} x2={px}
          y1={above ? ly + 6 : py + 6} y2={above ? py - 7 : ly - 14}
          stroke="#c9cfda" strokeWidth={1} strokeDasharray="2 3"
        />
        <text x={px} y={ly - 6} fontSize={12} fontWeight={700} fill="#2a3140" textAnchor={anchor} className="tnum">
          {a.text}
        </text>
        {a.sub ? (
          <text x={px} y={ly + 5} fontSize={11.5} fill="#6b7383" textAnchor={anchor}>
            {a.sub}
          </text>
        ) : null}
      </g>
    );
  });

  /* Hover: guide line + dots + tooltip — imperative like the kit so pointer
     tracking never re-renders the chart. */
  const onPointerMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (W / r.width);
    const i = Math.max(0, Math.min(nx - 1, Math.round(((sx - L) / iw) * (nx - 1))));
    const guide = guideRef.current;
    if (guide) {
      guide.setAttribute("x1", String(X(i)));
      guide.setAttribute("x2", String(X(i)));
      guide.setAttribute("opacity", "1");
    }
    let html = tipTitle(props.tipLabel ? props.tipLabel(i) : props.labels[i]);
    props.series.forEach((s, si) => {
      const v = s.values[i];
      const p = ptsBySeries[si][i];
      const dot = dotRefs.current[si];
      if (v == null || !p) {
        dot?.setAttribute("opacity", "0");
        return;
      }
      if (dot) {
        dot.setAttribute("cx", String(p[0]));
        dot.setAttribute("cy", String(p[1]));
        dot.setAttribute("opacity", "1");
      }
      html += tipRow(s.color, s.name, (s.tipFmt || props.yFmt || fmt.money)(v));
    });
    if (props.tipExtra) html += props.tipExtra(i);
    tipShow(html, e.clientX, e.clientY);
  };
  const onPointerLeave = () => {
    guideRef.current?.setAttribute("opacity", "0");
    dotRefs.current.forEach((d) => d?.setAttribute("opacity", "0"));
    tipHide();
  };

  return (
    <div ref={containerRef} className={props.className} style={props.style}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="ch">
        <defs>
          <filter id={glowId} x="-20%" y="-60%" width="140%" height="220%">
            <feDropShadow dx={0} dy={2.5} stdDeviation={4} floodColor={starColor} floodOpacity={0.3} />
          </filter>
          {defs}
        </defs>
        {bandRect}
        {bandLabelText}
        {ticks.map((v) => (
          <g key={`t${v}`}>
            <line x1={L} x2={L + iw} y1={Y(v)} y2={Y(v)} stroke="#eff1f5" strokeWidth={1} />
            <text x={W - R + 10} y={Y(v) + 3.5} fontSize={12} fill="#6b7383" className="tnum">
              {((a1.length ? props.yFmt : props.y2Fmt || props.yFmt) || fmt.money)(v)}
            </text>
          </g>
        ))}
        {hasA2 && a1.length
          ? ticks2.map((v) => (
              <text key={`t2${v}`} x={L - 10} y={Y2(v) + 3.5} fontSize={12} fill="#6b7383" className="tnum" textAnchor="end">
                {(props.y2Fmt || ((x: number) => x))(v)}
              </text>
            ))
          : null}
        {props.labels.map((lb, i) =>
          shouldDrawXLabel({ i, nx, everyX, X, band: props.band }) ? (
            <text
              key={`x${i}`}
              x={X(i)}
              y={H - 9}
              fontSize={12}
              fill={props.band === i ? "#101422" : "#6b7383"}
              fontWeight={props.band === i ? 700 : 400}
              textAnchor={i === 0 ? "start" : "middle"}
            >
              {lb}
            </text>
          ) : null,
        )}
        {seriesLayers}
        {annotations}
        <line ref={guideRef} x1={0} x2={0} y1={T} y2={T + ih} stroke="#d3dae3" strokeWidth={1} opacity={0} />
        {props.series.map((s, si) => (
          <circle
            key={`hd${si}`}
            ref={(el) => {
              dotRefs.current[si] = el;
            }}
            r={3.2}
            fill="#fff"
            stroke={s.color}
            strokeWidth={2}
            opacity={0}
          />
        ))}
        <rect
          x={L}
          y={T - 6}
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

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
