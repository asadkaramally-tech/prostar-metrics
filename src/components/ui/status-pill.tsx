import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  CircleHelp,
  Clock3,
  Info,
  RefreshCw,
} from "lucide-react";

/**
 * Shared status treatment: icon + label + tone, never color alone.
 * Covers the seven factual data states plus generic semantic tones.
 * Presentation-only; no data or behavior.
 */
export type DataState =
  | "current"
  | "partial"
  | "building"
  | "stale"
  | "suspect"
  | "failed"
  | "missing";

export type PillTone = DataState | "success" | "warning" | "danger" | "info" | "neutral";

type ToneSpec = {
  icon: LucideIcon;
  className: string;
  iconClassName: string;
};

const toneSpecs: Record<PillTone, ToneSpec> = {
  current: {
    icon: CheckCircle2,
    className: "border-[#d6ebe0] bg-white text-[#177a4f]",
    iconClassName: "text-[color:var(--up)]",
  },
  success: {
    icon: CheckCircle2,
    className: "border-[#d6ebe0] bg-[#f6fbf8] text-[#177a4f]",
    iconClassName: "text-[color:var(--up)]",
  },
  partial: {
    icon: CircleDashed,
    className: "border-[#eadfc9] bg-white text-[#8b641d]",
    iconClassName: "text-[color:var(--warn)]",
  },
  building: {
    icon: RefreshCw,
    className: "border-[#eadfc9] bg-[#fcfaf5] text-[#8b641d]",
    iconClassName: "text-[color:var(--warn)]",
  },
  stale: {
    icon: Clock3,
    className: "border-[#eadfc9] bg-[#fcfaf5] text-[#8b641d]",
    iconClassName: "text-[color:var(--warn)]",
  },
  suspect: {
    icon: AlertTriangle,
    className: "border-[#efd6d1] bg-[#fdf7f5] text-[#a44837]",
    iconClassName: "text-[color:var(--down)]",
  },
  failed: {
    icon: CircleAlert,
    className: "border-[#efd3cf] bg-[#fdf5f4] text-[#a9342b]",
    iconClassName: "text-[color:var(--down)]",
  },
  missing: {
    icon: CircleHelp,
    className: "border-[color:var(--hair)] bg-[color:var(--surface-soft)] text-[color:var(--muted)]",
    iconClassName: "text-[color:var(--subtle)]",
  },
  warning: {
    icon: AlertTriangle,
    className: "border-[#eadfc9] bg-[#fcfaf5] text-[#8b641d]",
    iconClassName: "text-[color:var(--warn)]",
  },
  danger: {
    icon: CircleAlert,
    className: "border-[#efd3cf] bg-[#fdf5f4] text-[#a9342b]",
    iconClassName: "text-[color:var(--down)]",
  },
  info: {
    icon: Info,
    className: "border-[color:var(--hair)] bg-[color:var(--surface-soft)] text-[color:var(--muted)]",
    iconClassName: "text-[color:var(--subtle)]",
  },
  neutral: {
    icon: Info,
    className: "border-[color:var(--hair)] bg-[color:var(--surface-soft)] text-[color:var(--muted)]",
    iconClassName: "text-[color:var(--subtle)]",
  },
};

type StatusPillProps = {
  tone: PillTone;
  label: string;
  /** Optional second line / trailing detail rendered in a lighter weight. */
  detail?: string;
  size?: "sm" | "md";
  className?: string;
  /** Override the tone's default icon (pass null to hide — avoid unless an adjacent icon already conveys state). */
  icon?: LucideIcon | null;
  title?: string;
};

export function StatusPill({ tone, label, detail, size = "md", className = "", icon, title }: StatusPillProps) {
  const spec = toneSpecs[tone];
  const Icon = icon === undefined ? spec.icon : icon;
  const sizing = size === "sm" ? "min-h-6 px-2.5 py-0.5 text-[11px] gap-1" : "min-h-8 px-3 py-1.5 text-[12.5px] gap-1.5";
  return (
    <span
      title={title}
      className={`inline-flex min-w-0 items-center rounded-full border font-semibold ${sizing} ${spec.className} ${className}`}
    >
      {tone === "current" || tone === "success" ? (
        <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[color:var(--up)] shadow-[0_0_0_3px_rgba(26,138,90,.16)]" aria-hidden="true" />
      ) : Icon ? <Icon className={`${size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} shrink-0 ${spec.iconClassName}`} aria-hidden="true" /> : null}
      <span className="min-w-0 whitespace-normal text-left">{label}</span>
      {detail ? <span className="min-w-0 whitespace-normal text-left font-normal opacity-80">{detail}</span> : null}
    </span>
  );
}
