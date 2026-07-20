"use client";

import type { CSSProperties } from "react";

/* Approved segmented control (tokens.css .seg). Controlled component:
   selection state lives with the caller, exactly one option is on. */

export type SegOption = { val: string; label: string };

export type SegProps = {
  options: SegOption[];
  value: string;
  onChange: (val: string) => void;
  /** Mirrors the mockups' data-seg identifier. */
  dataSeg?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
};

export function Seg({ options, value, onChange, dataSeg, ariaLabel, className, style }: SegProps) {
  return (
    <div className={className ? `seg ${className}` : "seg"} data-seg={dataSeg} role="group" aria-label={ariaLabel} style={style}>
      {options.map((o) => (
        <button
          key={o.val}
          type="button"
          data-val={o.val}
          className={o.val === value ? "on" : undefined}
          aria-pressed={o.val === value}
          onClick={() => onChange(o.val)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
