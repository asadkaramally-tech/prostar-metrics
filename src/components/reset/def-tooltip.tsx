"use client";

import { useEffect, type ReactNode } from "react";
import { wireDefTooltips } from "../charts/tooltip";

/* Global [data-def] definition tooltips — mount once per page (kit.js
   document-level pointerover/pointerout delegation, ported). Hover or tap
   any element carrying data-def to see its formula/date-anchor. */

export function DefTooltipProvider({ children }: { children?: ReactNode }) {
  useEffect(() => wireDefTooltips(), []);
  return <>{children}</>;
}

/* Convenience wrapper for the approved dotted-underline definition span. */
export function Def({ def, children }: { def: string; children?: ReactNode }) {
  return (
    <span className="def" data-def={def}>
      {children}
    </span>
  );
}
