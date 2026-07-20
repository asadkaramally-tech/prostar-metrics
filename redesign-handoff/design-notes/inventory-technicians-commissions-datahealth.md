# Pro Star Metrics — Feature Inventory: Technicians Route, Commissions Route, Data Health Drawer

Source files:
- `src/app/technicians/page.tsx` (server), `src/components/technicians-dashboard.tsx` (client, 1058 lines)
- `src/app/commissions/page.tsx` (server), `loading.tsx` (server), `error.tsx` (client)
- `src/components/commissions-dashboard.tsx` (client, 1005 lines)
- `src/components/data-health-drawer.tsx` (client, 819 lines)

---

## 1. TECHNICIANS ROUTE (`/technicians`)

### 1.1 Page shell (SERVER, async)
- URL params: `?month=YYYY-MM`, `?technician=<employeeId>`.
- Data: `getDashboardReadModel("technicians", { periodStart })`.
- `DashboardPage`: title "Technician Performance", icon Gauge, description "Technician capacity, deployment, allocated economics, labor efficiency, and punctuality from app-owned Simpro snapshots with explicit coverage.", freshness banner.
- Controls: `<PeriodSelector action="/technicians" hiddenFields={{ technician }} />` — preserves technician param across month changes.
- `selectedMonth` fallback: payload periodStart → URL month → `businessCurrentMonth()`.
- No route-level loading.tsx/error.tsx.

### 1.2 `TechniciansDashboard` (CLIENT)
- Props: `{ model, selectedMonth, selectedTechnicianId? }`.
- Technician filter is **URL-driven**: `router.push(technicianDashboardHref(month, techId))` = `/technicians?month=...&technician=...` (omits when "all").
- `TechniciansDashboardView` validates payload via `getTechnicianPayload` — strict contract: `netProfitBasis === "simpro_job_net_profit_actual"`, technicians array, finite coverage metrics, per-tech contract (`hasDetailedTechnicianContract`, `hasLaborEfficiencySummary` for quoteGenerated AND recurring). Invalid → Unavailable state.

#### Unavailable state
- Red alert (`role="alert"`, AlertTriangle): "Technician metrics unavailable" / "The detailed technician read model is unavailable for the selected period. Capacity, Simpro Job Net Profit, quote-linked efficiency, and recurring efficiency are hidden until a current read model is available." Followed by Warnings block.

### 1.3 Page order (AvailableTechniciansDashboard)
State: `technicianId` (from URL), `expandedTechnicianId` (single scorecard row, reset on filter change).

**(1) Methodology strip** — blue callout (`border-l-4 border-blue-600 bg-blue-50`, TrendingUp): "Recorded-time utilization uses productive job hours over every positive recorded timesheet hour, including non-job and unmapped-reference time. Capacity defaults to Monday-Friday 08:30-17:00 with eight productive hours after lunch and stays separate as leave-adjusted job capacity use."

**(2) Technician filter bar** — `border-y bg-white`: label "TECHNICIAN FILTER" + "N technicians in the selected period" or selected name; `<select>` with UserRound icon, `sr-only` label "Technician"; options "All technicians" + "{displayName} (ID {employeeId})". onChange: set state, collapse expansion, navigate.

**(3) KPI grid** — `md:grid-cols-2 xl:grid-cols-3`, 11 KpiCards:
1. **Completed Job Credit** — "Completed-job cohort; shared by mapped job hours"; Wrench.
2. **Allocated Revenue** — "$X/hr across Yh covered"; Users.
3. **Allocated Gross Profit** — same pattern; WalletCards. (Null → "—".)
4. **Allocated Net Profit** — same; WalletCards.
5. **Recorded-Time Utilization** — "Xh productive / Yh all recorded"; Clock3. *(productive ÷ ALL recorded — "utilization")*
6. **Job Capacity Use** — "Xh job / Yh adjusted capacity"; Gauge. *(job ÷ adjusted capacity — "capacity utilization")*
7. **Field Deployment** — "Job + Travel 45 + Pickup Parts 48 / adjusted capacity"; Wrench.
8. **Quote Labor Efficiency** — "Xh allocated quoted / Yh actual"; Gauge.
9. **Recurring Labor Efficiency** — same; Gauge.
10. **On-Time Arrival** — "N on time / M covered visits"; CalendarClock.
11. **Schedule Variance** — "N/A" when null, else "+X min"/"0 min variance"; "N visits with planned and actual duration"; CalendarClock.

**THREE DISTINCT HOUR-RATIO FAMILIES (never merge):** recorded-time utilization (÷ all recorded hours) / job capacity use & field deployment (÷ leave-adjusted calendar capacity) / labor efficiency (allocated quoted ÷ actual, split quote-generated vs recurring + supplementary crew results).

**(4) Warnings** — yellow callout (`border-l-4 border-yellow-500`), "Coverage notes", bullets.

**(5) Two-col `xl:grid-cols-[1.35fr_1fr]`:**
- **"Allocated Economics"** — horizontal grouped BarChart, first 12 techs, h-80: X compactMoney, Y displayName (width 130); Bars: Allocated revenue `#123a63`, gross profit `#b88900`, net profit `#2f7d5a`, radius [0,3,3,0]; Legend + auto tooltip. Empty: "No technician allocation" / "No mapped, positive job timesheets support the selected completed-job cohort."
- **"Coverage"** — subtitle "Independent source basis for each metric family". Divided list of 10 rows (label, detail, right value green-700 ok / yellow-800 not): Completed-job allocation, Allocated revenue, Allocated gross profit, Allocated net profit, Recorded-time utilization, Adjusted capacity, Working-time coverage, Labor efficiency, Schedule blocks, Verified mobile coverage. (Details include exact exclusion counts/hours.)

**(6) Two-col `xl:grid-cols-2`:**
- **"Capacity Use"** — horizontal stacked BarChart (12 techs, h-72), X "{v}h". Stack: Job `#123a63`, Travel `#2673a5`, Pickup parts `#b88900`, Support `#64748b`, Unrecorded `#d7dce2`; separate bar Overtime `#b24b3b`. Empty: "No hours metrics".
- **"Punctuality Distribution"** — subtitle "{covered}/{scheduled} visits have verified arrival coverage". BarChart buckets Early / On time / 1-15 / 16-30 / 30+ ("Covered visits" `#2673a5`). Empty: "No covered arrivals" / "Unverified or missing arrivals remain uncovered and do not enter a punctuality bucket."

**(7) Two-col trends:**
- **"Capacity vs Demand Trend"** — LineChart (needs history>1): Adjusted capacity `#123a63`, Working demand `#b24b3b`, 2.25px, connectNulls false, Y "{v}h". Empty: "No earlier monthly history" / "...prior technician read models must be rebuilt with the current formula contract...". Below (if history): **HistoryReconciliationRows** table (min-w-620, xs): Month | Status (colored, `title` = reconciliationDetail) | Source/served count | value | hours (`formatPair`, "N/A").
- **"Travel and Parts Trend"** — LineChart: Travel `#2673a5`, Pickup parts `#b88900`. Empty variant.

**(8) "Technician-Month Heatmap"** — subtitle "Recorded-time utilization = productive job hours / all recorded timesheet hours". Table (min-w-760): row/tech, col/month. Cell `h-14 min-w-24`, bg `heatmapColor`: null `#f1f5f9`, >100% `#fee2e2`, ≥75% `#dcfce7`, ≥50% `#fef3c7`, else `#e0f2fe`; percent + tiny uppercase reconciliation word; `title` tooltip with full detail. Empty: "No recorded-time history".

**(9) "Labor Efficiency"** — subtitle "Quote-generated and recurring results stay separate; crew quoted hours are allocated by each technician's actual-hour share".
- Per-tech table (min-w-820): Technician | Quote jobs | Quote hours ("quoted / actual") | Quote efficiency | Recurring jobs | Recurring hours | Recurring efficiency.
- "**Multi-technician crew results**" table (min-w-720): Job | Source | Crew | Quoted | Actual | Efficiency. Empty: "No covered multi-technician labor-efficiency jobs."

**(10) "Technician Scorecard"** — subtitle "Names come from the people dimension; Simpro employee ID is secondary".
- Table min-w-1560. Columns: Technician + Job Credit, Allocated Revenue, Allocated Gross Profit, Allocated Net Profit, Job Hours, Recorded Utilization, Job Capacity Use, Field Deployment, Quote Efficiency, Recurring Efficiency, On-Time.
- Row header = expand button (`aria-expanded`, ChevronRight/Down): name; "Employee ID {id}"; provenance "Simpro availability" vs "Default Mon-Fri availability", optional "| hired {date}", "| archived evidence; no termination date supplied".
- NumericCell = value + xs detail (e.g. "Xh / Yh adjusted", "a/b covered; c uncovered", "N allocated jobs").
- Empty: "No technician scorecard rows are available." (colSpan 12).
- **Expanded drilldown** (colSpan 12, surface-soft) → two DetailTables:
  - "Completed-job allocations": Job | Hours / Share | Allocated revenue | gross | net | Labor efficiency (quoted hours or "Uncovered"; "Crew allocation" sub-label). Empty: "No allocation records."
  - "Scheduled visits": Job / Planned | Arrival | Completion | Result ("On time"/"Late"/"Uncovered"; variances shown). Empty: "No normalized schedule blocks."

### 1.4 Formatting
- formatMoney/Number/Hours/Percent → **"—"** for null (Schedule Variance KPI + formatPair use "N/A").
- compactMoney "$X.XM"/"$XK". Dates UTC; datetimes America/Los_Angeles.
- Test exports: `TechniciansDashboardView`, `technicianDashboardHref`, `punctualityChartRows`.

---

## 2. COMMISSIONS ROUTE (`/commissions`)

### 2.1 Page shell (SERVER)
- **Access gate**: requires admin or finance role, else `notFound()`.
- URL params: `?year=`, `?month=` (int or YYYY-MM), `?summaryYear=`; defaults today.
- `getCommissionDashboardReadModel({ year, month, summaryYear })`.
- `DashboardPage`: "Technician Commissions", ReceiptText, description "Monthly worksheet, ranked bonus allocation, summary views, audited overrides, immutable calculation runs, and payroll exports." No `controls`. `accessWarning={null}`.

### 2.2 loading.tsx — `role="status" aria-busy aria-label="Loading commission dashboard"`; icon tile + pulsing bars; h-20 controls bar, 6 KPI skeletons (xl:grid-cols-6, h-28), two h-80 panels.

### 2.3 error.tsx — red `role="alert"`: "Commission dashboard could not load" / "The commission period or annual summary request failed before the dashboard could render."; Retry (RotateCcw, bg-red-700) → `reset()`.

### 2.4 `CommissionsDashboard` (CLIENT)
- State: `summaryView` (monthly|quarterly|annual), `actionState` (idle|running|done|error + message).
- Permissions: `canWrite = !accessWarning && Boolean(worksheet.periodId)`; `canExport = canWrite && worksheet.exportGate.allowed`; `exportBlockReason` = accessWarning ?? "No commission period revision is loaded." ?? exportGate.reasons.join(" ").
- **Mutations** (fetch POST + reload):
  - `runAction(path, body, successMessage)`; on `queued === true` polls GET `/api/commissions?year&month` every 1s ≤60× until `calculationStale === false` && runId changed; timeout: "The rebuild is still queued. Reload after the worker finishes."; then reload.
  - `exportRun(type)` → POST `/api/commissions/exports` `{ periodStart, expectedRevision: editRevision, exportType }`; blob download from content-disposition; "Export ready."; payroll_csv reloads after 350ms.
  - Endpoints: `/api/commissions/rebuild`, `/lifecycle`, `/config`, `/overrides`, `/exports` (POST + GET ?id=), `/api/commissions` (poll). All carry periodStart + expectedRevision.

#### Not-ready branch (`servingStatus !== "ready"`)
Access warning → PeriodControls → **CommissionUnavailableState** → SummarySection → contract gaps (neutral StatusMessages).
- UnavailableState: amber (building, RefreshCw, "Commission data is building") or red (AlertTriangle, "Commission data is unavailable"), `aria-live="polite"`; servingMessage; `<dl>`: Period, Period status, Run status (or "No run"), Freshness; freshness detail; monospace `servingCode`.

#### Ready branch order
**(1) Access warning** (red box).

**(2) CommissionPeriodControls** — GET form `/commissions`: Year number (2023–2100), Month select (12 names), hidden summaryYear, "**Load Month**" submit.

**(3) Warnings** — StatusMessages amber.

**(4) KPI row** (xl:grid-cols-6): Completed Jobs ("N supported"; Wrench) | Excluded Jobs (subtitle = excluded work value; AlertTriangle) | Work Value ("Full completed cohort"; FileSpreadsheet) | Commission Pool ("X.XX%"; Trophy) | Active Techs ("N zero commission due"; Users) | Calculated Commission Due ("$X outside-pool adjustments"; BadgeCheck).

**(5) Worksheet header/lifecycle panel**:
- H2 "{periodLabel} Worksheet" + **StatusBadge** + chip "Revision {n|N/A} | Edit {editRevision} | Run {runId|N/A}" + optional "**Protected**" chip (ShieldCheck).
- Meta: "Source complete|incomplete | Rebuild pending|Current run | Manifest {hash12|N/A}".
- **CommandButtons** (bordered white, brand icon, disabled:opacity-40 cursor-not-allowed):
  - **Rebuild** (RefreshCw) — disabled `!canWrite || running`. Reason: "Authorized monthly commission rebuild." Success "Rebuild queued."
  - **Review** (Check) — disabled `!canWrite || status!=="draft" || calculationStale || !sourceComplete || running`. Success "Revision reviewed."
  - **Lock** (LockKeyhole) — disabled `!canWrite || status!=="exported" || running`. Success "Revision locked."
  - Lifecycle: draft → reviewed → exported → locked.
- Status line `role="status"`, min-h-5 reserved.

**(6) "Period Configuration"** (CommissionConfigEditor) — subtitle "{periodLabel} | $X work value". POST `/api/commissions/config`; success "Config saved; rebuild queued.":
- Pool percent select (16 options 0.25–1.00 step .05); Minimum percent number (0–100 step .25); Efficiency adjustment checkbox + "+/-{max}%" readout + range slider (5–50, aria-label); Tier multipliers fieldset Gold/Silver/Bronze/Standard (0.01–10 step .01, "x" suffix, aria-labels); **Change reason** (required, 5–1000); **Save Config** (Save icon). All disabled when `!canWrite || busy`.

**(7) "Roster Inclusion"** (RosterInclusionEditor) — subtitle "N roster and mapped-work rows | M calculation rows". Table min-w-1260:
- Technician | Employee | Calculation row ("Included"/"No row") | Allocated | Effective | Hours / jobs | Inclusion select (aria-label "{name} roster inclusion") | Reason (required 5–1000, aria-label) | Evidence URL | Save (disabled when `!canWrite || busy` or unchanged). POST `/overrides` `{ field: "included", ... }`; success "{name} inclusion saved; rebuild queued." Empty: "No roster or mapped-work rows".

**(8) Two-col `xl:grid-cols-[1fr_1.35fr]`:**
- **"Commission Due By Technician"** — subtitle "$A inside pool | $B outside | $C calculated due". Horizontal BarChart h-80 of finalBonus; per-Cell tierColor (Gold `#a87800`, Silver `#64748b`, Bronze `#9a5528`, Standard `#123a63`). Empty: "No immutable technician results".
- **"Ranked Leaderboard"** — subtitle "N eligible technicians". Native `<details>` rows:
  - Summary: **RankIcon** (top 3 Medal gold `#b88900`/silver `#64748b`/bronze `#a65d2d`, aria-label "Rank N"; else numbered circle) | name | **TierBadge** (18% alpha bg) | optional red "Below min" | optional LockKeyhole aria-label "Final bonus locked" | pool-share progress bar | finalBonus + "X% of pool".
  - Body: 10 Metric tiles (Allocated work; Effective work; Base / raw; Forfeited; Reallocated; Efficiency effect; Inside / redistribution; Inside final bonus; Outside adjustment; Calculated commission due).
  - **AllocationTable** (min-w-780): Job | Customer | Job value | Tech hours | Job hours | Share | Allocated. Empty: "No job allocations".
  - **CommissionOverrideEditor** per tech (own ActionState, reload after 350ms): Field select (Included / Allocated value / Tier / Inside adjustment / Outside adjustment / Final bonus lock / Notes → `included, allocated_value, tier, inside_pool_adjustment, outside_pool_adjustment, final_bonus, notes`); Value control typed by field (bool select / tier select / text / number step .01); Reason (5–1000) + Evidence URL; Save; `role="status"` line. POST `/overrides`.

**(9) "Efficiency"** (EfficiencyPanel) — subtitle "Enabled|Disabled | maximum +/-X%".
- Quote-labor coverage header: status badge (red loading|error|missing/unavailable, emerald complete, else blue) + "Quote labor required|not required"; `<dl>` 5 counts (Quote jobs, With labor rows, Qualifying, No qualifying work, Labor rows); red "Incomplete jobs: {ids}" when present; missing coverage → synthesized "Unavailable".
- Table (min-w-900): Technician | Quote jobs | Quoted hours | Actual hours | Ratio ("X.XXXx"|"N/A") | Multiplier | Percent effect | Dollar effect | Coverage.

**(10) Two-col:**
- **"Exports"** — subtitle "N retained artifacts across all period revisions and runs".
  - Buttons (disabled `!canExport || running`): **Payroll CSV** (FileSpreadsheet), **Worksheet PDF** (Download), **Detail CSV** (FileClock) → `payroll_csv/worksheet_pdf/calculation_detail_csv`. `aria-describedby="commission-export-block-reason"` when blocked; amber `role="status"`: "Exports unavailable: {reason}".
  - Disclaimer: "The Payroll CSV contains approved calculated commission amounts for payroll processing. Generating or downloading it does not confirm that payment was made."
  - **ExportHistory** table (min-w-1100): Type | Period revision ("Rev n" + "Period id") | Run (runId + "Run rev n") | Hashes (two `<code>` "File {hash12}"/"Calc {hash12}", full SHA in title) | Actor | Created | Status (opt ShieldCheck "Protected artifact") | Downloads | File (link `/api/commissions/exports?id=` with Download icon when downloadable, else muted + "Unavailable"). Empty: "No retained exports".
- **"Revision History"** — table (min-w-560): Revision ("{revision}.{editRevision}") | Status (StatusBadge) | Run (or "N/A") | Exports | Created.

**(11) "Audit History"** — subtitle "N commission events". Table (min-w-1180): Timestamp | Action | Actor | Entity | Before | After (`<code>` whitespace-pre-wrap via **formatAuditValue**: `[REDACTED]` for password/secret/token/authorization/cookie/credential/api-key keys, `[Circular]`, BigInt→string, 1200-char truncation) | Reason (or "N/A"). Empty: "No audit events".

**(12) Commission Summary section** — `border-t-2 border-[brand] pt-6`:
- H2 "Commission Summary"; "n/12 finalized months | X% loaded; draft runs are detail only".
- Summary year GET form (hidden year+month; number input 2023–2100; "Load").
- View toggle `role="group" aria-label="Summary view"`: monthly/quarterly/annual (active brand bg). Client-only state.
- Green progress bar (progressPercent).
- 4 Metric tiles: Annual pool | Average loaded month | Peak month ("label | $X") | Distinct active techs — "N/A" when null.
- **"Team Totals"** (SummaryTeamTable) — "a/b periods finalized; draft rows are excluded from the footer". Table min-w-860: Period | Status | Pool | Calculated due | Work value | Jobs | Supported / excluded | Active techs | Reconciles (Yes/No/N/A). `<tfoot>` "Team total" (finalized only; Active techs "N/A"; Reconciles "Yes" iff all).
- **Per-period technician tables** — one `<details>` per period, default-open only annual (`expectedMonths === 12`): "{label} Technician Totals" + "loaded/expected months". Table min-w-820: Rank | Technician | Jobs | Work value | Final bonus | Calculated due | Average | **Trend** (Sparkline: 32px div-bar micro-chart, brand bars, 2px slate stubs for null, aria-label = joined values). tfoot totals; Trend footer "Reconciled"/"Mismatch". Empty: "No finalized technician data".
- StatusMessages neutral for summary.diagnostics.

**(13) "Diagnostics"** (conditional) — "N run messages"; "{code}: {message}" chips.

**(14) Data contract gaps** — StatusMessages neutral.

### 2.5 Badges/status
- **StatusBadge**: draft amber; reviewed blue; exported emerald; locked slate; revised fuchsia; mixed cyan; missing red (fallback). Bordered pill, capitalized, xs.
- **TierBadge**: tier color text + hex-alpha-18 bg. "Below min" red badge; LockKeyhole locked icon; ShieldCheck protected chips.
- N/A: nullableMoney/Number → "N/A"; shortHash(null) "N/A"; ratio "N/A".
- Test exports: `buildTechnicianBonusChartRows`, `buildTechnicianBonusPresentation`, `buildRosterInclusionRows`, `buildCommissionConfigPayload`, `formatAuditValue`, `buildQuoteLaborCoveragePresentation`.
- Intl formats: money 2dp USD, compactMoney compact 1dp, number ≤2dp, percent 1dp. Datetimes LA.

---

## 3. DATA HEALTH DRAWER (CLIENT)

### 3.1 Contract
- Props union: `{state:"loading"}` | `{state:"error"; message}` | `{state:"ready"; model}`.
- State: open, workRequests, workRequestsLoading, workRequestsError, workNotice, workSubmitting. Refs closeButtonRef/triggerRef. useId panel id.

### 3.2 Triggers (both focus-ring, aria-expanded, aria-controls)
- **Desktop** (hidden lg:flex, fixed `bottom-[76px] left-3`, 232px): Activity icon, "Data health", chip "Loading"/"Unavailable"/"N active"/"Healthy" tinted by statusTone (healthy green, attention amber, critical red).
- **Mobile** (lg:hidden, fixed `right-4 top-3`, 9×9): Activity icon, aria-label "Data health: {status}", dot indicator (red critical / amber attention).

### 3.3 Drawer behavior
- Overlay fixed inset-0 z-50; backdrop `<button>` bg-slate-950/35 aria-label "Close data health" tabIndex -1.
- Panel: right `<aside role="dialog" aria-modal aria-labelledby>`, max-w-430, full height, scrollable.
- Open: body scroll lock, focus close button, Escape closes, focus returns to trigger.
- Header: Activity tile, h2 "Data health", status chip ("attention" → "Needs attention"), "Checked {timestamp}" (LA + tz name); close X.
- Loading: spinning RefreshCw "Loading operational state" / "Reading the latest app-owned evidence." Error: AlertTriangle "Data health is unavailable" + message.

### 3.4 Fetching
- On open: GET `/api/data-refresh` (no-store) → {requests}; **polls every 5s while open**; error "Unable to load refresh queue status."
- `submitBoundedWork`: POST `/api/data-refresh`; prepend (dedup by requestId, cap 20); notice "Bounded work queued." / duplicate "Matching work is already active or complete." / error "Unable to enqueue bounded source work."

### 3.5 Ready content (DrawerSections: slate header bar + icon + h3 + count)
1. **Summary strip** (3-col): Queued / Failed / Dead-letter.
2. **"Latest alerts"** (ShieldAlert): AlertRow — critical CircleAlert red / else AlertTriangle amber, title, timestamp, detail. Empty: green CheckCircle2 "No active data-health alerts".
3. **"Pipeline queues"** (Layers3): 2-col cards per queue kind — kind, "N running", big queued count, "{age} oldest" (formatAge Xd Yh / Xh Ym / Xm) or "No queued work". Empty: "Queue telemetry is empty".
4. **"Bounded refresh"** (ListRestart): **BoundedWorkControls form** — Mode toggle `role="group" aria-label="Refresh mode"` aria-pressed: **Record** (entity_refresh) vs **Period** (period_backfill). Record: Type select (Quote/Job/Employee/Schedule) + Simpro ID (number ≥1 required). Period: Source select (quotes, quote_nested, jobs, job_nested, employees, timesheets, jobs_from_timesheets, schedules, mobile_status); Start/End month (type=month, min 2023-01, max current Pacific month). Reason (required 5–500). Submit full-width brand "Queue refresh"/"Queueing" (RefreshCw spins). Notice green / error red / loading spinner. **BoundedWorkRow** list: targetLabel; "Record refresh" or "N source-month(s)" + "; duplicate"; status colored (succeeded green, failed red, running blue); "{timestamp} by {requestedBy}". Empty: "No bounded refresh requests".
5. **"Failed work"** (CircleAlert): "{Source} #{id}" + "Dead-letter" (red) vs "Failed" (amber); error text or "{Kind} work failed" + timestamp. Empty: green "No unresolved failed work".
6. **"Page freshness"** (Gauge): per page — pageLabel ("technicians"→"Technician Performance", "commissions"→"Technician Commissions", else "{Title} Metrics"); **state pill** pageTone: current green / partial amber / building blue / stale yellow / suspect orange / failed red / missing slate; "X% source coverage" or "Coverage pending" + "Through {timestamp}" or "No data-through watermark"; optional "Core a/b; secondary c/d".
7. **"Profit and capacity contract"** (Database): ContractCount rows — Completed jobs, Active completed cost centers, People capacity; "{missing}/{total} missing" (amber) or "{total}/{total} complete" (green).
8. **"Source watermarks"** (Database): Title-cased sourceFamily; "Gap" or status (red when gap/failed); windowKey + "Through {ts}" or "No committed watermark". Empty: "No source watermarks recorded".
9. **"Reconciliation"** (RefreshCw): scope; green "Matched" vs red; driftLabel "+N count; +$X value" or "No numeric drift evidence"; checkedAt or "Not checked". Empty: "No reconciliation results recorded".
10. **"Historical backfill"** (Clock3): big percent, "{Mon YYYY} to {Mon YYYY}", "a/b months complete"; progress bar `role="progressbar"` aria-valuemin/max/now, green fill; "x/y required source-months" + "n months missing plan coverage".

---

## 4. Cross-cutting patterns

### 4.1 Client/server split
- Server: page.tsx files, loading.tsx, DashboardPage, KpiCard, PeriodSelector (GET forms, zero JS).
- Client: three big dashboards + drawer + commissions/error.tsx.
- Mutations: plain fetch POST to `/api/*`, then reload (immediate / 350ms / after rebuild poll 60×1s). Period selection native GET forms; technicians filter router.push.
- Drawer polls every 5s while open; commissions polls after queued rebuild.

### 4.2 Tokens/styling
- Panel idiom `rounded-md border bg-white` (tech Panel bordered header strip + p-4 body; commissions Panel single p-4, mb-4 header).
- Semantic tints: red (errors), amber/yellow (warnings/draft), emerald/green (success/exported), blue (info/reviewed/building), slate (neutral/locked), fuchsia (revised), cyan (mixed), orange (suspect).
- Chart hexes: `#123a63 #2673a5 #b88900 #2f7d5a #64748b #b24b3b #d7dce2`; heatmap `#f1f5f9/#fee2e2/#dcfce7/#fef3c7/#e0f2fe`; tiers `#a87800/#64748b/#9a5528/#123a63`; medals `#b88900/#64748b/#a65d2d`.
- Numeric: `tabular-nums text-right`; wide tables min-w 1560/1260/1180/1100/900/860/820/780/760/720/620/560 in overflow-x-auto; `[overflow-wrap:anywhere]`; charts fixed h-72/h-80.
- Controls: h-9/h-10, rounded-md border, brand-filled primaries, disabled:opacity-40/50/60 (+cursor-not-allowed CommandButton), `accent-[--brand]` checkbox/range, animate-pulse/animate-spin.

### 4.3 Accessibility
role=alert/status, aria-live=polite, aria-busy, role=dialog aria-modal + focus management (focus close on open, restore on close, Escape, scroll lock), role=progressbar with values, role=group + aria-pressed (drawer mode) / aria-label (summary view), aria-expanded/aria-controls, aria-describedby (export block), sr-only labels, aria-label on icon-only (medals, locks, shields, sparkline, tier inputs, roster inputs, slider), aria-hidden decorative icons, title tooltips (heatmap, reconciliation, hashes, expanders), focus-ring in drawer.

### 4.4 Empty/N-A catalog (verbatim)
- Technicians: "No technician allocation", "No hours metrics", "No covered arrivals", "No earlier monthly history" (×2), "No recorded-time history", "No technician scorecard rows are available.", "No allocation records.", "No normalized schedule blocks.", "No covered multi-technician labor-efficiency jobs.", "Uncovered", "—", "N/A".
- Commissions: "No immutable technician results" (×2), "No roster or mapped-work rows", "No job allocations", "No retained exports", "No audit events", "No finalized technician data", "Unavailable", "N/A".
- Data health: "No active data-health alerts", "Queue telemetry is empty", "No bounded refresh requests", "No unresolved failed work", "No source watermarks recorded", "No reconciliation results recorded", "Coverage pending", "No data-through watermark", "No committed watermark", "Not checked", "No numeric drift evidence", "No queued work", "Unknown time".
