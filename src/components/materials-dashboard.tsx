"use client";

import { useState } from "react";
import { Dpill, KpiBand, moneyK, PrimaryStatCard, SegBar, type SegBarSegment } from "@/components/band";
import { fmt } from "@/components/charts";
import {
  monthLongName,
  monthShortName,
  pageList,
  seriesLabel,
  shiftMonthKey,
} from "@/components/jobs-dashboard";
import {
  Card,
  CardBody,
  DefTooltipProvider,
  Drawer,
  DSec,
  KV,
  KVCell,
  StateEmpty,
} from "@/components/reset";
import { SPECIAL_ORDER_CATEGORY, type MaterialsItemRow, type MaterialsReadModel } from "@/lib/metrics/materials";

/* /materials — implements the owner-approved mockup
   docs/approved-design/mockups/materials.html exactly, with every figure
   taken from the materials read model (the mockup's July numbers are sample
   content). Composition [owner-ruled — no KPI tiles, no narrative text]:
   band pair (MATERIALS SOLD primary stat card BESIDE the Materials Value by
   Category segmented bar) → All Materials Sold table ordered by total sold
   value with CSV, pagination and a row drill drawer. The only micro-copy on
   the page is the table subtitle's Δ column key. */

const CLIENT_PAGE_SIZE = 20;

/* Category fills follow the mockup's rank order; Special order / non-stock
   always takes the warn tint wherever it ranks, the "N more" remainder is
   always --n300. Light fills label in --ink, solid fills in white. */
const SPECIAL_FILL = "color-mix(in srgb, var(--warn), #fff 55%)";
const REMAINDER_FILL = "var(--n300)";
const RANK_FILLS = [
  "var(--n400)",
  "var(--acc)",
  "var(--series-2)",
  "color-mix(in srgb, var(--acc), #fff 40%)",
  "color-mix(in srgb, var(--series-2), #fff 40%)",
];
const LIGHT_FILLS = new Set([SPECIAL_FILL, REMAINDER_FILL, RANK_FILLS[3], RANK_FILLS[4]]);

export type MaterialsDashboardProps = { model: MaterialsReadModel };

export function MaterialsDashboard({ model }: MaterialsDashboardProps) {
  const [drawerItem, setDrawerItem] = useState<MaterialsItemRow | null>(null);
  const monthKey = model.periodStart.slice(0, 7);
  const monthLong = monthLongName(monthKey);

  if (model.items.length === 0) {
    return (
      <Card>
        <CardBody>
          <StateEmpty>{emptyMonthMessage(model, monthLong)}</StateEmpty>
        </CardBody>
      </Card>
    );
  }

  return (
    <DefTooltipProvider>
      <MaterialsBand model={model} />
      <MaterialsTableCard model={model} onOpen={(row) => setDrawerItem(row)} />
      <Drawer
        open={drawerItem !== null}
        onClose={() => setDrawerItem(null)}
        ariaLabel="Material detail"
        title={drawerItem?.name}
        sub={drawerItem ? `${drawerItem.category} · ${monthLong} ${monthKey.slice(0, 4)}` : null}
      >
        {drawerItem ? <MaterialDrawerBody row={drawerItem} monthKey={monthKey} /> : null}
      </Drawer>
    </DefTooltipProvider>
  );
}

function emptyMonthMessage(model: MaterialsReadModel, monthLong: string): string {
  const status = model.coverage.selectedMonth.status;
  if (status === "missing") return `No completed materials walk exists for ${monthLong} yet.`;
  if (status === "failed") return `The latest ${monthLong} materials walk failed; no materials are available.`;
  return `No materials were billed on jobs completed in ${monthLong}.`;
}

/* ── Row 1: band pair — primary stat card beside the category bar ── */

/** Pace-vs-prior wording: within ±10% reads "even with", as approved. */
export function paceComparison(pace: number, priorMonth: number | null): string {
  if (priorMonth == null || priorMonth <= 0) return "";
  const diff = (pace - priorMonth) / priorMonth;
  if (Math.abs(diff) <= 0.1) return "even with";
  return diff > 0 ? "ahead of" : "behind";
}

/** "≈$237K" pace text (whole-K, matching the approved sub line). */
export function paceText(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `≈$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `≈$${Math.round(a / 1e3)}K`;
  return `≈$${Math.round(a)}`;
}

function MaterialsBand({ model }: { model: MaterialsReadModel }) {
  const totals = model.totals;
  const monthKey = model.periodStart.slice(0, 7);
  const monthLong = monthLongName(monthKey);
  const partial = totals.elapsedDays < totals.daysInMonth;
  const lyName = seriesLabel(shiftMonthKey(monthKey, -12));
  const priorName = seriesLabel(shiftMonthKey(monthKey, -1));
  const priorLong = monthLongName(shiftMonthKey(monthKey, -1));
  const priorYearComplete = model.coverage.priorYearMonth.status === "complete";
  const priorMonthComplete = model.coverage.priorMonth.status === "complete";
  const priorYearValue = priorYearComplete && totals.priorYearSameDay > 0 ? totals.priorYearSameDay : null;
  const priorMonthValue = priorMonthComplete && totals.priorMonth > 0 ? totals.priorMonth : null;
  const lyDef = partial ? `vs ${lyName}, aligned to day ${totals.elapsedDays}` : `vs ${lyName}, full month`;
  const yoyDelta = priorYearValue != null ? ((totals.current - priorYearValue) / priorYearValue) * 100 : null;
  const comparisonWord = paceComparison(partial ? totals.paceProjection : totals.current, priorMonthValue);

  return (
    <KpiBand className="bandpair" ariaLabel={`${monthLong} materials`}>
      <PrimaryStatCard
        label={partial ? "Materials sold · MTD" : "Materials sold"}
        labelDef={`Extended sell (ex-tax) of catalog, one-off Material and prebuild lines on jobs completed in ${monthLong}. Service Fee lines and the Service Contract group are excluded.`}
        pills={
          yoyDelta != null ? (
            <Dpill tone={yoyDelta < 0 ? "down" : yoyDelta > 0 ? "up" : "neutral"} def={lyDef}>
              {yoyDelta < 0 ? "↓" : "↑"} {Math.abs(yoyDelta).toFixed(1)}% vs {lyName}
            </Dpill>
          ) : null
        }
        value={fmt.moneyFull(totals.current)}
        sub={
          partial
            ? `on pace for ${paceText(totals.paceProjection)} full-month${comparisonWord ? ` — ${comparisonWord} ${priorLong}` : ""}`
            : `full month${comparisonWord ? ` · ${comparisonWord} ${priorLong}` : ""}`
        }
        bullet={{
          value: totals.current,
          m1: {
            label: `${lyName} · ${partial ? `d${totals.elapsedDays}` : "full"}`,
            value: priorYearValue,
            ghost: "no data",
          },
          m2: { label: `${priorName} · full`, value: priorMonthValue, ghost: "no data" },
          fmt: moneyK,
          ariaLabel: `Materials sold ${partial ? "month to date" : monthLong} ${moneyK(totals.current)}${
            priorYearValue != null ? `; ticks mark ${lyName} day-aligned ${moneyK(priorYearValue)}` : ""
          }${priorMonthValue != null ? ` and full ${priorName} ${moneyK(priorMonthValue)}` : ""}`,
        }}
      />
      <CategoryCard model={model} />
    </KpiBand>
  );
}

/* ── Materials Value by Category (the page's primary visualization) ── */

export type CategorySegment = {
  name: string;
  value: number;
  pct: number;
  fill: string;
  light: boolean;
};

/** Top-6 categories + an aggregated "N more categories" remainder, with the
 *  mockup's rank-ordered fills (Special order always warn-tinted). */
export function categorySegments(model: MaterialsReadModel): CategorySegment[] {
  const total = model.categories.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return [];
  const top = model.categories.slice(0, 6);
  const rest = model.categories.slice(6);
  const out: CategorySegment[] = [];
  let rank = 0;
  for (const slice of top) {
    const fill = slice.name === SPECIAL_ORDER_CATEGORY ? SPECIAL_FILL : RANK_FILLS[Math.min(rank, RANK_FILLS.length - 1)];
    if (slice.name !== SPECIAL_ORDER_CATEGORY) rank += 1;
    out.push({
      name: slice.name,
      value: slice.value,
      pct: (slice.value / total) * 100,
      fill,
      light: LIGHT_FILLS.has(fill),
    });
  }
  if (rest.length > 0) {
    const restValue = rest.reduce((sum, slice) => sum + slice.value, 0);
    out.push({
      name: `${rest.length} more ${rest.length === 1 ? "category" : "categories"}`,
      value: restValue,
      pct: (restValue / total) * 100,
      fill: REMAINDER_FILL,
      light: true,
    });
  }
  return out;
}

function CategoryCard({ model }: { model: MaterialsReadModel }) {
  const monthLong = monthLongName(model.periodStart.slice(0, 7));
  const segments = categorySegments(model);
  const barSegments: SegBarSegment[] = segments.map((seg, i) => ({
    width: seg.pct,
    color: seg.fill,
    label: i === 0 ? `${seg.name} · ${Math.round(seg.pct)}%` : undefined,
    labelColor: seg.light ? "var(--ink)" : undefined,
  }));
  return (
    <Card title="Materials Value by Category" subtitle={`${monthLong} · Simpro product groups`}>
      <CardBody>
        <div data-primary-viz="" data-viz="">
          <SegBar tall segments={barSegments} ariaLabel={`Materials value by category, ${monthLong}`} />
          <div className="legend" style={{ marginTop: 10, rowGap: 6, padding: 0 }}>
            {segments.map((seg) => (
              <span key={seg.name}>
                <i className="sw" style={{ background: seg.fill, width: 10, height: 10, borderRadius: 3 }} />
                {seg.name}{" "}
                <b className="tnum" style={{ fontWeight: 600, color: "var(--ink)" }}>
                  {fmt.moneyFull(seg.value)}
                </b>{" "}
                · {seg.pct.toFixed(1)}%
              </span>
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/* ── Row 2: All Materials Sold table ───────────────────── */

export type QtyDelta = { kind: "new" | "zero" | "up" | "down"; text: string };

/** Δ column grammar (approved): "new" for items with no prior-month sales,
 *  red for declines, signed counts otherwise. */
export function qtyDelta(qty: number, priorQty: number): QtyDelta {
  if (priorQty === 0 && qty > 0) return { kind: "new", text: "new" };
  const diff = Math.round((qty - priorQty) * 1000) / 1000;
  if (diff === 0) return { kind: "zero", text: "0" };
  if (diff > 0) return { kind: "up", text: `+${qtyText(diff)}` };
  return { kind: "down", text: `−${qtyText(Math.abs(diff))}` };
}

export function qtyText(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Plain client-side CSV of the full ranked item list. */
export function buildMaterialsCsv(items: MaterialsItemRow[], priorShort: string): string {
  const header = [
    "Item",
    "Part No",
    "Category",
    "Qty",
    `${priorShort} Qty`,
    "Qty Change",
    "Unit Sell",
    "Extended (Ex-Tax)",
    "Jobs",
    "Job IDs",
  ];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of items) {
    lines.push(
      [
        row.name,
        row.partNo ?? "",
        row.category,
        row.qty,
        row.priorMonthQty,
        qtyDelta(row.qty, row.priorMonthQty).text.replace("−", "-"),
        row.unitSell ?? "",
        row.extended,
        row.jobCount,
        row.jobIds.join("; "),
      ]
        .map((value) => csvEscape(String(value)))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function MaterialsTableCard({ model, onOpen }: { model: MaterialsReadModel; onOpen: (row: MaterialsItemRow) => void }) {
  const monthKey = model.periodStart.slice(0, 7);
  const monthLong = monthLongName(monthKey);
  const priorShort = monthShortName(shiftMonthKey(monthKey, -1));
  const [page, setPage] = useState(1);
  const total = model.items.length;
  const totalPages = Math.max(1, Math.ceil(total / CLIENT_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * CLIENT_PAGE_SIZE;
  const visible = model.items.slice(start, start + CLIENT_PAGE_SIZE);

  const downloadCsv = () => {
    const csv = buildMaterialsCsv(model.items, priorShort);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `materials-${monthKey}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <div className="hd" style={{ flexWrap: "wrap" }}>
        <div>
          <div className="ti">All Materials Sold — {monthLong}</div>
          <div className="st">Ordered by total sold value · Δ = qty change vs {priorShort}</div>
        </div>
        <button type="button" className="ctl" style={{ height: 34, fontSize: 13.5 }} onClick={downloadCsv}>
          <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
            <path d="M12 3v12M7 10l5 5 5-5" />
            <path d="M4 19h16" />
          </svg>
          Download CSV
        </button>
      </div>
      <div className="tblwrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th className="hide-sm">Category</th>
              <th className="num">Qty</th>
              <th className="num hide-sm">{priorShort} qty</th>
              <th className="num">Δ</th>
              <th className="num hide-sm">Unit sell</th>
              <th className="num">Extended</th>
              <th className="num hide-lg">Jobs</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const delta = qtyDelta(row.qty, row.priorMonthQty);
              return (
                <tr key={row.key} className="rowlink" onClick={() => onOpen(row)}>
                  <td>
                    <div className="id1">{row.name}</div>
                    <div className="id2">{row.partNo ?? "—"}</div>
                  </td>
                  <td className="hide-sm">{row.category}</td>
                  <td className="num tnum">{qtyText(row.qty)}</td>
                  <td className="num tnum hide-sm">{qtyText(row.priorMonthQty)}</td>
                  <td className="num tnum">
                    {delta.kind === "down" ? (
                      <span style={{ color: "var(--state-failed-fg)" }}>{delta.text}</span>
                    ) : delta.kind === "up" ? (
                      delta.text
                    ) : (
                      <span style={{ color: "var(--muted)" }}>{delta.text}</span>
                    )}
                  </td>
                  <td className="num tnum hide-sm">{row.unitSell != null ? fmt.cents(row.unitSell) : "—"}</td>
                  <td className="num tnum" style={{ fontWeight: 700 }}>
                    {fmt.moneyFull(row.extended)}
                  </td>
                  <td className="num tnum hide-lg">{row.jobCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="foot">
        <span>
          {total === 0
            ? "Showing 0 materials"
            : `Showing ${start + 1}–${start + visible.length} of ${total} by total sold value`}
        </span>
        <span className="pager">
          <button type="button" disabled={safePage === 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
            ‹
          </button>
          {pageList(totalPages, safePage).map((entry, index) =>
            entry === "gap" ? (
              <span key={`gap${index}`} className="gap">
                …
              </span>
            ) : (
              <button
                key={entry}
                type="button"
                className={entry === safePage ? "on" : undefined}
                onClick={() => setPage(entry)}
              >
                {entry}
              </button>
            ),
          )}
          <button
            type="button"
            disabled={safePage === totalPages}
            onClick={() => setPage(safePage + 1)}
            aria-label="Next page"
          >
            ›
          </button>
        </span>
      </div>
    </div>
  );
}

/* ── Drawer: the item's job list ───────────────────────── */

function MaterialDrawerBody({ row, monthKey }: { row: MaterialsItemRow; monthKey: string }) {
  const priorShort = monthShortName(shiftMonthKey(monthKey, -1));
  return (
    <>
      <KV>
        <KVCell label="Qty" value={qtyText(row.qty)} />
        <KVCell label={`${priorShort} qty`} value={qtyText(row.priorMonthQty)} />
        <KVCell label="Unit sell" value={row.unitSell != null ? fmt.cents(row.unitSell) : "—"} />
        <KVCell label="Extended (ex-tax)" value={fmt.moneyFull(row.extended)} />
        {row.partNo != null ? <KVCell label="Part no" value={<span style={{ fontSize: 14 }}>{row.partNo}</span>} /> : null}
        <KVCell label="Category" value={<span style={{ fontSize: 14 }}>{row.category}</span>} />
      </KV>
      <DSec>
        On {row.jobCount} completed {row.jobCount === 1 ? "job" : "jobs"}
      </DSec>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {row.jobIds.map((jobId) => (
          <li key={jobId} style={{ padding: "8px 0", borderBottom: "1px solid var(--hair)" }}>
            <span className="id1">Job {jobId}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
