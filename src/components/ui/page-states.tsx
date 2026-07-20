import type { LucideIcon } from "lucide-react";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * Shared loading skeleton for a dashboard route. Mirrors the redesigned page
 * shell (compact header, KPI row, two panels) so the transition to loaded
 * content does not shift layout. Purely presentational.
 */
export function DashboardSkeleton({
  title,
  icon: Icon,
  kpiCount = 6,
}: {
  title: string;
  icon: LucideIcon;
  kpiCount?: number;
}) {
  const heroVariant = title.includes("Commission")
    ? "metric-hero--commission"
    : title.includes("Quote") || title.includes("Technician Performance")
      ? "metric-hero--route-compact"
      : "";
  const commissionStats = title.includes("Commission") ? "min-[521px]:!h-[202px] min-[521px]:!min-h-[202px]" : "";
  return (
    <div
      className="dashboard-content"
      role="status"
      aria-busy="true"
      aria-label={`Loading ${title}`}
    >
      <span className="sr-only">Loading {title}</span>
      <Icon className="sr-only" aria-hidden="true" />
      <div className="mb-[26px] flex min-h-[66px] items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="h-3 w-32 animate-pulse rounded bg-[color:var(--surface-sunken)]" />
          <div className="mt-2.5 h-7 w-52 animate-pulse rounded-md bg-[color:var(--surface-sunken)]" />
          <div className="mt-2 h-3 w-full max-w-[440px] animate-pulse rounded bg-[color:var(--surface-sunken)]" />
        </div>
        <div className="ml-auto hidden h-10 w-64 animate-pulse rounded-[11px] bg-[color:var(--surface-sunken)] sm:block" />
      </div>
      <div className={`metric-hero ${heroVariant}`}>
        <div className="metric-hero-focal animate-pulse !p-0" />
        <div className={`metric-hero-stats ${commissionStats}`}>
          {Array.from({ length: Math.min(kpiCount, 4) }, (_, index) => (
            <div key={index} className="metric-stat animate-pulse" />
          ))}
        </div>
      </div>
      <div className="mt-[18px] grid gap-[18px] xl:grid-cols-2">
        <div className="dashboard-panel h-72 animate-pulse" />
        <div className="dashboard-panel h-72 animate-pulse" />
      </div>
    </div>
  );
}

/**
 * Shared route-level error presentation. Preserves the retry/reset affordance
 * and role="alert" semantics; copy is supplied by the caller and stays truthful.
 */
export function DashboardErrorState({
  heading,
  detail,
  onRetry,
}: {
  heading: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div className="dashboard-content">
      <section className="dashboard-panel border-[#efd3cf] bg-[#fdf7f5] p-6" role="alert">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f8e8e5]">
            <AlertTriangle className="h-4 w-4 text-[color:var(--down)]" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-[15px] font-bold text-[color:var(--ink)]">{heading}</h1>
            <p className="mt-1 text-[13px] leading-5 text-[#8e3a32]">{detail}</p>
            <button
              type="button"
              onClick={onRetry}
              className="focus-ring mt-4 inline-flex h-10 items-center gap-2 rounded-[11px] bg-[color:var(--down)] px-3.5 text-[13px] font-semibold text-white hover:bg-[#b83b31]"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Retry
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
