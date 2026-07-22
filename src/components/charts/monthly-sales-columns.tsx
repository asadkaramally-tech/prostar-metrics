"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { fmt } from "./fmt";
import { tipHide, tipRow, tipShow, tipTitle, tipTrack } from "./tooltip";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;
const DESKTOP_FALLBACK_WIDTH = 960;

/**
 * Charts must not take a mobile branch during their initial desktop render.
 * The shared chart hook intentionally falls back to 560px; this visual has a
 * desktop-first layout, so its isolated measuring hook falls back to 960px
 * during server rendering and measures synchronously before browser paint.
 */
function useMonthlySalesWidth(fixedWidth?: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useIsoLayoutEffect(() => {
    if (fixedWidth) return;
    const node = ref.current;
    if (!node) return;
    const measure = () => setMeasured(node.clientWidth || null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [fixedWidth]);
  return [ref, fixedWidth || measured || DESKTOP_FALLBACK_WIDTH] as const;
}

/**
 * A deliberately single-unit monthly chart. `sales` is extended sell ex-tax;
 * do not pass quantities or a second series here. A null sales value is not a
 * zero: it represents a missing/failed month and is rendered as a coverage
 * gap instead of a column.
 */
export type MonthlySalesPoint = {
  periodStart: string;
  sales: number | null;
  status: "complete" | "failed" | "missing";
  /** True only for the currently in-progress month. */
  partial?: boolean;
  elapsedDays?: number;
  daysInMonth?: number;
  /** Optional comparable period, e.g. "July 2025, day 18". */
  comparatorLabel?: string;
  comparatorSales?: number | null;
};

export type MonthlySalesColumnsProps = {
  /** Caller owns the range: pass the desired 12, 24, or all-history points. */
  points: MonthlySalesPoint[];
  selectedPeriodStart: string;
  onSelectPeriod: (periodStart: string) => void;
  ariaLabel?: string;
  /** Useful for deterministic visual tests; normal rendering measures its container. */
  width?: number;
  className?: string;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function periodParts(periodStart: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})/.exec(periodStart);
  if (!match) return { year: 0, month: 0 };
  return { year: Number(match[1]), month: Math.max(1, Math.min(12, Number(match[2]))) };
}

export function monthlySalesMonthName(periodStart: string): string {
  const { year, month } = periodParts(periodStart);
  return year > 0 ? `${MONTHS[month - 1]} ${year}` : periodStart;
}

export function monthlySalesAxisLabel(periodStart: string, includeYear = false): string {
  const { year, month } = periodParts(periodStart);
  if (year <= 0) return periodStart;
  return includeYear || month === 1
    ? `${SHORT_MONTHS[month - 1]} ’${String(year).slice(-2)}`
    : SHORT_MONTHS[month - 1];
}

export function monthlySalesStatusText(point: MonthlySalesPoint): string {
  if (point.status === "missing") return "No completed data";
  if (point.status === "failed") return "Data walk failed";
  if (point.sales == null || !Number.isFinite(point.sales)) return "No completed data";
  if (point.partial) {
    const day = point.elapsedDays ?? 0;
    const days = point.daysInMonth ?? 0;
    return `${fmt.moneyFull(point.sales)} month to date${day > 0 && days > 0 ? ` (day ${day} of ${days})` : ""}`;
  }
  return `${fmt.moneyFull(point.sales)} full month`;
}

/** Exact name supplied to every visible and keyboard-focusable month target. */
export function monthlySalesTargetLabel(point: MonthlySalesPoint, selected: boolean): string {
  const comparison = point.comparatorLabel
    ? `, ${point.comparatorLabel.trimStart().toLowerCase().startsWith("vs ") ? point.comparatorLabel : `compared with ${point.comparatorLabel}`}: ${point.comparatorSales != null && Number.isFinite(point.comparatorSales)
      ? fmt.moneyFull(point.comparatorSales)
      : "no completed data"}`
    : "";
  return `Select ${monthlySalesMonthName(point.periodStart)}, ${monthlySalesStatusText(point)}${selected ? ", selected" : ""}${comparison}`;
}

/** Roving focus math is pure so the keyboard contract is easy to pin in tests. */
export function nextMonthlySalesFocus(index: number, key: string, length: number): number {
  if (length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return Math.min(length - 1, index + 1);
  if (key === "ArrowLeft" || key === "ArrowUp") return Math.max(0, index - 1);
  return index;
}

export function niceMonthlySalesAxisMax(values: Array<number | null>): number {
  const max = Math.max(0, ...values.filter((value): value is number => value != null && Number.isFinite(value)));
  if (max <= 0) return 1;
  const targetStep = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const multiplier = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= targetStep) ?? 10;
  return multiplier * magnitude * 4;
}

function pointHasSales(point: MonthlySalesPoint) {
  return point.status === "complete" && point.sales != null && Number.isFinite(point.sales);
}

function visibleAxisLabels(points: MonthlySalesPoint[], selectedPeriodStart: string, slot: number) {
  const selected = points.findIndex((point) => point.periodStart === selectedPeriodStart);
  const prioritized = [selected, 0, points.length - 1]
    .filter((index, position, list) => index >= 0 && list.indexOf(index) === position);
  const january = points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => periodParts(point.periodStart).month === 1)
    .map(({ index }) => index);
  const retained: number[] = [];
  // Selection is first priority. If it sits beside January or an endpoint,
  // retain the column and its label while the year separator still carries
  // the temporal boundary; do not overprint two labels.
  for (const index of [...prioritized, ...january]) {
    if (retained.some((other) => Math.abs(other - index) * slot < 48)) continue;
    retained.push(index);
  }
  return new Set(retained);
}

function salesTooltip(point: MonthlySalesPoint): string {
  const status = monthlySalesStatusText(point);
  let html = tipTitle(monthlySalesMonthName(point.periodStart));
  if (pointHasSales(point)) html += tipRow("#5b63d3", "Material sales", status);
  else html += tipRow(point.status === "failed" ? "#d0463a" : "#9aa2b2", "Coverage", status);
  if (point.comparatorLabel) {
    html += tipRow("#c3cad6", point.comparatorLabel,
      point.comparatorSales != null && Number.isFinite(point.comparatorSales) ? fmt.moneyFull(point.comparatorSales) : "No completed data");
  }
  return html;
}

/**
 * A responsive, accessible column chart for monthly material sales. The
 * compact disclosure below the visual is intentional: values remain usable
 * without hover, color perception, or a pointer device.
 */
export function MonthlySalesColumns({
  points,
  selectedPeriodStart,
  onSelectPeriod,
  ariaLabel = "Monthly material sales",
  width,
  className,
}: MonthlySalesColumnsProps) {
  const [containerRef, measuredWidth] = useMonthlySalesWidth(width);
  const targetRefs = useRef<Array<SVGGElement | null>>([]);
  const hatchId = `monthly-sales-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const W = measuredWidth;
  const narrow = W < 720;
  const H = narrow ? 230 : 300;
  const L = 8;
  const R = narrow ? 44 : 58;
  const T = 16;
  const B = 32;
  const iw = Math.max(1, W - L - R);
  const ih = Math.max(1, H - T - B);
  const slot = iw / Math.max(points.length, 1);
  const barWidth = Math.max(3, Math.min(34, slot * 0.64));
  const ymax = niceMonthlySalesAxisMax(points.map((point) => pointHasSales(point) ? point.sales : null));
  const y = (value: number) => T + ih - (value / ymax) * ih;
  const selectedIndex = points.findIndex((point) => point.periodStart === selectedPeriodStart);
  const [roving, setRoving] = useState(() => ({
    periodStart: selectedIndex >= 0 ? points[selectedIndex]?.periodStart ?? null : points[0]?.periodStart ?? null,
    selectedPeriodAtMove: selectedPeriodStart,
  }));
  // When a parent selection changes, derive the tab stop from that selection
  // during render. Arrow-key moves retain their own roving stop without an
  // effect-driven state update.
  const focusIndex = roving.selectedPeriodAtMove !== selectedPeriodStart
    ? selectedIndex >= 0 ? selectedIndex : 0
    : Math.max(0, points.findIndex((point) => point.periodStart === roving.periodStart));
  const axisLabels = visibleAxisLabels(points, selectedPeriodStart, slot);
  const targetName = (point: MonthlySalesPoint) => monthlySalesTargetLabel(point, point.periodStart === selectedPeriodStart);
  const focusTarget = (index: number) => {
    setRoving({ periodStart: points[index]?.periodStart ?? null, selectedPeriodAtMove: selectedPeriodStart });
    targetRefs.current[index]?.focus();
  };
  const select = (point: MonthlySalesPoint) => onSelectPeriod(point.periodStart);
  const hasComparators = points.some((point) => Boolean(point.comparatorLabel));

  const onTargetKeyDown = (event: ReactKeyboardEvent<SVGGElement>, index: number) => {
    const point = points[index];
    if (!point) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(point);
      return;
    }
    const next = nextMonthlySalesFocus(index, event.key, points.length);
    if (next !== index) {
      event.preventDefault();
      focusTarget(next);
    }
  };

  return (
    <section ref={containerRef} className={`monthly-sales-columns${className ? ` ${className}` : ""}`} aria-label={ariaLabel}>
      <style>{`
        .monthly-sales-columns .msc-target { cursor:pointer; outline:none; }
        .monthly-sales-columns .msc-focus { opacity:0; }
        .monthly-sales-columns .msc-target:focus .msc-focus { opacity:1; }
        .monthly-sales-columns .msc-data { margin-top:10px; border-top:1px solid var(--hair); }
        .monthly-sales-columns .msc-data summary { padding:10px 0; color:var(--ink-2); cursor:pointer; font-size:12px; font-weight:650; }
        .monthly-sales-columns .msc-scroll { max-height:228px; overflow:auto; border:1px solid var(--hair); border-radius:var(--r-control); }
        .monthly-sales-columns .msc-table { width:100%; border-collapse:collapse; font-size:12px; }
        .monthly-sales-columns .msc-table th, .monthly-sales-columns .msc-table td { padding:8px 10px; border-bottom:1px solid var(--hair-2); text-align:left; }
        .monthly-sales-columns .msc-table th { position:sticky; top:0; background:var(--surface); color:var(--faint); font-size:11px; letter-spacing:.04em; text-transform:uppercase; }
        .monthly-sales-columns .msc-table td:last-child, .monthly-sales-columns .msc-table th:last-child { text-align:right; }
        .monthly-sales-columns .msc-table tr[aria-current="true"] { background:var(--acc-weak); }
        .monthly-sales-columns .msc-table tr:last-child td { border-bottom:0; }
      `}</style>
      <svg viewBox={`0 0 ${W} ${H}`} className="ch" role="group" aria-label={ariaLabel}>
        <desc>Monthly material sales in dollars. Use left and right arrow keys to move between months, then Enter or Space to select a month.</desc>
        <defs>
          <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#5b63d3" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#ffffff" strokeOpacity="0.45" strokeWidth="2" />
          </pattern>
        </defs>
        {[0, 1, 2, 3, 4].map((tick) => {
          const value = (ymax * tick) / 4;
          const yy = y(value);
          return (
            <g key={tick}>
              <line x1={L} x2={L + iw} y1={yy} y2={yy} stroke="#eff1f5" strokeWidth="1" />
              <text x={W - R + 7} y={yy + 4} fontSize="11" fontWeight="500" fill="#6d7585" className="tnum">
                {fmt.money(value)}
              </text>
            </g>
          );
        })}
        {points.map((point, index) => {
          const { month } = periodParts(point.periodStart);
          if (month !== 1 || index === 0) return null;
          const x = L + slot * index;
          return <line key={`year-${point.periodStart}`} x1={x} x2={x} y1={T} y2={T + ih} stroke="#e4e7ed" strokeDasharray="2 3" />;
        })}
        {selectedIndex >= 0 ? (
          <rect
            x={L + slot * selectedIndex + Math.max(1, slot * 0.06)}
            y={T - 5}
            width={Math.max(1, slot * 0.88)}
            height={ih + 11}
            rx="6"
            fill="rgba(91,99,211,.07)"
          />
        ) : null}
        {points.map((point, index) => {
          const selected = point.periodStart === selectedPeriodStart;
          const cx = L + slot * index + slot / 2;
          const hasSales = pointHasSales(point);
          const value = hasSales ? point.sales! : null;
          const top = value == null ? T + ih : y(value);
          const height = value == null ? 0 : Math.max(2, T + ih - top);
          const axisLabel = monthlySalesAxisLabel(point.periodStart, selected || index === 0 || periodParts(point.periodStart).month === 1);
          const onPointerEnter = (event: ReactPointerEvent<SVGGElement>) => tipShow(salesTooltip(point), event.clientX, event.clientY);
          return (
            <g
              key={point.periodStart}
              ref={(node) => { targetRefs.current[index] = node; }}
              className="msc-target"
              role="button"
              tabIndex={index === focusIndex ? 0 : -1}
              aria-label={targetName(point)}
              aria-current={selected || undefined}
              onClick={() => select(point)}
              onFocus={() => setRoving({ periodStart: point.periodStart, selectedPeriodAtMove: selectedPeriodStart })}
              onKeyDown={(event) => onTargetKeyDown(event, index)}
              onPointerEnter={onPointerEnter}
              onPointerMove={(event) => tipTrack(event.clientX, event.clientY)}
              onPointerLeave={tipHide}
            >
              <title>{targetName(point)}</title>
              <rect className="msc-focus" x={cx - Math.max(10, slot * 0.45)} y={T - 3} width={Math.max(20, slot * 0.9)} height={ih + 7} rx="6" fill="none" stroke="#5b63d3" strokeWidth="2" />
              {hasSales ? (
                <rect
                  x={cx - barWidth / 2}
                  y={top}
                  width={barWidth}
                  height={height}
                  rx="3"
                  fill={point.partial ? `url(#${hatchId})` : selected ? "#5b63d3" : "#8087ec"}
                />
              ) : point.status === "failed" ? (
                <path d={`M ${cx} ${T + ih - 10} l 5 5 l -5 5 l -5 -5 z`} fill="#d0463a" />
              ) : (
                <circle cx={cx} cy={T + ih - 5} r="3.5" fill="#ffffff" stroke="#9aa2b2" strokeWidth="1.5" />
              )}
              {axisLabels.has(index) ? (
                <text
                  x={cx}
                  y={H - 9}
                  fontSize="11"
                  fontWeight={selected ? "700" : "500"}
                  fill={selected ? "#101422" : "#6d7585"}
                  textAnchor="middle"
                >
                  {axisLabel}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <details className="msc-data">
        <summary>Monthly sales data ({points.length} months)</summary>
        <div className="msc-scroll">
          <table className="msc-table">
            <caption style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
              Monthly material sales data
            </caption>
            <thead><tr><th scope="col">Month</th><th scope="col">Coverage</th><th scope="col">Sales</th>{hasComparators ? <th scope="col">Comparison</th> : null}</tr></thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.periodStart} aria-current={point.periodStart === selectedPeriodStart || undefined}>
                  <td>{monthlySalesMonthName(point.periodStart)}</td>
                  <td>{point.status === "complete" ? point.partial ? "MTD" : "Complete" : point.status === "failed" ? "Failed" : "Missing"}</td>
                  <td className="tnum">{pointHasSales(point) ? monthlySalesStatusText(point) : "—"}</td>
                  {hasComparators ? (
                    <td className="tnum">
                      {point.comparatorLabel
                        ? `${point.comparatorLabel} · ${point.comparatorSales != null && Number.isFinite(point.comparatorSales) ? fmt.moneyFull(point.comparatorSales) : "No completed data"}`
                        : "—"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
