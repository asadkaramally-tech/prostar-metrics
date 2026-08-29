import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const techniciansSource = readFileSync(path.join(process.cwd(), "src/components/technicians-dashboard.tsx"), "utf8");
const technicianStoreSource = readFileSync(path.join(process.cwd(), "src/lib/store/technician-read-model-inputs.ts"), "utf8");
const dashboardStoreSource = readFileSync(path.join(process.cwd(), "src/lib/store/dashboard-read-models.ts"), "utf8");
const todayStoreSource = readFileSync(path.join(process.cwd(), "src/lib/store/today-read-model.ts"), "utf8");
const commissionsSource = readFileSync(path.join(process.cwd(), "src/components/commissions-dashboard.tsx"), "utf8");
const jobsSource = readFileSync(path.join(process.cwd(), "src/components/jobs-dashboard.tsx"), "utf8");
const appShellSource = readFileSync(path.join(process.cwd(), "src/components/app-shell.tsx"), "utf8");
const sidebarNavSource = readFileSync(path.join(process.cwd(), "src/components/sidebar-nav.tsx"), "utf8");
const navItemsSource = readFileSync(path.join(process.cwd(), "src/components/nav-items.tsx"), "utf8");
const quotesSource = readFileSync(path.join(process.cwd(), "src/components/quotes/quote-metrics-dashboard.tsx"), "utf8");
const globalStyles = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

test("technician scorecard lives in the approved responsive table scroller", () => {
  // The approved rebuild drops the old technician <select> filter (drill is
  // client state) and contains wide content in the .tblwrap horizontal
  // scroller rather than shrinking a mobile combobox.
  assert.match(techniciansSource, /title="Technician Scorecard"/);
  assert.match(techniciansSource, /className="tblwrap"/);
  assert.doesNotMatch(techniciansSource, /sm:w-auto sm:min-w-56/);
});

test("technician punctuality replaces the rejected schedule-variance diagnostic", () => {
  // "Schedule Variance" was a rejected diagnostic panel; the approved page
  // surfaces on-time arrival and the punctuality distribution instead.
  assert.doesNotMatch(techniciansSource, /title="Schedule Variance"/);
  assert.match(techniciansSource, /title="Punctuality"/);
  assert.match(techniciansSource, /On-Time Arrival/);
});

test("technician history reads every served month from January 2023", () => {
  assert.match(technicianStoreSource, /period_start >= date '2023-01-01'/);
  assert.doesNotMatch(technicianStoreSource, /interval '11 months'/);
});

test("technician dashboard serves the persisted history instead of reloading all historical read models", () => {
  const servingFunction = dashboardStoreSource.match(
    /export async function getDashboardReadModel[\s\S]*?function buildKpis/,
  )?.[0] ?? "";

  assert.doesNotMatch(servingFunction, /getServedTechnicianHistory/);
});

test("today roster is recorded work in the live month, not static Simpro position membership", () => {
  const rosterQuery = todayStoreSource.slice(
    todayStoreSource.indexOf("async function getRosterTimesheetDetail"),
    todayStoreSource.indexOf("function monthRange"),
  );
  assert.match(rosterQuery, /from metrics\.metrics_employee_timesheets t/);
  assert.match(rosterQuery, /t\.work_date between \$1::date and \$2::date/);
  assert.match(rosterQuery, /t\.total_hours > 0/);
  assert.doesNotMatch(rosterQuery, /effective_technician_roster/);
  assert.doesNotMatch(rosterQuery, /is_field_technician/);
});

test("commission controls use the approved toolbar/seg grammar whose tokens wrap on mobile", () => {
  // The approved reset grammar (tokens.css) owns responsive behavior: the
  // toolbar wraps and the summary segmented control comes from .seg.
  assert.match(commissionsSource, /className="toolbar"/);
  assert.match(commissionsSource, /className="ctl-sel"/);
  assert.match(commissionsSource, /dataSeg="summode"/);
  assert.match(globalStyles, /\.toolbar\{display:flex;gap:26px;align-items:center;flex-wrap:wrap/);
});

test("commission dashboard no longer carries the rejected diagnostics/audit mobile shims", () => {
  assert.doesNotMatch(commissionsSource, /\[overflow-wrap:anywhere\]/);
  assert.doesNotMatch(commissionsSource, /Audit History|Payroll CSV|Rebuild/);
});

test("job metrics excludes invoicing because Pro Star invoices outside Simpro", () => {
  assert.doesNotMatch(jobsSource, /invoiceAnalysis|Invoiced Ex-Tax|Unbilled|Outstanding Aging|Invoice Exceptions/);
});

test("job metrics carries average job value inside the approved revenue tile", () => {
  // The approved band (docs/approved-design/mockups/jobs.html) has no
  // standalone Avg Job Value cell; the Revenue tile's sub line carries
  // "N completed jobs · avg $X" from the read-model payload.
  assert.doesNotMatch(jobsSource, /label="Avg Job Value"/);
  assert.match(jobsSource, /label="Revenue"/);
  assert.match(jobsSource, /avg \$\{fmt\.moneyFull\(selected\.averageJobValue\)\}/);
});

test("navigation uses the compact desktop top bar with an accessible active state", () => {
  // One top bar, both breakpoints: at <=900px the same markup becomes a
  // horizontal overflow row with no separate mobile nav component.
  assert.match(appShellSource, /className="rail"/);
  assert.match(appShellSource, /cachedPageLoad\("owner-data-health", 60_000/);
  assert.match(appShellSource, /Owner · \{isAdmin \? "Admin" : "Finance"\}/);
  assert.doesNotMatch(appShellSource, /Owner · \{user\.email\}/);
  assert.doesNotMatch(appShellSource, /MobileNav/);
  assert.match(sidebarNavSource, /aria-current=\{active \? "page"/);
  assert.match(sidebarNavSource, /aria-label="Metrics dashboards"/);
  assert.match(globalStyles, /\.app\{display:grid;grid-template-rows:56px 1fr;/);
  assert.match(globalStyles, /\.rail\{position:sticky;top:0;z-index:30;display:grid;grid-template-columns:auto minmax\(0,1fr\) auto;/);
  assert.match(globalStyles, /\.nav\{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0\}/);
  assert.match(globalStyles, /\.nav a\.active\{color:#fff;background:rgba\(255,255,255,\.105\);/);
  assert.match(globalStyles, /\.nav a\.active::before\{display:none\}/);
  assert.match(globalStyles, /@media \(max-width:900px\)\{[\s\S]*?\.rail\{grid-template-columns:auto 1fr;gap:10px;padding:9px 12px;overflow-x:auto\}/);
  assert.match(globalStyles, /@media \(max-width:900px\)\{[\s\S]*?\.nav\{justify-content:flex-start;overflow-x:auto\}/);
  assert.match(globalStyles, /@media \(max-width:900px\)\{[\s\S]*?\.owner\{display:none\}/);
  assert.match(navItemsSource, /label: "Quotes"/);
  assert.match(navItemsSource, /label: "Jobs"/);
  assert.match(navItemsSource, /label: "Technicians"/);
  assert.match(navItemsSource, /label: "Commissions"/);
  assert.match(navItemsSource, /href: "\/today", label: "Today"/);
});

test("quote wide content is contained by the approved local scrollers", () => {
  // History table lives in the approved .tblwrap horizontal scroller; the
  // narrow heatmap collapses to six columns via --hm-cols instead of scrolling.
  assert.match(quotesSource, /className="tblwrap"/);
  assert.match(globalStyles, /\.tblwrap\{overflow-x:auto\}/);
  assert.match(quotesSource, /max-width:480px/);
  assert.match(quotesSource, /const keep = narrow \? 6 : 12/);
});

test("rejected quote audit workbench stays deleted", () => {
  // Brief §15.9: rejected owner-facing surfaces and their contaminated UI
  // tests are removed with the approved /quotes rebuild.
  assert.doesNotMatch(quotesSource, /ClassificationWorkbench|Acceptance Evidence|RecordFiltersPanel/);
});

test("large job and commission detail collections render incrementally", () => {
  // Approved /jobs rebuild paginates the completed-jobs table client-side
  // (CLIENT_PAGE_SIZE) rather than round-tripping a jobPageHref per page.
  assert.match(jobsSource, /CLIENT_PAGE_SIZE/);
  assert.match(jobsSource, /Showing \$\{start \+ 1\}–\$\{start \+ visible\.length\} of/);
  // Commission job detail renders only for the opened leaderboard row.
  assert.match(commissionsSource, /\{open \? \(\s*<div id=\{detailId\}>\s*<RowDetail/);
});
