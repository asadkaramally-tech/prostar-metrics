"use client";

import { useEffect, useMemo, useState } from "react";
import { MonthlySalesColumns, type MonthlySalesPoint } from "@/components/charts/monthly-sales-columns";
import { fmt } from "@/components/charts";
import { BarList, BarListRow, Dpill, KpiBand, KpiBandNote, KpiTile, KpiTiles, moneyK, PrimaryStatCard } from "@/components/band";
import { monthLongName, monthShortName, pageList, seriesLabel, shiftMonthKey } from "@/components/jobs-dashboard";
import { Card, CardBody, DefTooltipProvider, Drawer, DSec, KV, KVCell, Seg, StateEmpty } from "@/components/reset";
import type { MaterialsCategorySlice, MaterialsReadModel } from "@/lib/metrics/materials";
import type { MaterialsItemJobDetail, MaterialsItemPagination, MaterialsItemSummary, MaterialsTrendPoint } from "@/lib/store/materials-read-model";

type Comparison = {
  label: string;
  shortLabel?: string;
  columnLabel?: string;
  available: boolean;
  comparable?: boolean;
  basis?: string;
};

type CategoryWithComparison = MaterialsCategorySlice & {
  comparisonValue?: number | null;
  valueDelta?: number | null;
  comparisonAvailable?: boolean;
};

type ItemWithComparison = MaterialsItemSummary & {
  comparisonQty?: number | null;
  comparisonSales?: number | null;
};

type MaterialsDashboardModel = Omit<MaterialsReadModel, "items" | "categories"> & {
  items: ItemWithComparison[];
  categories: CategoryWithComparison[];
  itemPagination?: MaterialsItemPagination;
  itemFilters?: { q: string; category: string | null; sort: string };
  itemCategories?: string[];
  comparison?: Comparison;
};

export type MaterialsDashboardProps = { model: MaterialsDashboardModel; trend?: MaterialsTrendPoint[] };
export { buildMaterialsCsv } from "@/lib/materials/csv";

export function MaterialsDashboard({ model, trend = [] }: MaterialsDashboardProps) {
  const [drawerItem, setDrawerItem] = useState<ItemWithComparison | null>(null);
  const [drawerJobs, setDrawerJobs] = useState<MaterialsItemJobDetail[] | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [range, setRange] = useState<"12" | "24" | "all">("all");
  const monthKey = model.periodStart.slice(0, 7);
  const comparison = resolvedComparison(model);

  useEffect(() => {
    if (!drawerItem) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ month: monthKey, key: drawerItem.key });
    void fetch(`/api/materials/item-jobs?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Job details could not be loaded.");
        return response.json() as Promise<{ jobs?: MaterialsItemJobDetail[] }>;
      })
      .then((payload) => setDrawerJobs(Array.isArray(payload.jobs) ? payload.jobs : []))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDrawerError(error instanceof Error ? error.message : "Job details could not be loaded.");
      });
    return () => controller.abort();
  }, [drawerItem, monthKey]);

  const openDrawer = (item: ItemWithComparison) => {
    setDrawerJobs(null);
    setDrawerError(null);
    setDrawerItem(item);
  };

  const shownTrend = useMemo(() => {
    const count = range === "12" ? 12 : range === "24" ? 24 : trend.length;
    const selectedIndex = trend.findIndex((point) => point.periodStart === model.periodStart);
    if (range === "all" || trend.length <= count) return trend;
    const end = selectedIndex >= 0 ? selectedIndex + 1 : trend.length;
    return trend.slice(Math.max(0, end - count), end);
  }, [model.periodStart, range, trend]);

  return (
    <DefTooltipProvider>
      <div>
        <CoverageWarning model={model} />
        <SalesPerformance
          model={model}
          comparison={comparison}
          range={range}
          onRange={(value) => setRange(value as "12" | "24" | "all")}
          points={shownTrend}
        />
        <div className="grid12">
          <CategoryMix model={model} />
        </div>
        <div className="grid12">
          <MaterialsReview model={model} comparison={comparison} onOpen={openDrawer} />
        </div>
      </div>
      <Drawer
        open={drawerItem !== null}
        onClose={() => setDrawerItem(null)}
        ariaLabel="Material detail"
        title={drawerItem?.name}
        sub={drawerItem ? `${drawerItem.category} · ${monthLongName(monthKey)} ${monthKey.slice(0, 4)}` : null}
      >
        {drawerItem ? <MaterialDrawer row={drawerItem} comparison={comparison} jobs={drawerJobs} error={drawerError} /> : null}
      </Drawer>
    </DefTooltipProvider>
  );
}

function SalesPerformance({ model, comparison, range, onRange, points }: {
  model: MaterialsDashboardModel;
  comparison: Comparison;
  range: "12" | "24" | "all";
  onRange: (value: string) => void;
  points: MaterialsTrendPoint[];
}) {
  const totals = model.totals;
  const monthKey = model.periodStart.slice(0, 7);
  const partial = totals.elapsedDays < totals.daysInMonth;
  const selectedAvailable = model.coverage.selectedMonth.status === "complete";
  const comparator = selectedAvailable && comparison.available ? totals.priorYearSameDay : null;
  const delta = comparator && comparator !== 0 ? (totals.current - comparator) / comparator : null;
  const priorMonth = model.coverage.priorMonth.status === "complete" ? totals.priorMonth : null;
  const chartPoints: MonthlySalesPoint[] = points.map((point) => ({
    periodStart: point.periodStart,
    sales: point.sales,
    status: point.status,
    partial: point.isPartial,
    elapsedDays: point.elapsedDays ?? undefined,
    daysInMonth: point.daysInMonth ?? undefined,
    comparatorLabel: point.comparisonLabel ?? undefined,
    comparatorSales: point.sameMonthLastYearSales,
  }));

  const rangeControl = <Seg options={[{ val: "12", label: "12M" }, { val: "24", label: "24M" }, { val: "all", label: "All history" }]} value={range} onChange={onRange} ariaLabel="Material sales history range" />;
  const priorLabel = `${seriesLabel(shiftMonthKey(monthKey, -1))} full month`;
  const comparisonPill = delta == null ? null : <Dpill tone={delta < 0 ? "down" : delta > 0 ? "up" : "neutral"}>{delta < 0 ? "↓" : "↑"} {Math.abs(delta * 100).toFixed(1)}% {comparison.label}</Dpill>;

  return <>
    <KpiBand ariaLabel={`${monthLongName(monthKey)} material metrics`}>
      <PrimaryStatCard
        href="#materials-history"
        label="Material sales"
        pills={comparisonPill}
        value={selectedAvailable ? fmt.moneyFull(totals.current) : "N/A"}
        sub={selectedAvailable ? partial ? `Extended sell, ex-tax · day ${totals.elapsedDays} of ${totals.daysInMonth}` : "Extended sell, ex-tax · full month" : "Selected-period data unavailable"}
        bullet={selectedAvailable ? { value: totals.current, m1: { label: comparison.label.replace(/^vs /, ""), value: comparator, ghost: "no data" }, m2: { label: priorLabel, value: priorMonth, ghost: "no data" }, fmt: moneyK, ariaLabel: `${monthLongName(monthKey)} material sales ${fmt.moneyFull(totals.current)}` } : null}
      />
      <KpiTiles>
        <KpiTile label={comparison.label.replace(/^vs /, "")} value={comparator == null ? "N/A" : fmt.moneyFull(comparator)} sub="Material sales" />
        <KpiTile label={priorLabel} value={priorMonth == null ? "N/A" : fmt.moneyFull(priorMonth)} sub="Material sales" />
        <KpiTile label="Completed jobs" value={selectedAvailable ? fmt.n(model.coverage.selectedMonth.jobCount) : "N/A"} sub="Included in this month" />
        <KpiTile label={partial ? "Calendar-day pace" : "Material lines"} value={selectedAvailable ? partial ? fmt.moneyFull(totals.paceProjection) : fmt.n(model.coverage.includedLineCount) : "N/A"} sub={partial ? "Projection, not actual sales" : "Included after exclusions"} />
      </KpiTiles>
    </KpiBand>
    <KpiBandNote>{partial ? `Current sales are actuals through day ${totals.elapsedDays}; the pace tile is a simple calendar-day projection.` : "All selected-period and comparison values are full-month actuals."}</KpiBandNote>
    <div className="grid12" id="materials-history">
      <Card className="span12" title="Monthly Material Sales" subtitle="Extended sell, ex-tax · select a month to review it" aside={rangeControl}>
        <CardBody>
          {chartPoints.length ? <MonthlySalesColumns points={chartPoints} selectedPeriodStart={model.periodStart} onSelectPeriod={(periodStart) => { window.location.href = `/materials?month=${periodStart.slice(0, 7)}`; }} /> : <StateEmpty>No completed monthly material history is available.</StateEmpty>}
        </CardBody>
      </Card>
    </div>
  </>;
}

function CategoryMix({ model }: { model: MaterialsDashboardModel }) {
  if (model.coverage.selectedMonth.status !== "complete") return <Card className="span12" title="Material Sales by Category" subtitle="Selected-period data unavailable"><CardBody><StateEmpty>A completed selected-period walk is required for category values.</StateEmpty></CardBody></Card>;
  const total = model.categories.reduce((sum, category) => sum + category.value, 0);
  const max = Math.max(...model.categories.map((category) => category.value), 1);
  return <Card className="span12" title="Material Sales by Category" subtitle={`${monthLongName(model.periodStart.slice(0, 7))} · Simpro category grouping · bars scaled to the largest category`}>
    <CardBody><BarList variant="cols2" ariaLabel="Material sales by category">
      {model.categories.map((category) => <BarListRow
        key={category.name}
        name={category.name}
        value={fmt.moneyFull(category.value)}
        barPct={category.value / max * 100}
        barNeutral={category.name === "Ungrouped"}
        meta={`${total > 0 ? (category.value / total * 100).toFixed(1) : "0"}% of material sales`}
      />)}
    </BarList></CardBody>
  </Card>;
}

function MaterialsReview({ model, comparison, onOpen }: { model: MaterialsDashboardModel; comparison: Comparison; onOpen: (item: ItemWithComparison) => void }) {
  const monthKey = model.periodStart.slice(0, 7);
  const filters = model.itemFilters ?? { q: "", category: null, sort: "sales" };
  const pagination = model.itemPagination ?? { page: 1, pageSize: Math.max(1, model.items.length), total: model.items.length, totalPages: 1 };
  const query = (extra: Record<string, string>) => {
    const params = new URLSearchParams({ month: monthKey, ...(filters.q ? { q: filters.q } : {}), ...(filters.category ? { category: filters.category } : {}), sort: filters.sort, ...extra });
    return params.toString();
  };
  const start = (pagination.page - 1) * pagination.pageSize;
  if (model.coverage.selectedMonth.status !== "complete") return <Card className="span12" title="Material Review" subtitle="Selected-period data unavailable"><CardBody><StateEmpty>A completed selected-period walk is required for material review.</StateEmpty></CardBody></Card>;
  return <Card className="span12" title="Material Review" subtitle={`${pagination.total} materials · select a row for completed-job detail`} aside={<a className="ctl materials-csv" href={`/api/materials/csv?${query({})}`}>Download CSV</a>}>
    <div className="materials-review-controls">
      <form action="/materials" method="get">
          <input type="hidden" name="month" value={monthKey} />
          <label><span>Search</span><input name="q" defaultValue={filters.q} placeholder="Material or part number" /></label>
          <label><span>Category</span><select name="category" defaultValue={filters.category ?? ""}><option value="">All categories</option>{(model.itemCategories ?? []).map((category) => <option key={category}>{category}</option>)}</select></label>
          <label><span>Sort</span><select name="sort" defaultValue={filters.sort}><option value="sales">Sales</option><option value="dollar-change">Dollar change</option><option value="jobs">Jobs</option><option value="quantity-change">Quantity change</option></select></label>
          <button type="submit" className="ctl">Apply</button>
      </form>
    </div>
    {model.items.length ? <>
        <div className="tblwrap materials-table"><table><thead><tr><th>Material</th><th>Category</th><th className="num">Sales</th><th className="num">{comparison.columnLabel ?? comparison.shortLabel ?? comparison.label.replace(/^vs /, "")}</th><th className="num">Change</th><th className="num">Qty</th><th className="num">Jobs</th></tr></thead><tbody>
          {model.items.map((item) => { const change = item.comparisonSales == null ? null : item.extended - item.comparisonSales; return <tr key={item.key} className="rowlink" onClick={() => onOpen(item)}><td><button type="button" onClick={() => onOpen(item)}><span className="id1">{item.name}</span><span className="id2">{item.partNo ?? "No part number"}</span></button></td><td data-label="Category">{item.category}</td><td className="num tnum" data-label="Sales"><b>{fmt.moneyFull(item.extended)}</b></td><td className="num tnum" data-label={comparison.shortLabel ?? "Comparator"}>{item.comparisonSales == null ? "—" : fmt.moneyFull(item.comparisonSales)}</td><td className={`num tnum ${change != null && change < 0 ? "negative" : "positive"}`} data-label="Change">{change == null ? "—" : signedMoney(change)}</td><td className="num tnum" data-label="Qty">{qtyText(item.qty)}</td><td className="num tnum" data-label="Jobs">{item.jobCount}</td></tr>; })}
        </tbody></table></div>
        <div className="foot"><span>Showing {start + 1}–{start + model.items.length} of {pagination.total}</span><span className="pager"><a href={pagination.page > 1 ? `/materials?${query({ page: String(pagination.page - 1) })}` : undefined} aria-disabled={pagination.page === 1 || undefined}>‹</a>{pageList(pagination.totalPages, pagination.page).map((entry, index) => entry === "gap" ? <span key={`g${index}`} className="gap">…</span> : <a key={entry} className={entry === pagination.page ? "on" : undefined} href={`/materials?${query({ page: String(entry) })}`}>{entry}</a>)}<a href={pagination.page < pagination.totalPages ? `/materials?${query({ page: String(pagination.page + 1) })}` : undefined} aria-disabled={pagination.page === pagination.totalPages || undefined}>›</a></span></div>
    </> : <div className="materials-workbench-empty"><StateEmpty>No materials match these filters.</StateEmpty></div>}
  </Card>;
}

function MaterialDrawer({ row, comparison, jobs, error }: { row: ItemWithComparison; comparison: Comparison; jobs: MaterialsItemJobDetail[] | null; error: string | null }) {
  const change = row.comparisonSales == null ? null : row.extended - row.comparisonSales;
  return <><KV><KVCell label="Sales" value={fmt.moneyFull(row.extended)} /><KVCell label={comparison.shortLabel ?? comparison.label.replace(/^vs /, "")} value={row.comparisonSales == null ? "—" : fmt.moneyFull(row.comparisonSales)} /><KVCell label="Dollar change" value={change == null ? "—" : signedMoney(change)} /><KVCell label="Quantity" value={qtyText(row.qty)} /><KVCell label="Effective unit sell" def="Selected-period sales divided by selected-period quantity; mixed packaging or units may make this unsuitable for cross-item comparison." value={row.unitSell == null ? "—" : fmt.cents(row.unitSell)} /><KVCell label="Category" value={row.category} /></KV><DSec>Completed jobs</DSec>{jobs ? jobs.length ? <div className="materials-job-list">{jobs.map((job) => <div key={job.jobId}><div><b>Job {job.jobNo ?? job.jobId}</b><span>{job.completedDate ?? "Date unavailable"}</span></div><p>{[job.customerName, job.siteName].filter(Boolean).join(" · ") || "Customer and site unavailable"}</p><strong className="tnum">{fmt.moneyFull(job.extended)} · {qtyText(job.qty)} units</strong></div>)}</div> : <StateEmpty>No linked completed jobs are available.</StateEmpty> : error ? <StateEmpty>{error}</StateEmpty> : <StateEmpty>Loading completed jobs…</StateEmpty>}</>;
}

function CoverageWarning({ model }: { model: MaterialsDashboardModel }) {
  if (model.coverage.selectedMonth.status === "complete") return null;
  return <div role="alert" className="materials-coverage-warning"><b>Selected-period coverage is {model.coverage.selectedMonth.status}.</b> Values shown may be incomplete.</div>;
}

function resolvedComparison(model: MaterialsDashboardModel): Comparison {
  if (model.comparison) return model.comparison;
  const monthKey = model.periodStart.slice(0, 7);
  const partial = model.totals.elapsedDays < model.totals.daysInMonth;
  const prior = seriesLabel(shiftMonthKey(monthKey, -12));
  return { label: partial ? `vs ${prior} through day ${model.totals.elapsedDays}` : `vs ${prior} full month`, shortLabel: partial ? `${monthShortName(shiftMonthKey(monthKey, -12))} ’${monthKey.slice(2, 4)} through d${model.totals.elapsedDays}` : `${prior} full`, available: model.coverage.selectedMonth.status === "complete" && model.coverage.priorYearMonth.status === "complete", comparable: model.coverage.selectedMonth.status === "complete" && model.coverage.priorYearMonth.status === "complete", basis: "same_month_prior_year" };
}

export function qtyText(value: number | null): string { return value == null ? "—" : String(Math.round(value * 100) / 100); }
export function qtyDelta(qty: number, priorQty: number | null) { if (priorQty == null) return { kind: "unavailable", text: "—" }; if (priorQty === 0 && qty > 0) return { kind: "new", text: "new" }; const diff = Math.round((qty - priorQty) * 1000) / 1000; return diff === 0 ? { kind: "zero", text: "0" } : diff > 0 ? { kind: "up", text: `+${qtyText(diff)}` } : { kind: "down", text: `−${qtyText(Math.abs(diff))}` }; }
export function paceComparison(pace: number, priorMonth: number | null): string { if (!priorMonth || priorMonth <= 0) return ""; const diff = (pace - priorMonth) / priorMonth; return Math.abs(diff) <= .1 ? "even with" : diff > 0 ? "ahead of" : "behind"; }
export function paceText(value: number): string { return value >= 1e6 ? `≈$${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `≈$${Math.round(value / 1e3)}K` : `≈$${Math.round(value)}`; }
export function niceMaterialsAxisMax(values: Array<number | null>): number { const max = Math.max(0, ...values.filter((value): value is number => value != null && Number.isFinite(value))); if (max <= 0) return 1; const magnitude = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / magnitude) * magnitude; }
export function categorySegments(model: MaterialsDashboardModel) { const total = model.categories.reduce((sum, category) => sum + category.value, 0); return model.categories.map((category) => ({ name: category.name, value: category.value, pct: total > 0 ? category.value / total * 100 : 0, fill: category.name === "Special order / non-stock" ? "color-mix(in srgb, var(--warn), #fff 55%)" : "var(--acc)", light: false })); }
function signedMoney(value: number) { return `${value < 0 ? "−" : "+"}${fmt.moneyFull(Math.abs(value))}`; }
