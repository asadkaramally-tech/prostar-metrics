import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { KpiDelta } from "@/components/ui/kpi-tile";

type MetricHeroProps = {
  label: string;
  value: string;
  meta?: React.ReactNode;
  delta?: KpiDelta;
  context?: React.ReactNode;
  sparkline?: Array<number | null | undefined>;
  sparklineLabel?: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
};

export function MetricHero({
  label,
  value,
  meta,
  delta,
  context,
  sparkline,
  sparklineLabel,
  children,
  className = "",
  testId,
}: MetricHeroProps) {
  const hasSparklineGeometry = sparklineGeometry(sparkline ?? [], 600, 86) !== null;
  const emptySparklineClass = sparkline !== undefined && !hasSparklineGeometry
    ? " metric-hero-focal--no-sparkline"
    : "";
  return (
    <section className={`metric-hero ${className}`} data-testid={testId}>
      <div className={`metric-hero-focal${emptySparklineClass}`}>
        <div className="metric-hero-label relative z-[1] flex items-center gap-2 text-[11px] font-semibold uppercase text-[#8b90a6]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--acc-2)] shadow-[0_0_10px_rgba(128,135,236,.9)]" aria-hidden="true" />
          {label}
        </div>
        <p className="metric-hero-value tnum relative z-[1] mt-3.5 break-words text-[clamp(2.55rem,6vw,3.375rem)] font-extrabold leading-none text-white">
          {value}
        </p>
        {meta || delta ? (
          <div className="metric-hero-meta relative z-[1] mt-3.5 flex min-w-0 flex-wrap items-center gap-3">
            {meta ? <div className="metric-hero-meta-content tnum min-w-0 text-sm font-semibold text-[#c3c8db]">{meta}</div> : null}
            {delta ? <HeroDelta delta={delta} /> : null}
          </div>
        ) : null}
        {context ? <div className="metric-hero-context relative z-[1] mt-4 max-w-[88%] text-xs leading-5 text-[#868ca2]">{context}</div> : null}
        <Sparkline
          values={sparkline ?? []}
          label={sparklineLabel ?? `${label} trend`}
          className="metric-hero-sparkline"
          tone="accent"
          viewBoxWidth={600}
          viewBoxHeight={86}
        />
      </div>
      <div className="metric-hero-aside">{children}</div>
    </section>
  );
}

type MetricHeroStatProps = {
  label: string;
  value: string;
  delta?: KpiDelta;
  context?: React.ReactNode;
  sparkline?: Array<number | null | undefined>;
  sparklineLabel?: string;
  seriesTone?: "strong" | "weak" | "neutral";
  className?: string;
};

export function MetricHeroStat({
  label,
  value,
  delta,
  context,
  sparkline = [],
  sparklineLabel,
  seriesTone = "neutral",
  className = "",
}: MetricHeroStatProps) {
  return (
    <article className={`metric-stat flex flex-col justify-between ${className}`}>
      <div className="min-w-0">
        <p className="truncate text-[10.5px] font-semibold uppercase text-[color:var(--subtle)]" title={label}>
          {label}
        </p>
        <p className="tnum mt-2 break-words text-[25px] font-bold leading-8 text-[color:var(--ink)]">{value}</p>
      </div>
      <div className="mt-2 flex min-w-0 items-end justify-between gap-2">
        <div className="min-w-0 flex-1">
          {delta ? <StatDelta delta={delta} /> : null}
          {context ? <div className="metric-stat-context mt-1 text-[11.5px] leading-4 text-[color:var(--muted)]" title={typeof context === "string" ? context : undefined}>{context}</div> : null}
        </div>
        <Sparkline
          values={sparkline}
          label={sparklineLabel ?? `${label} trend`}
          className="metric-stat-sparkline shrink-0"
          tone={seriesTone}
          viewBoxWidth={108}
          viewBoxHeight={32}
        />
      </div>
    </article>
  );
}

export function MetricHeroStats({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`metric-hero-stats ${className}`}>{children}</div>;
}

function HeroDelta({ delta }: { delta: KpiDelta }) {
  const Icon = delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;
  const className = delta.sentiment === "good"
    ? "border-[rgba(40,170,110,.32)] bg-[rgba(30,150,95,.18)] text-[#5fd39b]"
    : delta.sentiment === "bad"
      ? "border-[rgba(208,70,58,.35)] bg-[rgba(208,70,58,.16)] text-[#f08b82]"
      : "border-white/10 bg-white/[.06] text-[#aeb4c0]";
  return (
    <span className={`tnum inline-flex min-w-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold ${className}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap" title={delta.text}>{delta.text}</span>
    </span>
  );
}

function StatDelta({ delta }: { delta: KpiDelta }) {
  const Icon = delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;
  const className = delta.sentiment === "good"
    ? "text-[color:var(--up)]"
    : delta.sentiment === "bad"
      ? "text-[color:var(--down)]"
      : "text-[color:var(--subtle)]";
  return (
    <div className={`tnum flex min-w-0 items-center gap-0.5 text-[11px] font-bold ${className}`}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="whitespace-nowrap" title={delta.text}>{delta.text}</span>
    </div>
  );
}

function Sparkline({
  values,
  label,
  className,
  tone,
  viewBoxWidth,
  viewBoxHeight,
}: {
  values: Array<number | null | undefined>;
  label: string;
  className: string;
  tone: "accent" | "strong" | "weak" | "neutral";
  viewBoxWidth: number;
  viewBoxHeight: number;
}) {
  const geometry = sparklineGeometry(values, viewBoxWidth, viewBoxHeight);
  if (!geometry) return null;

  const safeId = `${label}-${tone}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const color = tone === "accent"
    ? "var(--acc-2)"
    : tone === "strong"
      ? "var(--series-strong)"
      : tone === "weak"
        ? "var(--series-weak)"
        : "var(--subtle)";
  const opacity = tone === "accent" ? 0.36 : 0.16;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={`${safeId}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={opacity} />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
        {tone === "accent" ? (
          <filter id={`${safeId}-glow`} x="-20%" y="-40%" width="140%" height="180%">
            <feDropShadow dx="0" dy="2" stdDeviation="3.5" floodColor="#5b63d3" floodOpacity="0.28" />
          </filter>
        ) : null}
      </defs>
      {geometry.areas.map((path, index) => (
        <path key={`area-${index}`} d={path} fill={`url(#${safeId}-fill)`} />
      ))}
      {geometry.lines.map((path, index) => (
        <path
          key={`line-${index}`}
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={tone === "accent" ? 2.2 : 1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          filter={tone === "accent" ? `url(#${safeId}-glow)` : undefined}
        />
      ))}
    </svg>
  );
}

function sparklineGeometry(values: Array<number | null | undefined>, width: number, height: number) {
  const finiteValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finiteValues.length < 2) return null;
  const minimum = Math.min(...finiteValues);
  const maximum = Math.max(...finiteValues);
  const range = Math.max(maximum - minimum, Math.abs(maximum) * 0.08, 1);
  const top = height * 0.12;
  const bottom = height * 0.96;
  const drawableHeight = bottom - top;
  const xFor = (index: number) => values.length === 1 ? width / 2 : index / (values.length - 1) * width;
  const yFor = (value: number) => top + (maximum - value) / range * drawableHeight;
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];

  values.forEach((value, index) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      segment.push({ x: xFor(index), y: yFor(value) });
      return;
    }
    if (segment.length > 1) segments.push(segment);
    segment = [];
  });
  if (segment.length > 1) segments.push(segment);
  if (segments.length === 0) return null;

  return {
    lines: segments.map(smoothPath),
    areas: segments.map((points) => {
      const first = points[0];
      const last = points[points.length - 1];
      const line = smoothPath(points);
      return `${line} L${last.x.toFixed(2)} ${height} L${first.x.toFixed(2)} ${height} Z`;
    }),
  };
}

type SparklinePoint = { x: number; y: number };

/** Shape-preserving cubic interpolation keeps each interval within its data endpoints. */
function smoothPath(points: SparklinePoint[]) {
  const slopes = monotoneSlopes(points);
  let path = `M${formatPoint(points[0])}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const width = next.x - current.x;
    const controlOffset = width / 3;
    const firstControl = {
      x: current.x + controlOffset,
      y: current.y + slopes[index] * controlOffset,
    };
    const secondControl = {
      x: next.x - controlOffset,
      y: next.y - slopes[index + 1] * controlOffset,
    };
    path += ` C${formatPoint(firstControl)} ${formatPoint(secondControl)} ${formatPoint(next)}`;
  }

  return path;
}

function monotoneSlopes(points: SparklinePoint[]) {
  const secants = points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    return (next.y - point.y) / (next.x - point.x);
  });
  const slopes = points.map((_, index) => {
    if (index === 0) return secants[0];
    if (index === points.length - 1) return secants[secants.length - 1];
    const previous = secants[index - 1];
    const next = secants[index];
    if (previous === 0 || next === 0 || Math.sign(previous) !== Math.sign(next)) return 0;
    return 2 / (1 / previous + 1 / next);
  });

  secants.forEach((secant, index) => {
    if (secant === 0) {
      slopes[index] = 0;
      slopes[index + 1] = 0;
      return;
    }
    const startRatio = slopes[index] / secant;
    const endRatio = slopes[index + 1] / secant;
    const magnitude = Math.hypot(startRatio, endRatio);
    if (magnitude <= 3) return;
    const scale = 3 / magnitude;
    slopes[index] = scale * startRatio * secant;
    slopes[index + 1] = scale * endRatio * secant;
  });

  return slopes;
}

function formatPoint(point: SparklinePoint) {
  return `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
}
