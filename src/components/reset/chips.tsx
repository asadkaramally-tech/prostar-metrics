import type { CSSProperties, ReactNode } from "react";

/* Approved chip/pill grammar (tokens.css .chipd/.srcpill/.tierchip/.atag). */

export type ChipdProps = {
  /** Default is the green "up" treatment; "dn" red, "neutral" indigo. */
  tone?: "up" | "dn" | "neutral";
  def?: string;
  children?: ReactNode;
  style?: CSSProperties;
};

/* Delta chip on the dark focal ("↑ 75.9% vs Jul ’25 · day 14"). */
export function Chipd({ tone = "up", def, children, style }: ChipdProps) {
  const cls = ["chipd", tone === "up" ? null : tone, "tnum"].filter(Boolean).join(" ");
  return (
    <span className={cls} data-def={def} style={style}>
      {children}
    </span>
  );
}

export type SrcPillProps = {
  variant?: "diag" | "exec" | "viewed";
  children?: ReactNode;
  style?: CSSProperties;
};

/* Status/source pill ("Viewed by customer", "Sent", diagnostic…). */
export function SrcPill({ variant, children, style }: SrcPillProps) {
  const cls = variant ? `srcpill ${variant}` : "srcpill";
  return (
    <span className={cls} style={style}>
      <i />
      {children}
    </span>
  );
}

export type TierChipProps = {
  tier?: "gold" | "silver" | "bronze" | "std";
  def?: string;
  /** Renders an invisible placeholder that keeps row columns aligned. */
  placeholder?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
};

export function TierChip({ tier, def, placeholder, children, style }: TierChipProps) {
  if (placeholder) {
    return (
      <span className="tierchip" style={{ visibility: "hidden", ...style }} aria-hidden="true">
        —
      </span>
    );
  }
  const cls = ["tierchip", tier, def ? "def" : null].filter(Boolean).join(" ");
  return (
    <span className={cls} data-def={def} style={style}>
      {children}
    </span>
  );
}

export type ATagProps = { tone?: "amber" | "red"; children?: ReactNode; style?: CSSProperties };

/* Age/status tag on needs-attention rows ("44d", "0h", "114%"). */
export function ATag({ tone, children, style }: ATagProps) {
  const cls = ["atag", tone, "tnum"].filter(Boolean).join(" ");
  return (
    <span className={cls} style={style}>
      {children}
    </span>
  );
}
