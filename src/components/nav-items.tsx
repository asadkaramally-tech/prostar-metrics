import type { ComponentType } from "react";

/**
 * Single source of truth for the primary metric dashboards.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

export const navItems: NavItem[] = [
  { href: "/today", label: "Today", icon: TodayProfitabilityIcon },
  { href: "/quotes", label: "Quotes", icon: QuoteMetricsIcon },
  { href: "/jobs", label: "Jobs", icon: JobMetricsIcon },
  { href: "/materials", label: "Materials", icon: MaterialSalesIcon },
  { href: "/technicians", label: "Technicians", icon: TechnicianPerformanceIcon },
  { href: "/commissions", label: "Commissions", icon: TechnicianCommissionsIcon },
];

function TodayProfitabilityIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M4 19V9M10 19V5M16 19v-7M3 19h18" />
      <path d="m4 8 6-4 6 7 4-3" />
    </svg>
  );
}

function QuoteMetricsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M9 14h6M9 17h4" />
    </svg>
  );
}

function JobMetricsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <rect x={3} y={7} width={18} height={13} rx={2} />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </svg>
  );
}

function MaterialSalesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4M12 11v9" />
    </svg>
  );
}

function TechnicianPerformanceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <circle cx={9} cy={8} r={3.2} />
      <path d="M3.5 20c.6-3.4 2.9-5.2 5.5-5.2s4.9 1.8 5.5 5.2" />
      <circle cx={17} cy={9.5} r={2.4} />
      <path d="M15.5 14.6c2.4.2 4.3 1.7 4.9 4.4" />
    </svg>
  );
}

function TechnicianCommissionsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <circle cx={12} cy={12} r={8.5} />
      <path d="M12 7.5v9M14.8 9.2c-.6-.9-1.6-1.4-2.8-1.4-1.7 0-3 .9-3 2.2 0 2.9 6 1.5 6 4.3 0 1.3-1.3 2.2-3 2.2-1.3 0-2.4-.6-3-1.5" />
    </svg>
  );
}

/** Approved calendar glyph used inside the month-stepper label. */
export function CalendarGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <rect x={3} y={5} width={18} height={16} rx={2} />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </svg>
  );
}
