import { isValidElement } from "react";
import type { LucideIcon } from "lucide-react";
import { FreshnessBanner } from "@/components/freshness-banner";
import { PeriodSelector } from "@/components/period-selector";
import type { FreshnessStatus } from "@/lib/metrics/freshness";

type DashboardPageProps = {
  title: string;
  description: string;
  /** Accepted for page-level compatibility; the approved header has no icon tile. */
  icon?: LucideIcon;
  freshness: FreshnessStatus;
  controls?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Approved page header (tokens.css .top): eyebrow "Operations" on every
 * dashboard, h1, one-line sub, and right-side controls — the month stepper
 * plus the freshness pill. The first viewport belongs to decision content,
 * not the header.
 */
export function DashboardPage({ title, description, freshness, controls, children }: DashboardPageProps) {
  const commissionPeriod = dashboardCommissionPeriod(children);
  const resolvedControls = controls ?? (commissionPeriod ? <CommissionPeriodControls {...commissionPeriod} /> : null);
  return (
    <div className="dashboard-content">
      <div className="top">
        <div>
          <div className="eyebrow">Operations</div>
          <h1 className="h1">{title}</h1>
          <p className="sub">{description}</p>
        </div>
        <div className="controls">
          {resolvedControls}
          <FreshnessBanner freshness={freshness} />
        </div>
      </div>
      {children}
    </div>
  );
}

function dashboardCommissionPeriod(children: React.ReactNode) {
  const model = nodeProps(children)?.model;
  if (!model || typeof model !== "object") return undefined;
  const record = model as {
    worksheet?: { year?: unknown; month?: unknown };
  };
  const year = record.worksheet?.year;
  const month = record.worksheet?.month;
  if (typeof year !== "number" || typeof month !== "number") return undefined;
  return { year, month };
}

function CommissionPeriodControls({ year, month }: { year: number; month: number }) {
  return (
    <PeriodSelector
      action="/commissions"
      label="Commission period"
      value={`${year}-${String(month).padStart(2, "0")}`}
    />
  );
}

function nodeProps(node: React.ReactNode): Record<string, unknown> | undefined {
  return isValidElement(node) ? node.props as Record<string, unknown> : undefined;
}
