import type { ReactNode } from "react";
import { CalendarGlyph } from "@/components/nav-items";

/* Approved month stepper (tokens.css .ctl.stepper): ‹ month ›. Same GET
   semantics and params as the old period form — stepping navigates to
   `${action}?${name}=YYYY-MM` with any hidden fields preserved as query
   params. The forward step is disabled on the live month (the mockups'
   opacity-.35 treatment), and never navigates past it. */

type PeriodSelectorProps = {
  action: string;
  value?: string;
  label?: string;
  name?: string;
  hiddenFields?: Record<string, string | null | undefined>;
};

export function PeriodSelector({ action, value, label = "Period", name = "month", hiddenFields = {} }: PeriodSelectorProps) {
  const liveMonth = losAngelesMonthKey(new Date());
  const selected = isMonthKey(value) ? (value as string) : liveMonth;
  const prev = shiftMonthKey(selected, -1);
  const next = shiftMonthKey(selected, 1);
  const atLiveMonth = selected >= liveMonth;
  const monthToDateSuffix = next === liveMonth ? " (month to date)" : "";
  return (
    <MonthStepper
      label={label}
      prevHref={monthHref(action, name, prev, hiddenFields)}
      prevTitle={formatMonthKey(prev)}
      nextHref={atLiveMonth ? undefined : monthHref(action, name, next, hiddenFields)}
      nextTitle={atLiveMonth ? `${formatMonthKey(next)} has not started` : `${formatMonthKey(next)}${monthToDateSuffix}`}
    >
      {formatMonthKey(selected)}
    </MonthStepper>
  );
}

/* Presentational stepper — the /today page uses it directly with both steps
   pinned (Today always shows the live month). */
export function MonthStepper({
  label = "Period",
  prevHref,
  prevTitle,
  nextHref,
  nextTitle,
  children,
}: {
  label?: string;
  prevHref?: string;
  prevTitle: string;
  nextHref?: string;
  nextTitle: string;
  children: ReactNode;
}) {
  return (
    <div className="ctl stepper" role="group" aria-label={label}>
      <StepButton href={prevHref} title={prevTitle} glyph="‹" />
      <span className="lbl">
        <CalendarGlyph className="i" />
        {children}
      </span>
      <StepButton href={nextHref} title={nextTitle} glyph="›" />
    </div>
  );
}

function StepButton({ href, title, glyph }: { href?: string; title: string; glyph: string }) {
  if (href) {
    return (
      <a className="stepbtn" href={href} title={title} aria-label={title}>
        {glyph}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="stepbtn"
      disabled
      style={{ opacity: 0.35, cursor: "default" }}
      title={title}
      aria-label={title}
    >
      {glyph}
    </button>
  );
}

function monthHref(action: string, name: string, monthKey: string, hiddenFields: Record<string, string | null | undefined>) {
  const params = new URLSearchParams();
  for (const [fieldName, fieldValue] of Object.entries(hiddenFields)) {
    if (fieldValue) params.set(fieldName, fieldValue);
  }
  params.set(name, monthKey);
  return `${action}?${params.toString()}`;
}

function isMonthKey(value: string | undefined): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}

export function shiftMonthKey(monthKey: string, offset: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function formatMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export function losAngelesMonthKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const part = (type: "year" | "month") => Number(parts.find((entry) => entry.type === type)?.value);
  return `${part("year")}-${String(part("month")).padStart(2, "0")}`;
}
