/* Number formatters ported verbatim from the approved chart kit:
   redesign-handoff/product-reset/APPROVED-2026-07-15/mockups/assets/kit.js */

export const fmt = {
  money(v: number, dp = 0): string {
    const a = Math.abs(v);
    const s = v < 0 ? "−$" : "$";
    if (a >= 1e6) return s + (a / 1e6).toFixed(1) + "M";
    if (a >= 1e4) return s + Math.round(a / 1e3).toLocaleString() + "K";
    if (a >= 1e3) return s + a.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return s + a.toFixed(dp);
  },
  moneyFull(v: number): string {
    return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  },
  cents(v: number): string {
    return (
      (v < 0 ? "−$" : "$") +
      Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    );
  },
  pct(v: number, dp = 1): string {
    return v.toFixed(dp) + "%";
  },
  hrs(v: number): string {
    return v.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "h";
  },
  n(v: number): string {
    return Math.round(v).toLocaleString();
  },
};

export type ValueFormatter = (v: number) => string;
