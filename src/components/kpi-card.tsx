import type { LucideIcon } from "lucide-react";
import { KpiTile, type KpiDelta } from "@/components/ui/kpi-tile";
import { MetricHeroStat } from "@/components/ui/metric-hero";

type KpiCardProps = {
  title: string;
  value: string;
  subtitle?: string;
  icon: LucideIcon;
  variant?: "tile" | "hero-stat";
  delta?: KpiDelta;
  sparkline?: Array<number | null | undefined>;
  sparklineLabel?: string;
  seriesTone?: "strong" | "weak" | "neutral";
};

/**
 * Backwards-compatible KPI card: same (title, value, subtitle, icon) contract
 * used across jobs/technicians/commissions, now rendered through the shared
 * KpiTile treatment so every KPI reads as one system. The subtitle maps to the
 * tile's coverage/context line. No metric or value logic changes here.
 */
export function KpiCard({ title, value, subtitle, icon, variant = "tile", delta, sparkline, sparklineLabel, seriesTone }: KpiCardProps) {
  if (variant === "hero-stat") {
    return (
      <MetricHeroStat
        label={title}
        value={value}
        context={subtitle}
        delta={delta}
        sparkline={sparkline}
        sparklineLabel={sparklineLabel}
        seriesTone={seriesTone}
      />
    );
  }
  return <KpiTile label={title} value={value} icon={icon} context={subtitle} />;
}
