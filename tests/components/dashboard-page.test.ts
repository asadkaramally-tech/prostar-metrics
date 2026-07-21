import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardPage } from "../../src/components/dashboard-page";
import { losAngelesMonthKey, PeriodSelector, shiftMonthKey } from "../../src/components/period-selector";
import type { FreshnessStatus } from "../../src/lib/metrics/freshness";

const TestDashboardPage = DashboardPage as ComponentType<Omit<ComponentProps<typeof DashboardPage>, "children">>;
const freshness: FreshnessStatus = {
  pageKey: "commissions",
  state: "current",
  label: "Data current",
  detail: "Data-through 2026-06-30.",
  dataThrough: "2026-06-30T00:00:00.000Z",
  lastSuccessfulRunAt: "2026-07-01T00:00:00.000Z",
  lastFailedRunAt: null,
};

test("header renders the approved top grammar: Operations eyebrow, h1, sub, controls", () => {
  const html = renderToStaticMarkup(createElement(TestDashboardPage, {
    title: "Job Metrics",
    description: "Revenue, profit and outcomes for completed work.",
    freshness,
  }, createElement("section", null, "content")));

  assert.match(html, /class="top"/);
  assert.match(html, /class="eyebrow">Operations</);
  assert.doesNotMatch(html, /Payroll/);
  assert.match(html, /<h1 class="h1">Job Metrics<\/h1>/);
  assert.match(html, /class="sub">Revenue, profit and outcomes for completed work\.</);
  assert.match(html, /class="controls"/);
});

test("freshness pill states Updated N ago (never Live) and turns amber off-current", () => {
  const current = renderToStaticMarkup(createElement(TestDashboardPage, {
    title: "Job Metrics",
    description: "d",
    freshness,
  }, createElement("section", null, "content")));
  assert.match(current, /class="pill"[^>]*role="status"/);
  assert.match(current, /Updated \d+ (min|hr|hrs|days) ago/);
  assert.doesNotMatch(current, />Live</);

  const stale = renderToStaticMarkup(createElement(TestDashboardPage, {
    title: "Job Metrics",
    description: "d",
    freshness: { ...freshness, state: "stale" },
  }, createElement("section", null, "content")));
  assert.match(stale, /class="pill warn"/);

  const missing = renderToStaticMarkup(createElement(TestDashboardPage, {
    title: "Job Metrics",
    description: "d",
    freshness: { ...freshness, state: "missing", label: "No app-owned data yet", lastSuccessfulRunAt: null },
  }, createElement("section", null, "content")));
  assert.match(missing, /class="pill warn"/);
  assert.match(missing, /No app-owned data yet/);
  assert.doesNotMatch(missing, /Updated NaN/);
});

test("commission period controls render a direct month/year picker inside the header and preserve summaryYear", () => {
  const model = {
    worksheet: { year: 2026, month: 6, periodLabel: "June 2026" },
    summary: { year: 2027 },
  };
  const child = createElement(CommissionChild, { model });
  const html = renderToStaticMarkup(createElement(TestDashboardPage, {
    title: "Technician Commissions",
    description: "Commission worksheet controls.",
    freshness,
  }, child));

  const contentStart = html.indexOf("data-period");
  const stepper = html.indexOf('aria-label="Commission period"');
  assert.ok(stepper > 0 && stepper < contentStart, "stepper renders inside the header, before page content");
  assert.match(html, /class="ctl stepper period-picker"/);
  assert.match(html, /type="month"[^>]*name="month"[^>]*value="2026-06"/);
  assert.match(html, /type="hidden" name="summaryYear" value="2027"/);
  assert.match(html, />Go<\/button>/);
  assert.match(html, /href="\/commissions\?summaryYear=2027(&amp;|&)month=2026-05"/);
});

test("direct picker preserves page-specific query fields when submitted or stepped", () => {
  const html = renderToStaticMarkup(createElement(PeriodSelector, {
    action: "/jobs",
    value: "2026-06",
    hiddenFields: { category: "HVAC", jobPage: "3", states: "1" },
  }));
  assert.match(html, /<form[^>]*action="\/jobs"[^>]*method="get"/);
  assert.match(html, /type="hidden" name="category" value="HVAC"/);
  assert.match(html, /type="hidden" name="jobPage" value="3"/);
  assert.match(html, /type="hidden" name="states" value="1"/);
  assert.match(html, /type="month"[^>]*min="2023-01"[^>]*max="\d{4}-\d{2}"/);
  assert.match(html, /href="\/jobs\?category=HVAC(&amp;|&)jobPage=3(&amp;|&)states=1(&amp;|&)month=2026-05"/);
});

test("month stepper disables the forward step on the live month and links the previous month", () => {
  const liveMonth = losAngelesMonthKey(new Date());
  const html = renderToStaticMarkup(createElement(TestDashboardPage, {
    title: "Technician Commissions",
    description: "d",
    freshness,
  }, createElement(CommissionChild, {
    model: {
      worksheet: {
        year: Number(liveMonth.slice(0, 4)),
        month: Number(liveMonth.slice(5, 7)),
        periodLabel: liveMonth,
      },
      summary: { year: Number(liveMonth.slice(0, 4)) },
    },
  })));

  const prev = shiftMonthKey(liveMonth, -1);
  assert.match(html, new RegExp(`href="/commissions\\?summaryYear=\\d+(&amp;|&)month=${prev}"`));
  assert.match(html, /<button[^>]*class="stepbtn"[^>]*disabled/);
});

function CommissionChild({ model }: { model: { worksheet: { year: number; month: number; periodLabel: string }; summary: { year: number } } }) {
  const period = `${model.worksheet.year}-${String(model.worksheet.month).padStart(2, "0")}`;
  return createElement("main", { "data-period": period }, "content");
}
