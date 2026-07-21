import type { ReactNode } from "react";
import { CalendarGlyph } from "@/components/nav-items";

/* Direct month/year picker with adjacent month steps. Its GET form preserves
   page-specific query fields while allowing keyboard users to enter any
   available month rather than stepping through history one month at a time. */

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
    <form className="ctl stepper period-picker" action={action} method="get" aria-label={label}>
      {Object.entries(hiddenFields).map(([fieldName, fieldValue]) => fieldValue ? (
        <input key={fieldName} type="hidden" name={fieldName} value={fieldValue} />
      ) : null)}
      <StepButton href={monthHref(action, name, prev, hiddenFields)} title={formatMonthKey(prev)} glyph="‹" />
      <label className="lbl">
        <CalendarGlyph className="i" />
        <span className="sr-only">{label}</span>
        <input
          className="period-input"
          type="month"
          name={name}
          defaultValue={selected}
          min="2023-01"
          max={liveMonth}
          aria-label={`${label} month and year`}
        />
      </label>
      <button type="submit" className="period-go">Go</button>
      <StepButton
        href={atLiveMonth ? undefined : monthHref(action, name, next, hiddenFields)}
        title={atLiveMonth ? `${formatMonthKey(next)} has not started` : `${formatMonthKey(next)}${monthToDateSuffix}`}
        glyph="›"
      />
    </form>
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
