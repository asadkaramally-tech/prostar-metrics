"use client";

import type { CSSProperties } from "react";

/* Approved metric-picker chips (tokens.css .pickrow/.mchip): multi-select
   chips whose swatch takes the series colour via --c when on, grouped with
   .mgrp per the approved jobs.html markup. Selection semantics (exclusive
   modes, minimum one selection…) live with the caller. */

export type MetricChip = {
  key: string;
  label: string;
  /** Series colour — becomes the chip's --c swatch when selected. */
  color: string;
  /** Hatched swatch (representative/interim series). */
  hatch?: boolean;
};

export type MetricPickerProps = {
  /** Chip groups; each group renders as an .mgrp cluster. Pass one group for a flat row. */
  groups: MetricChip[][];
  selected: string[];
  onToggle: (key: string) => void;
  className?: string;
  style?: CSSProperties;
};

export function MetricPicker({ groups, selected, onToggle, className, style }: MetricPickerProps) {
  return (
    <div className={className ? `pickrow ${className}` : "pickrow"} style={style}>
      {groups.map((chips, gi) => (
        <span className="mgrp" key={gi}>
          {chips.map((chip) => {
            const on = selected.includes(chip.key);
            return (
              <button
                key={chip.key}
                type="button"
                data-m={chip.key}
                className={on ? "mchip on" : "mchip"}
                aria-pressed={on}
                style={{ "--c": chip.color } as CSSProperties}
                onClick={() => onToggle(chip.key)}
              >
                <i className={chip.hatch ? "hatch" : undefined} />
                {chip.label}
              </button>
            );
          })}
        </span>
      ))}
    </div>
  );
}
