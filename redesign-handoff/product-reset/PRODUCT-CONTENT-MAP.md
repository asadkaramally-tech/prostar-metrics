# Product Content Map — Pro Star Metrics Dashboard Reset

Prepared: 2026-07-14. Every element proposed for the redesigned product is listed here with the owner
question it answers, its exact cohort/formula, its data source, and the action it enables. Anything on
the current screens that does not appear in a "Keep" table below is removed from the owner-facing
product (removal inventory at the end). Sources: takeover brief (authority), implementation-plan
extraction (formulas), current-code audit (read models), prior dashboards (feature reference),
full-page browser evidence (current-state inventory), and read-only Simpro verification performed
2026-07-14.

Verified facts referenced throughout:

- June 2026 completed cohort (CompletedDate in month + Stage Complete/Archived): **272 jobs,
  $435,979 sell, $291,641 gross (66.9%), $211,534 net (48.5%)**; bridge $435,979 − $88,941 materials
  − $55,397 labor − $80,108 overhead = $211,534 (reconciles exactly; verified from evidence CSV).
- June 2026 quote cohort (DateApproved in month, non-excluded): **189 quotes, $2,152,685; 43 accepted
  ($189,074) = 22.8% by count, 8.8% by value** (CSV cross-matches a fresh Simpro pull to the cent).
- Effective technician roster verified directly from Simpro employees (position + archived + hire date):
  **8 active Service Technicians + 1 Apprentice**; edge cases flagged for owner decision (see
  MOCKUP-DECISIONS.md): Stephen Furtado (Technical & Projects Manager, 19.5 June field hours),
  Piel Sarmiento (Warehouse Associate, hired 2026-06-22, 19.5 June hours), Victor Contreras
  (archived, 1 June job), Roberto Villalta (active tech, 8.5 June hours).
- June 2026 recorded time pulled read-only from Simpro per technician (e.g. team job hours ≈ 947 of
  ≈ 1,602 recorded hours across the 9-person roster; Juan Serrato 252 recorded hours vs ≈ 168h
  default capacity).

## Global composition (all five screens)

| Owner question | Metric/visual | Exact cohort/formula | Source/read model | Owner action or decision | Keep/remove rationale |
|---|---|---|---|---|---|
| Which period am I looking at, and is the data trustworthy? | Compact header: page title, month picker, quiet freshness pill ("Updated 12 min ago") | Selected local month (America/Los_Angeles, inclusive start/exclusive next-month start); freshness from per-page state | `metrics.metrics_freshness` via `getPageFreshness` | Change month; open compact data-health drawer if state ≠ current | Keep — required orientation. Freshness is one pill + relative time, never "Live" when stale |
| Is anything wrong with the data behind this page? | Single compact data-health entry point (pill click → small drawer listing per-source freshness in business language) | Page-level source states only | Freshness read model (existing) | Investigate/notify | Keep, minimized — replaces coverage banners, contract-gap lists, reconciliation tables in the primary flow |
| — | Dark navigation rail (Quotes, Jobs, Technicians, Commissions) | — | — | Navigate | Keep — four required surfaces, design-package rail spec |

The first viewport of every page = hero + KPI cluster + first primary visualization. No notices,
methodology, coverage prose, or configuration above the fold.

## 1. Quote Metrics

Owner questions (from brief §8): how many quotes and worth what; share accepted by count and value;
improving or declining; which deal sizes perform; which large Not Accepted quotes deserve attention.

| Owner question | Metric/visual | Exact cohort/formula | Source/read model | Owner action or decision | Keep/remove rationale |
|---|---|---|---|---|---|
| What share of quotes was accepted? | Hero: count acceptance rate for selected month (Jun: 22.8%) with delta vs prior month (−10.5 pts) and prior year, plus 12-mo sparkline | Accepted / (Accepted + Not Accepted), non-excluded quotes with DateApproved in month. Accepted = verified "Accepted Online" status OR exact conversion evidence (LinkedJobID / exact numeric JobNo / live job ConvertedFrom.Type=Quote + ID). Zero denominator → N/A | `buildQuoteMetricsReadModel` → `acceptanceSummary`, `currentMonth`, `priorMonth`, `priorYearSameMonth` | If falling, drill into tiers and largest open quotes | Keep — the page's core question, one treatment |
| How many quotes were sent and what were they worth? | Hero context stats: Quotes sent 189 · Quote value $2.15M | Count/sum of non-excluded DateApproved cohort | Same read model (`currentMonth`) | Volume vs conversion diagnosis | Keep — context inside hero, not a separate duplicate row |
| How much value did we win, and per deal? | KPI cluster: Accepted value $189,074 · Value acceptance 8.8% · Avg accepted deal $4,397 | Accepted value = Σ quote total where accepted; value rate = accepted value / activity value; avg = accepted value / accepted count | `acceptanceSummary` | Spot count-vs-value divergence (big deals not closing) | Keep — value acceptance ≠ count acceptance is June's actual story (22.8% vs 8.8%) |
| Is acceptance improving or declining? | Acceptance trend chart, count/value mode toggle: monthly rate + 3-mo rolling + trailing-12 aggregate reference line | Monthly aggregate ratios (Σaccepted/Σactivity, never averaged percentages); trailing-12 excludes partial current month | `trends[]` (3/12-mo aggregates) | Investigate inflection months | Keep — one trend chart with a mode switch replaces the current four duplicate trend/stacked panels |
| Which deal sizes perform best? | Tier panel: volume by tier (count + value bars) and acceptance rate by tier for selected month | Tiers: Under $750 / $750–$2K / $2K–$10K / $10K+ (750 ≤ v < 2000 ≤ v < 10000 ≤ v). Jun real: 13/44/91/41 quotes; acceptance 38.5%/25.0%/25.3%/9.8% | `acceptanceByTier[]` | Pricing/pursuit strategy by segment | Keep — answers "where do we win" |
| Has tier performance shifted over the year? | Tier × month acceptance heatmap (12 complete months, full month labels) | Same aggregate ratio per tier-month; empty cell = no quotes (—, never 0%) | `heatmap[]` | Spot structural shifts (e.g. $10K+ stuck under 10%) | Keep — genuinely compact treatment of 48 data points |
| Which large Not Accepted quotes deserve attention? | Bounded "Largest not accepted" table (top 8) with row → drawer (quote detail, site, days since approval) | Non-excluded, classified Not Accepted, DateApproved in selected month, ordered by value desc, limit 8. Jun real: Hotel Lulu $323,087 / Best Western #259 $178,438 / Park Plaza HOA $114,218… | `largestNotAccepted[]` | Follow up on specific quotes — the page's primary action | Keep — bounded, actionable; replaces the 189-row evidence table |
| How does this month compare in context? | History tab (secondary): monthly breakdown table, 12 complete months, bounded | Same monthly aggregates as trend | `monthlyBreakdown[]` | Reference/export-free lookup | Keep behind a tab — carry-forward of prior dashboard's monthly breakdown without a permanent full-width stack |
| Is the current month on pace? (partial months only) | One-line pace note inside hero ("Day 14 of 31 — on pace for ~180 quotes") shown only when selected month = current partial month | pace = count/elapsed_days × days_in_month; same-day prior-year comparison per locked rules | `provisional{}` | Calibrate mid-month expectations | Keep, conditional — mathematically honest and clearly labeled, per brief |

Category acceptance (HVAC / Water Heating) is folded into the tier panel as a secondary mode rather
than a separate table; Unclassified counts surface in the data-health drawer, not as a KPI.

## 2. Job Metrics

Owner questions: revenue/gross/net from completed work; is profit improving and what explains
revenue→gross→net; which jobs/categories/sites create or destroy profit; where is estimated labor
exceeded.

| Owner question | Metric/visual | Exact cohort/formula | Source/read model | Owner action or decision | Keep/remove rationale |
|---|---|---|---|---|---|
| How much net profit did completed work produce? | Hero: Net profit $211,534 · 48.5% net margin · +49.4% vs May, sparkline | Completed cohort = CompletedDate in month AND lower(Stage) ∈ {complete, archived}. Never Job Status; Invoiced is not completion. Net = Σ Simpro NetProfit Actual | `buildJobMetricsDashboard` → `selected` | The page's headline; drill anywhere below | Keep — brief mandates net-profit prominence |
| What supports the headline? | KPI cluster: Revenue $435,979 (+62.2%) · Gross profit $291,641 (66.9%) · Completed jobs 272 (+33.3%) · Avg job value $1,603 | Σ validated Total ex-tax; Σ GrossProfit Actual; count; sell/count | `selected`, `comparisons[]` | Compare vs prior month/year via inline deltas | Keep — deltas live on the KPIs; the separate 8×5 comparison grid is removed |
| Is profit improving over time? | Revenue/Gross/Net trend, 18 months, with value/margin mode toggle | Monthly completed-cohort aggregates (real Jan-25→Jun-26 revenue verified against Simpro: e.g. Dec-25 $903,875 spike, May-26 $268,869 trough) | `trends[]` | Spot trajectory and seasonality | Keep — one chart, net line accented |
| What explains the gap between revenue and net? | Gross-to-net bridge (waterfall): $435,979 − $88,941 materials − $55,397 labor − $80,108 overhead = $211,534 | Component sums from validated actual cost fields; rendered only where components reconcile to net (June reconciles exactly) | `selected.profitBridge` | Cost-lever identification | Keep — best chart on the current page, promoted |
| Which kinds of work make or lose money? | Work-source profitability: Quote-generated / Recurring / Direct service (June: $348,992 @ 57.1% NM / $36,501 @ 39.6% / $50,486 @ **−4.0% NM**) | Cohort split by work source; NM = net/sell per source | `jobSourceRows[]` | Pricing policy on direct service calls (see decision Q4) | Keep — currently buried at y≈5,000px; this is a first-screen insight |
| Where is estimated labor being exceeded? | Quoted vs actual labor panel, quote-linked and recurring modes (June quote-linked: 602 quoted vs 699 actual = +16%) | Quote-sourced jobs with documented quoted hours; aggregate variance = (Σactual − Σquoted)/Σquoted, never averaged job percentages; labeled "Labor hours variance", never "accuracy" | `selected.labor`, `laborAccuracy` | Investigate chronic overruns | Keep |
| Which jobs are losing money? | Loss exception view: histogram of net margin + bounded top-loss table (June: 111 jobs below zero, −$25,866 total) with row drawer | Completed cohort, net < 0, ordered by loss desc, bounded | `netMarginDistribution[]`, `lossRecords[]` | Chase specific jobs; question service-call pricing | Keep — genuinely actionable exception view |
| Which categories and sites drive profit? | Top-N profitability chart with Category/Site mode switch (June sites: Holiday Inn Express #1955 $64,478 sell … ; categories: Water Heating $388,628 / HVAC $24,662 / Unclassified $22,689) | Additive cost-center contribution for categories; site = job site rollup. Top 8 + "everything else" | `categoryRows[]`, `siteRows[]` | Client and service-line strategy | Keep — mode switch replaces three stacked tables. Customer table removed until Customer field has coverage (currently 0%) |
| Which specific jobs made up the month? | Bounded completed-job drilldown (top 10 by sell, filters: category/source/technician; row → drawer with full job economics) | Completed cohort with active filters; drawer holds detail that used to be columns | `records[]` + filters | Record-level verification | Keep, bounded — replaces the 272-row × 6-page wide table |

## 3. Technician Performance

Owner questions: who was actually on the roster; capacity used productively; over/under capacity or
under-recording; efficient on quoted/recurring work; on time; contributing profitable work on an
understandable cohort.

Cohort rules for the whole page (fixes confirmed defects 1–7): the displayed population is the
**effective technician roster** (Simpro position = Service Technician/Apprentice, not archived in
month, hire date ≤ month end — plus owner-approved inclusions), never "anyone with a timesheet."
Selected-month work metrics use timesheets whose own work date is in the month. Completed-job
economics use the separate completed-cohort allocation and are always labeled as such.

| Owner question | Metric/visual | Exact cohort/formula | Source/read model | Owner action or decision | Keep/remove rationale |
|---|---|---|---|---|---|
| How much of our capacity produced billable work? | Hero: team productive utilization (June ≈ 59%) with recorded vs available capacity context (≈1,602h recorded / ≈1,512h available) | Productive utilization = job-assigned timesheet hours / all recorded hours, work_date in month, roster only. Capacity = Mon–Fri 8:30–17:00 − 30min lunch = 8h/day default, adjusted by verified Simpro availability/leave and hire date | Rebuilt technician read model (existing calc functions, corrected population) | Staffing and booking decisions | Keep — replaces "Allocated Net Profit" hero, which duplicated the Jobs hero on a misleading cohort |
| Who is over/under capacity or under-recording? | Per-tech capacity bar chart: job / travel+parts / support / unrecorded segments vs capacity line (June real: Serrato 252h recorded vs 168h capacity; Villalta 8.5h) | Segment split from timesheet schedule types; unrecorded = capacity − recorded (floor 0); over-capacity flagged | `calculateTechnicianCapacity` (with archived/hire gates fixed) | Balance workload; chase missing timesheets | Keep — the core visual |
| Who completes quoted/recurring work efficiently? | Labor-efficiency panel, quote-linked / recurring modes, per tech (June quote-linked ratios ≈ 0.88–1.18) | Ratio = allocated quoted hours / actual hours on qualifying jobs (both > 0); no ratio → shown as no coverage, not 1.0 | `laborEfficiency{}` | Coaching, quoting calibration | Keep |
| Who arrives on time? | Punctuality distribution (early / ≤15 min / 16–30 / 30+ / uncovered) + per-tech on-time rate where covered | On-time = arrival ≤ planned start + 15 min, verified mobile events matched by employee+job before time proximity; missing events = uncovered, never late | `punctuality`, `visits[]` | Dispatch/customer-promise management | Keep — structure-only in mockup until event data verified |
| How does each technician compare? | Compact scorecard: hours, utilization %, capacity use %, efficiency, on-time; row → drilldown | All selected-month, roster-only | Rebuilt read model | Pick a technician to inspect | Keep — one table, ~9 rows, no metadata bloat |
| What did one technician actually do? | Selected-technician drilldown: month work summary, capacity detail, efficiency by job, punctuality, and clearly-labeled completed-job economics | Work metrics: work_date cohort. Economics block labeled "jobs completed this month (all recorded hours on those jobs)" — separate cohort, disclosed | `allocations[]`, per-tech slices | Individual review | Keep — replaces crew tables and 42-month heatmap |
| What needs attention right now? | Exceptions strip: over-capacity, active-with-no-work, archived-with-work, unrecorded-hours (June real: Serrato +84h over; Villalta 8.5h; V. Contreras archived w/ 1 job) | Rule-based flags on the above metrics | Derived | Direct follow-ups | Keep — factual, bounded |
| Which technicians contribute profitable work? | Secondary economics panel, explicitly labeled completed-cohort ("June-completed jobs, allocated by recorded hours share") | Allocation = job value × tech hours/total mapped hours per completed job (locked formula); never presented as selected-month earnings | `allocations[]` | Contribution context | Keep as secondary with explicit cohort label — fixes the July contradiction without hiding economics |

## 4. Technician Commissions

Owner questions: calculated amount for the month; work value and pool behind it; distribution among
eligible technicians; effect of the efficiency setting; historical comparison.

| Owner question | Metric/visual | Exact cohort/formula | Source/read model | Owner action or decision | Keep/remove rationale |
|---|---|---|---|---|---|
| What is the calculated commission for the month? | Hero: Calculated commission due (June: $2,179.89) + the single disclaimer "Calculated, not paid. These amounts do not confirm that payment was made." | Pool = completed-cohort work value × pool% (June: $435,978.86 × 0.50%) | Commission engine (`src/lib/metrics/commissions.ts`, locked math) | Payroll input | Keep — disclaimer appears exactly once |
| What produced it? | KPI cluster: Work value $435,979 · Pool 0.50% · Completed jobs 272 · Technicians earning N | Completed cohort; earning = final bonus > 0 | Same | Sanity-check basis | Keep |
| How is it distributed? | Distribution: ranked leaderboard with proportional bars, rank tier chips (Gold ×1.30 / Silver ×1.20 / Bronze ×1.10 / Standard), expandable per-tech job detail (job, site, value, share, hours, allocated) | Locked order: hours-share allocation → rank by allocated value → tier multipliers → normalize to pool → 5% minimum threshold forfeiture + pro-rata redistribution → deterministic cents | Same | See who earns what and from which jobs | Keep — chart+leaderboard merged into one component (current page renders them twice side-by-side) |
| How does the efficiency setting change it? | Functional controls: pool % select (0.25–1.00 step 0.05), efficiency toggle, max-adjustment slider (±5–50%, default 20) + per-tech comparison (ratio → multiplier → $ effect) when enabled | Ratio = Σ allocated quoted hrs / Σ actual hrs on qualifying quote-sourced jobs; multiplier: ≤0.50 → 1−max, ≥1.50 → 1+max, linear between (1.00 → ×1.00); no coverage → ×1.00; results renormalized to pool | Same engine, client-recalculated | Tune the plan; amounts genuinely change | Keep — functional, not simulation-only, per locked decision |
| How do technicians and periods compare historically? | Summary tab: monthly / quarterly / annual modes; annual total, average loaded month, peak month, active earning technicians; per-tech per-period matrix with trend sparkline | Σ pool per period over loaded months; avg divides by loaded months; missing months = N/A never zero; active = distinct techs with bonus > 0 | `summary{}` | Plan-level review | Keep — separate tab, compact |

## 5. Today (rebuilt 2026-07-15 — round 6)

**Owner question: "How is this month actually going, and what needs me today?"** The only screen
whose numbers move during the day, built on data the monthly pages cannot show.

- **Flagship: cumulative pace curve.** Real per-day cumulative completed value pulled from Simpro —
  July '26 (through day 14: $261,425) plotted against June '26 and July '25 full curves on the same
  day axis. Ahead of both at the same day; June finished $435,979, July '25 finished $451,054. The
  visible day-2 step is the $102,986 Creekwood 8-system boiler install.
- **Headline column:** $261,425 · $139,937 net (53.5%) · +75.9% vs Jul '25 day-14 · +18.6% vs June
  day-14; stat grid (101 jobs avg $2,588 · 14 quotes $91,636 · pool $1,307.13 · 822.75h = 114% of
  720h MTD capacity); twin progress meters — 45% of the month elapsed vs 60% of June's total booked.
- **Needs a Decision queue.** Every time-sensitive item, oldest first, with age chips per the
  30/45-day rules: Symphony 44d ($50,750, crosses 45 tomorrow), Park Plaza 43d ($114,218), Hotel
  Lulu 43d ($504,628 / 3 quotes), Lake Murray 41d, Best Western + JW Marriott 34d, Roberto Villalta
  0h July, team at 114% MTD capacity. $951,944 of open value on the list.
- **Losses so far (live):** −$1,460 across 7 jobs vs June's −$25,866 across 111 — with the three
  largest named. **Biggest completions:** Creekwood $102,986/$47,044 net, Sunland Park, JW Marriott,
  De Soto Gardens — Creekwood alone is 39% of MTD value.

## Round-6 structural pass (2026-07-15)

Applied after Asad's feedback that round 5 changed components, not composition:
- **First screen = flagship.** Jobs and Quotes fuse the dark headline column with the flagship chart
  in one band (`hero split`); the four stat tiles became a compact grid inside the headline column,
  with the historical bullet retained below.
- **Jobs money story consolidated:** Revenue→Net waterfall, work-source profitability, and margin
  distribution now sit in one connected three-across band instead of three scroll positions.
- **Quotes is action-first:** the follow-up queue ($1.96M open, ordered by age with 30/45-day chips)
  moved directly under the flagship; analytics follow it.
- **Technicians leads with the scorecard** (the page's real flagship), capacity chart second.

## Removal inventory (owner-facing product)

Everything below exists today and is removed from the owner UI (backend records may remain for
correctness/recoverability). Cross-referenced to the brief's rejected-scope list:

- **Quotes:** classification/evidence workbench (189-row table + per-quote audit drawer + exclude/
  reinstate UI), acceptance-path taxonomy panel, quote-data-coverage banners, "Unclassified" KPI card,
  duplicate snapshot + YoY tables, duplicate value-trend/stacked charts, trailing-12 KPI card row,
  definitions footer, record-count footer.
- **Jobs:** coverage-notes banner, quote-labor/material coverage tables (screen of zeros),
  Migration-026 field-coverage table, 2023-current reconciliation history table, customer-profitability
  table (single "Unclassified" row — returns only when Customer coverage exists), selected-period
  comparison grid (folded into KPI deltas), trailing-12 strip (folded into trend), CSV export button,
  methodology banners/footers, cost-center table (duplicates category except 3 rows — folded into
  category mode).
- **Technicians:** non-roster population (15 → 9), allocated-net-profit hero, supporting-measures
  duplicate KPI row, coverage panel (~950px), monthly-reconciliation "missing" table, 42-month
  technician heatmap with "MISSING" cells, crew results table, methodology banner, scorecard metadata
  bloat (hire dates/availability strings move to drilldown).
- **Commissions:** worksheet lifecycle card + Rebuild/Review/Lock stepper, revision/run/manifest/edit
  badges, roster-inclusion editor, period-configuration form (change-reason bureaucracy), exports panel
  + export history + hashes, revision history, audit history (208-event machine log), diagnostics
  accordion, per-month accordions for future months, N/A-only summary states (replaced by honest
  "no finalized months" empty treatment), duplicate disclaimer repetitions, storage-infrastructure
  footnote.
- **Global:** "Data health — N active" sidebar badge (replaced by the quiet per-page pill),
  methodology-flavored page subtitles, "272/272 supported" coverage strings inside KPI cards.
