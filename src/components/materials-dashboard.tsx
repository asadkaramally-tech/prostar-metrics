"use client";

import { useEffect, useMemo, useState } from "react";
import { MonthlySalesColumns, type MonthlySalesPoint } from "@/components/charts/monthly-sales-columns";
import { fmt } from "@/components/charts";
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

type ChangeDriver = Pick<ItemWithComparison, "key" | "name" | "partNo" | "category" | "extended" | "comparisonExtended" | "comparisonSalesDelta">;

type MaterialsDashboardModel = Omit<MaterialsReadModel, "items" | "categories"> & {
  items: ItemWithComparison[];
  categories: CategoryWithComparison[];
  itemPagination?: MaterialsItemPagination;
  itemFilters?: { q: string; category: string | null; sort: string };
  itemCategories?: string[];
  comparison?: Comparison;
  topSignedDollarChangeDrivers?: ChangeDriver[];
};

export type MaterialsDashboardProps = { model: MaterialsDashboardModel; trend?: MaterialsTrendPoint[] };
export { buildMaterialsCsv } from "@/lib/materials/csv";

export function MaterialsDashboard({ model, trend = [] }: MaterialsDashboardProps) {
  const [drawerItem, setDrawerItem] = useState<ItemWithComparison | null>(null);
  const [drawerJobs, setDrawerJobs] = useState<MaterialsItemJobDetail[] | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [range, setRange] = useState<"responsive" | "12" | "24" | "all">("responsive");
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
    if (range === "responsive" || range === "all" || trend.length <= count) return trend;
    const end = selectedIndex >= 0 ? selectedIndex + 1 : trend.length;
    return trend.slice(Math.max(0, end - count), end);
  }, [model.periodStart, range, trend]);

  return (
    <DefTooltipProvider>
      <CoverageWarning model={model} />
      <SalesPerformance
        model={model}
        comparison={comparison}
        range={range}
        onRange={(value) => setRange(value as "12" | "24" | "all")}
        points={shownTrend}
      />
      <div className="materials-analysis-grid">
        <ChangeDrivers model={model} comparison={comparison} />
        <CategoryMix model={model} comparison={comparison} />
      </div>
      <MaterialsReview model={model} comparison={comparison} onOpen={openDrawer} />
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
  range: "responsive" | "12" | "24" | "all";
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
  const exposure = model.exposure;
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

  return (
    <Card
      className="materials-performance"
      title="Sales performance"
      subtitle={`${monthLongName(monthKey)} ${monthKey.slice(0, 4)} · extended sell, ex-tax · ${partial ? `month to date through day ${totals.elapsedDays}` : "closed month"}`}
      aside={range === "responsive" ? <><Seg className="materials-range-desktop" options={[{ val: "12", label: "12M" }, { val: "24", label: "24M" }, { val: "all", label: "All history" }]} value="all" onChange={onRange} ariaLabel="Material sales history range" /><Seg className="materials-range-mobile" options={[{ val: "12", label: "12M" }, { val: "24", label: "24M" }, { val: "all", label: "All history" }]} value="12" onChange={onRange} ariaLabel="Material sales history range" /></> : <Seg options={[{ val: "12", label: "12M" }, { val: "24", label: "24M" }, { val: "all", label: "All history" }]} value={range} onChange={onRange} ariaLabel="Material sales history range" />}
    >
      <CardBody>
        <div className="materials-performance-layout">
          <section className="materials-summary" aria-label="Selected-period summary">
            <div className="materials-primary-stat">
              <span>{partial ? "Material sales · MTD" : "Material sales"}</span>
              <strong className="tnum">{selectedAvailable ? fmt.moneyFull(totals.current) : "Unavailable"}</strong>
              <small>{selectedAvailable ? partial ? `Day ${totals.elapsedDays} of ${totals.daysInMonth}` : "Full month" : "No completed selected-period walk"}</small>
            </div>
            <div className="materials-comparison-grid">
              <SummaryMetric
                label={comparison.label}
                value={comparator == null ? "—" : fmt.moneyFull(comparator)}
                delta={delta}
              />
              <SummaryMetric
                label={`${seriesLabel(shiftMonthKey(monthKey, -1))} closed`}
                value={!selectedAvailable || priorMonth == null ? "—" : fmt.moneyFull(priorMonth)}
              />
              {selectedAvailable && partial ? <SummaryMetric label="Calendar-day run-rate pace" value={fmt.moneyFull(totals.paceProjection)} /> : null}
            </div>
            <div className="materials-exposure-list" aria-label="Material exposure facts">
              <Exposure label="Special order / non-stock" value={selectedAvailable ? exposure?.specialOrder : null} />
              <Exposure label="Largest material" value={selectedAvailable ? exposure?.largestItem : null} name={selectedAvailable ? exposure?.largestItem?.name : null} />
              <Exposure label="Ungrouped" value={selectedAvailable ? exposure?.ungrouped : null} />
            </div>
          </section>
          <section className="materials-history" aria-label="Monthly material sales history">
            {chartPoints.length ? range === "responsive" ? <>
              <div className="materials-chart-desktop"><MonthlySalesColumns points={chartPoints} selectedPeriodStart={model.periodStart} onSelectPeriod={(periodStart) => { window.location.href = `/materials?month=${periodStart.slice(0, 7)}`; }} /></div>
              <div className="materials-chart-mobile"><MonthlySalesColumns points={chartPoints.slice(-12)} selectedPeriodStart={model.periodStart} onSelectPeriod={(periodStart) => { window.location.href = `/materials?month=${periodStart.slice(0, 7)}`; }} /></div>
            </> : (
              <MonthlySalesColumns
                points={chartPoints}
                selectedPeriodStart={model.periodStart}
                onSelectPeriod={(periodStart) => { window.location.href = `/materials?month=${periodStart.slice(0, 7)}`; }}
              />
            ) : <StateEmpty>No completed monthly material history is available.</StateEmpty>}
          </section>
        </div>
      </CardBody>
    </Card>
  );
}

function SummaryMetric({ label, value, delta }: { label: string; value: string; delta?: number | null }) {
  return <div className="materials-summary-metric"><span>{label}</span><b className="tnum">{value}</b>{delta != null ? <i className={delta < 0 ? "down" : "up"}>{signedPercent(delta)}</i> : null}</div>;
}

function Exposure({ label, value, name }: { label: string; value?: { value: number; share: number } | null; name?: string | null }) {
  return <div><span>{label}</span>{name ? <small title={name}>{name}</small> : null}<b className="tnum">{value ? `${(value.share * 100).toFixed(1)}% · ${fmt.moneyFull(value.value)}` : "—"}</b></div>;
}

function ChangeDrivers({ model, comparison }: { model: MaterialsDashboardModel; comparison: Comparison }) {
  if (model.coverage.selectedMonth.status !== "complete") return <Card title="What changed" subtitle="Comparison unavailable"><CardBody><StateEmpty>A completed selected-period walk is required for change drivers.</StateEmpty></CardBody></Card>;
  const sourceDrivers: ChangeDriver[] = model.topSignedDollarChangeDrivers ?? model.items
    .filter((item) => item.comparisonSales != null)
    .sort((a, b) => Math.abs((b.extended - b.comparisonSales!)) - Math.abs((a.extended - a.comparisonSales!)))
    .slice(0, 6)
    .map((item) => ({ ...item, comparisonExtended: item.comparisonSales, comparisonSalesDelta: item.extended - item.comparisonSales! }));
  const drivers = sourceDrivers.slice(0, 6);
  return (
    <Card title="What changed" subtitle={comparison.available ? comparison.label : "Comparison unavailable"}>
      <CardBody>
        {drivers.length ? <div className="materials-driver-list">{drivers.map((item) => {
          const change = item.comparisonSalesDelta ?? 0;
          const max = Math.max(...drivers.map((driver) => Math.abs(driver.comparisonSalesDelta ?? 0)), 1);
          return <div key={item.key} className="materials-driver-row">
            <div><b>{item.name}</b><small>{item.partNo ?? item.category}</small></div>
            <div className="materials-driver-track" aria-hidden="true"><i className={change != null && change < 0 ? "negative" : "positive"} style={{ width: `${change == null ? 0 : Math.max(4, Math.abs(change) / max * 100)}%` }} /></div>
            <strong className={`tnum ${change < 0 ? "negative" : "positive"}`}>{signedMoney(change)}</strong>
          </div>;
        })}</div> : <StateEmpty>{comparison.available ? "No material-level changes are available." : `Complete ${comparison.label.replace(/^vs /, "")} data is required for change drivers.`}</StateEmpty>}
      </CardBody>
    </Card>
  );
}

function CategoryMix({ model, comparison }: { model: MaterialsDashboardModel; comparison: Comparison }) {
  if (model.coverage.selectedMonth.status !== "complete") return <Card title="Category mix" subtitle="Selected-period data unavailable"><CardBody><StateEmpty>A completed selected-period walk is required for category values.</StateEmpty></CardBody></Card>;
  const total = model.categories.reduce((sum, category) => sum + category.value, 0);
  const max = Math.max(...model.categories.map((category) => category.value), 1);
  return (
    <Card title="Category mix" subtitle={`${monthLongName(model.periodStart.slice(0, 7))} sales · current Simpro grouping`}>
      <CardBody>
        <div className="materials-category-list">
          {model.categories.map((category) => {
            const change = category.valueDelta ?? (category.comparisonValue == null ? null : category.value - category.comparisonValue);
            return <div key={category.name} className={`materials-category-row${category.name === "Ungrouped" ? " ungrouped" : ""}`}>
              <div><b>{category.name}</b><span className="tnum">{total > 0 ? `${(category.value / total * 100).toFixed(1)}%` : "0%"}</span></div>
              <div className="materials-category-track"><i style={{ width: `${category.value / max * 100}%` }} /></div>
              <div><strong className="tnum">{fmt.moneyFull(category.value)}</strong><small className={`tnum ${change != null && change < 0 ? "negative" : "positive"}`}>{comparison.available && category.taxonomyComparable && change != null ? signedMoney(change) : "—"}</small></div>
            </div>;
          })}
        </div>
      </CardBody>
    </Card>
  );
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
  if (model.coverage.selectedMonth.status !== "complete") return <Card className="materials-review" title="Material review" subtitle="Selected-period data unavailable"><CardBody><StateEmpty>A completed selected-period walk is required for material review.</StateEmpty></CardBody></Card>;
  return (
    <Card className="materials-review" title="Material review" subtitle={`${pagination.total} materials · comparator: ${comparison.label}`} aside={<a className="ctl materials-csv" href={`/api/materials/csv?${query({})}`}>Download CSV</a>}>
      <CardBody className="materials-review-controls">
        <form action="/materials" method="get">
          <input type="hidden" name="month" value={monthKey} />
          <label><span>Search</span><input name="q" defaultValue={filters.q} placeholder="Material or part number" /></label>
          <label><span>Category</span><select name="category" defaultValue={filters.category ?? ""}><option value="">All categories</option>{(model.itemCategories ?? []).map((category) => <option key={category}>{category}</option>)}</select></label>
          <label><span>Sort</span><select name="sort" defaultValue={filters.sort}><option value="sales">Sales</option><option value="dollar-change">Dollar change</option><option value="jobs">Jobs</option><option value="quantity-change">Quantity change</option></select></label>
          <button type="submit" className="ctl">Apply</button>
        </form>
      </CardBody>
      {model.items.length ? <>
        <div className="tblwrap materials-table"><table><thead><tr><th>Material</th><th>Category</th><th className="num">Sales</th><th className="num">{comparison.columnLabel ?? comparison.shortLabel ?? comparison.label.replace(/^vs /, "")}</th><th className="num">Change</th><th className="num">Qty</th><th className="num">Jobs</th></tr></thead><tbody>
          {model.items.map((item) => { const change = item.comparisonSales == null ? null : item.extended - item.comparisonSales; return <tr key={item.key} className="rowlink" onClick={() => onOpen(item)}><td><button type="button" onClick={() => onOpen(item)}><span className="id1">{item.name}</span><span className="id2">{item.partNo ?? "No part number"}</span></button></td><td data-label="Category">{item.category}</td><td className="num tnum" data-label="Sales"><b>{fmt.moneyFull(item.extended)}</b></td><td className="num tnum" data-label={comparison.shortLabel ?? "Comparator"}>{item.comparisonSales == null ? "—" : fmt.moneyFull(item.comparisonSales)}</td><td className={`num tnum ${change != null && change < 0 ? "negative" : "positive"}`} data-label="Change">{change == null ? "—" : signedMoney(change)}</td><td className="num tnum" data-label="Qty">{qtyText(item.qty)}</td><td className="num tnum" data-label="Jobs">{item.jobCount}</td></tr>; })}
        </tbody></table></div>
        <div className="foot"><span>Showing {start + 1}–{start + model.items.length} of {pagination.total}</span><span className="pager"><a href={pagination.page > 1 ? `/materials?${query({ page: String(pagination.page - 1) })}` : undefined} aria-disabled={pagination.page === 1 || undefined}>‹</a>{pageList(pagination.totalPages, pagination.page).map((entry, index) => entry === "gap" ? <span key={`g${index}`} className="gap">…</span> : <a key={entry} className={entry === pagination.page ? "on" : undefined} href={`/materials?${query({ page: String(entry) })}`}>{entry}</a>)}<a href={pagination.page < pagination.totalPages ? `/materials?${query({ page: String(pagination.page + 1) })}` : undefined} aria-disabled={pagination.page === pagination.totalPages || undefined}>›</a></span></div>
      </> : <CardBody><StateEmpty>No materials match these filters.</StateEmpty></CardBody>}
    </Card>
  );
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
function signedPercent(value: number) { return `${value < 0 ? "↓" : "↑"} ${Math.abs(value * 100).toFixed(1)}%`; }
