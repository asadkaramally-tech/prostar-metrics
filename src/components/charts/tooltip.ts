"use client";

/* Shared white tooltip — a single fixed-position div reused by every chart,
   ported verbatim from the approved kit (kit.js tip/tipShow/tipHide/tipRow/
   tipTitle). Hidden on scroll and pointerdown anywhere, exactly as the kit
   wires it. Safe to import from server-rendered trees: all DOM access is
   lazy and guarded. */

let tipEl: HTMLDivElement | null = null;
let globalHideWired = false;

function tip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement("div");
    // Identifiable hook for the acceptance harness (design-interactions.mjs
    // looks for .charttip); no stylesheet rule attaches to it — styling stays
    // in the inline kit css below.
    tipEl.className = "charttip";
    tipEl.style.cssText =
      "position:fixed;z-index:60;background:#fff;border:1px solid #e9ebf0;border-radius:10px;" +
      "padding:9px 12px;font-size:12px;color:#2a3140;box-shadow:0 6px 24px -8px rgba(16,24,40,.24);" +
      "pointer-events:none;opacity:0;transition:opacity .12s;font-variant-numeric:tabular-nums;line-height:1.55;min-width:130px";
    document.body.appendChild(tipEl);
    if (!globalHideWired) {
      globalHideWired = true;
      window.addEventListener("scroll", tipHide, true);
      window.addEventListener("pointerdown", tipHide, true);
    }
  }
  return tipEl;
}

export function tipShow(html: string, cx: number, cy: number): void {
  if (typeof document === "undefined") return;
  const t = tip();
  t.innerHTML = html;
  t.style.opacity = "1";
  const w = t.offsetWidth,
    h = t.offsetHeight;
  let x = cx + 16,
    y = cy - h - 14;
  if (x + w > window.innerWidth - 10) x = cx - w - 16;
  if (y < 10) y = cy + 18;
  t.style.left = x + "px";
  t.style.top = y + "px";
}

export function tipHide(): void {
  if (tipEl) tipEl.style.opacity = "0";
}

/* Repositioning helper for pointermove tracking (kit.js stackedBars hot rect). */
export function tipTrack(cx: number, cy: number): void {
  if (typeof document === "undefined") return;
  const t = tip();
  t.style.left = Math.min(window.innerWidth - t.offsetWidth - 10, cx + 16) + "px";
  t.style.top = Math.max(10, cy - t.offsetHeight - 14) + "px";
}

export const tipRow = (color: string, name: string, val: string): string =>
  `<div style="display:flex;align-items:center;gap:7px;white-space:nowrap"><i style="width:8px;height:8px;border-radius:3px;background:${color};flex:none"></i>` +
  `<span style="color:#5c6474">${name}</span><b style="margin-left:auto;padding-left:16px;color:#101422">${val}</b></div>`;

export const tipTitle = (s: string): string =>
  `<div style="font-weight:700;color:#101422;margin-bottom:5px">${s}</div>`;

/* Definition tooltips: any element with [data-def] shows its formula/date-
   anchor on hover or tap (kit.js document-level delegation, ported). */
let defWired = false;
export function wireDefTooltips(): () => void {
  if (typeof document === "undefined" || defWired) return () => {};
  defWired = true;
  const over = (e: Event) => {
    const target = e.target as Element | null;
    const d = target?.closest?.("[data-def]") as HTMLElement | null;
    if (d) tipShow(
      `<div style="max-width:250px;line-height:1.55;color:#2a3140">${d.dataset.def}</div>`,
      (e as PointerEvent).clientX,
      (e as PointerEvent).clientY,
    );
  };
  const out = (e: Event) => {
    const target = e.target as Element | null;
    if (target?.closest?.("[data-def]")) tipHide();
  };
  document.addEventListener("pointerover", over);
  document.addEventListener("pointerout", out);
  return () => {
    document.removeEventListener("pointerover", over);
    document.removeEventListener("pointerout", out);
    defWired = false;
  };
}
