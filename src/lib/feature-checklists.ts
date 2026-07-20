import type { RollupScope } from "@/lib/store/rollups";

export type FeatureChecklistItem = {
  id: string;
  label: string;
  status: "DONE" | "NOT STARTED" | "BLOCKED" | "DEFERRED BY ASAD";
};

export const pageFeatureChecklists: Record<RollupScope, FeatureChecklistItem[]> = {
  quotes: [
    ["Q-01", "Current month snapshot compares current month, prior-year same month, and prior month"],
    ["Q-02", "Partial-month/provisional alert"],
    ["Q-03", "Same-day normalized YoY comparison"],
    ["Q-04", "Pace strip for quote count, won count, and quote value"],
    ["Q-05", "Trailing 12-month win/loss donut"],
    ["Q-06", "YoY comparison table"],
    ["Q-07", "Deal-size tiers"],
    ["Q-08", "Quote volume by tier stacked bar"],
    ["Q-09", "Win rate by tier monthly line chart"],
    ["Q-10", "Win-rate-by-count trend"],
    ["Q-11", "Win-rate-by-value trend"],
    ["Q-12", "Tier x month heatmap"],
    ["Q-13", "Trailing 12-month KPI row with sparklines and deltas"],
    ["Q-14", "Monthly breakdown table"],
    ["Q-15", "Open quote aging table"],
    ["Q-16", "HVAC vs Water Heating segmentation"],
    ["Q-17", "Methodology footer"],
    ["Q-18", "Manual quote classification overrides"],
    ["Q-19", "Explainable quote win/loss reason"],
  ].map(toNotStarted),
  jobs: [
    ["J-01", "Completed jobs KPI"],
    ["J-02", "Total billed/sell value KPI"],
    ["J-03", "Average job value KPI"],
    ["J-04", "Gross profit and gross margin from Simpro Totals with coverage flags"],
    ["J-05", "Labor accuracy for quote-sourced jobs"],
    ["J-06", "Labor coverage counts"],
    ["J-07", "Material accuracy coverage-only until basis alignment is proven"],
    ["J-08", "Cost-center/category mix"],
    ["J-09", "Completed job period uses CompletedDate and valid completed stages"],
    ["J-10", "No pending/active job queue UI, filters, dispatch timeline, or old modal"],
  ].map(toNotStarted),
  technicians: [
    ["T-01", "Jobs completed per technician, credit-shared by timesheet hours"],
    ["T-02", "Allocated sell value per technician"],
    ["T-03", "Actual job hours from timesheets"],
    ["T-04", "Utilization uses confirmed clocked-hours source or is marked pending"],
    ["T-05", "Planned-vs-actual/on-time metric with coverage disclosure"],
    ["T-06", "Quoted-vs-actual labor efficiency for quote-sourced jobs"],
    ["T-07", "Every technician metric shows coverage basis"],
    ["T-08", "Multi-tech jobs allocate credit by actual timesheet share"],
    ["T-09", "No old mobile-status mirror dependency"],
    ["T-10", "No active dispatch/timeline UI"],
  ].map(toNotStarted),
  commissions: [
    ["C-01", "Monthly year/month selector and load action"],
    ["C-02", "Config banner"],
    ["C-03", "Monthly KPI cards"],
    ["C-04", "Bonus-by-technician waterfall chart"],
    ["C-05", "Ranked leaderboard"],
    ["C-06", "Tier tags and below-min indicators"],
    ["C-07", "Raw, forfeited, and reallocated bonus visibility"],
    ["C-08", "Proportional bonus bars"],
    ["C-09", "Expandable per-tech job allocation details"],
    ["C-10", "Efficiency calculation is functional from quote/job labor linkage before it affects commission results"],
    ["C-11", "Editable worksheet fields"],
    ["C-12", "Audited override persistence"],
    ["C-13", "Immutable commission calculation runs"],
    ["C-14", "Commission lifecycle"],
    ["C-15", "Payroll CSV export"],
    ["C-16", "PDF worksheet export"],
    ["C-17", "Calculation detail CSV"],
    ["C-18", "Private role-gated audited exports"],
    ["C-19", "Summary year selector and Monthly/Quarterly/Annual toggle"],
    ["C-20", "Summary stats"],
    ["C-21", "Summary tables with sparklines, team totals, no-data cells"],
    ["C-22", "Summary loading progress and diagnostics"],
  ].map(toNotStarted),
};

function toNotStarted([id, label]: string[]): FeatureChecklistItem {
  return { id, label, status: "NOT STARTED" };
}
