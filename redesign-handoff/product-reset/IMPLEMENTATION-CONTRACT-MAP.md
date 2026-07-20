# Implementation Contract Map — approved design → routes, components, data

Per brief §15.2. Demand side authored from the immutable APPROVED-2026-07-15 snapshot
(SHA256SUMS in that directory). Supply side (existing read models, gaps) appended after the
backend survey. Locked business rules in brief §6 govern every semantic below; verified data
corrections in DEFECT-LEDGER.md govern efficiency/roster semantics.

## Global (all routes)

- Shell: dark rail (250px, logo, 5 nav items incl. NEW /today, owner block); month stepper
  (‹ month ›, disabled › on the live month); freshness pill ("Updated N min ago", truthful, never
  "Live" on stale data).
- Design system: tokens per approved tokens.css (14px base, legibility gate v2 in
  DESIGN-RESEARCH.md); chart language per approved kit.js ported to typed React SVG components:
  trendChart (multi-series, dual axis with aligned ticks, band + anchored band label, repr dashing
  via reprTo/dash + verified dots, annotations, guide tooltip incl. dashed series), bullet,
  devBars, devStrip, hStack, waterfall (with checkpoint bars), histogram (top-rounded, small-n
  centering), heatmap (contrast-safe ramp, hatched representative cells), stacked bars.
- Provenance grammar everywhere: dashed/hatched/marked = representative; solid = verified; every
  representative element carries a data-def; amber "Draft" chips on unreconciled periods.
- [data-def] tooltip affordance; drawers; drilldowns scroll into view; tooltips hide on scroll.
- States per page: loading skeleton, honest empty, partial/stale (amber pill + as-of), error+retry.

## /jobs (month-scoped, default latest complete month)

Contract per section:
1. Flagship focal: net profit $, net margin % + margin-pts delta YoY, $ deltas YoY + MoM,
   target-miss line (example target), dgrid (revenue, gross+gross margin, jobs, avg value, each
   with YoY delta; MoM in def), bullet (current vs same-month-last-year tick vs 12-mo high).
   → contract: month_summary(month): {revenue, gross, net, jobs, avg, margins, yoy/mom deltas,
     high_12mo, provenance}.
2. Monthly trend: 18-mo series {revenue, gross, net, avg, gross_margin, net_margin, jobs} with
   per-month verified|representative flags; YoY overlay mode (same-month pairs).
   → monthly_series(from,to): rows + provenance flags.
3. Money band: waterfall {revenue, materials, labor, overhead, net} + gross checkpoint — rounded
   components MUST sum to displayed net (largest-remainder); work-source
   {quote_generated|recurring|direct_service}: {jobs, revenue, net, margin} (net-dollar share bars,
   losses point left).
4. Loss module: below-zero cohort {count, total} + class split {diagnostic_fee: count/$,
   execution: count/$} + six largest rows {job, site, sell, net, hours, techs, class} + follow-up
   conversion stat (diagnostic calls that produced a quote).
5. Labor: quote-linked {Σest, Σact, over%, covered/of, no-estimate count} + per-job variance array
   + top-3 overruns {job, site, est, act}; recurring separately (estimate-covered only, exclusions
   listed). Quote-linked = ANY quote conversion incl. recurring-type quotes (verified vs
   work-source Quote-generated which excludes them — def states this).
6. Sites: ranked by net {site, jobs, revenue, net, margin}, top-8 + remainder (no bar on
   remainder); category mode.
7. Completed jobs table: all cohort jobs {name, id, site, source, sell, gross, net, margin},
   sortable, paginated (real pagination), filters {category, source, technician(9)}, CSV.
8. Drawers: per-job detail incl. loss "why" (n/m margin treatment for fee tickets).

## /quotes (month-scoped)

1. Flagship focal: acceptance rate + pts deltas (display-rounded policy), won $ + % of quoted,
   open-not-yet-accepted $ + count, dgrid (sent+YoY, value full-$, won value, avg accepted deal),
   bullet (rate vs LY vs high).
2. Acceptance trend 12-mo: count-rate + value-rate lines (band label "Jun · 22.8% / 8.8%");
   volume mode: sent vs won lines + flatline annotation. yMax tuned (no dead band).
3. Follow-up queue (June-cohort scope stated): per-quote {id, name, site, status(sent|viewed),
   sent date, age d, value} ordered oldest-first, 30/45-day chips, by-customer rollup + drawers
   both modes, remainder row; queue total. Aging = as-of date − DateApproved, cleared by activity.
4. Tiers: 4 tiers {count, share, quoted $, accepted-by-value %}; tier×month heatmap with
   verified/representative cell flags (discrete 5-swatch legend + hatch).
5. History tab: 12-mo table {sent, value, accepted, accepted value, rates} + computed T12 row +
   June highlight + CSV.
6. Acceptance semantics locked: verified online acceptance OR exact converted-job link, never
   stage/status; DateApproved sets the month; no declined state exists → Q6 pending (option (a)
   as approved default: open = not-yet-accepted, def discloses).

## /technicians (month-scoped)

1. Hero: team productive utilization % (job/recorded), single-scale bar (job+unbilled, capacity
   tick, example target), honest no-prior-period note until history verified; stats {unbilled
   hours + share, capacity used % + over-115 count (amber), quote labor efficiency 0.93× semantics
   (verified team; per-tech representative), on-time (representative) }.
2. Exceptions flags (3) — grid at wide.
3. Scorecard: 9-tech effective roster {name, jobs, job hrs, unbilled, utilization, capacity use,
   quote eff (repr), on-time (repr)}, sortable asc/desc incl. on-time, default job-hrs desc
   labeled, team footer computed, inactive rows show "—" and sort last; archived worker disclosed
   separately (Contreras).
4. Capacity chart: per-tech job+unbilled vs 176h tick, sorted by job hours, amber >115%, grey
   inactive.
5. Efficiency devBars: per-tech ratios marked representative (69/73 covered jobs lack job-level
   tech assignment — timesheet attribution required to verify); team 0.93× verified; recurring
   mode with auto domain.
6. Punctuality histogram (repr) + coverage line; axis "minutes vs planned start".
7. Economics: ranked by allocated net, hatched interim bars (equal-split until hours-share ships),
   share-of-team-net values, outside-roster $20.6K disclosed not ranked.
8. Drill per tech (under scorecard): 8 KPIs + covered-jobs table (est/act at all widths) +
   economics context.
→ contracts: effective_roster(month) [position/archived/hire evidence, NOT commission
  eligibility]; tech_month_facts(month, tech): hours (work-date scoped), utilization, capacity,
  allocation with work-date evidence; team efficiency (est/act/coverage); punctuality events.

## /commissions (month-scoped + summary)

1. Hero: pool $ (cents em-scaled), formula meta ($435,979 prose; exact value in def), earning
   count, labeled top-3 strip (monotonic ramp), stats {revenue, pool %, earning, top payout+def}.
2. Worksheet: pool% select, efficiency toggle + state, ±max slider (dims off); board rows sorted
   by payout: segmented bars (base/boost/eff± solid tints), tier chip + criteria def (no chip when
   no work), composite adjustment × (5-dp, reproduces trace), payout, expandable detail (allocated
   jobs by value + trace whose printed arithmetic multiplies out exactly), $20.6K outside-roster
   insight; efficiency effect devBars (sum $0) when on.
3. Summary tab: monthly histogram + Month|Pool|Status table (Draft chips + defs on unreconciled
   months, Current on live), quarterly (centered small-n), annual (H1|H2|Total|Peak), CSV.
4. Engine semantics locked (brief §6): pool = completed work value × pool%; hours-share
   allocation (equal-split interim disclosed until timesheet hours-share verified); rank boosts
   ×1.30/1.20/1.10 top-3 by allocated value; 5% min threshold forfeit/redistribute; efficiency
   linear remap [0.5,1.5]→[1∓max] neutral-when-uncovered; renormalize to pool; deterministic cent
   allocation; calculated ≠ paid, stated.

## /today (live month, phone-first)

1. Flagship: MTD revenue + net/margin, same-day-count chips vs LY and prior month; dgrid {jobs+avg,
   quotes sent+value, pool-so-far (cents), team hours vs MTD capacity}; progress meters (month
   elapsed vs share of prior-month total); cumulative daily revenue chart: live month curve
   (solid live dot) vs prior month vs same month LY, tight yMax, anchored "Live · day N" band.
2. Needs a Decision: quote rows (oldest first, 30/45 chips, ids) + separated ROSTER group
   (0-hours flag, over-capacity flag) with distinct footer.
3. Losses so far (live): total + count + top-3 + remainder row with share bars; honest full-month
   comparison wording.
4. Biggest completions: share bars, net shown, id disambiguation vs open quotes.
5. Freshness: "Updated N min ago"; states incl. "no completions yet today".
→ contracts: daily_cumulative(month): per-day completed revenue (also for prior month + LY);
  mtd_summary; open-quote queue (cross-referenced with /quotes); mtd losses; mtd top completions;
  mtd team hours + capacity (flat rule, holiday non-deduction disclosed).

## Cross-cutting corrections bound to this map

- Efficiency truth (DEFECT-LEDGER): team 0.93× (614.0/661.5h, 73/85); per-tech unverifiable from
  job records → representative until timesheet attribution lands.
- Roster: 8 Service Technicians + 1 Apprentice effective roster (Simpro positions), Furtado/
  Sarmiento/archived-Contreras excluded from leaderboards, disclosed ($20.6K June).
- July 2026 = mandatory regression case (work-date-scoped allocation vs utilization coherence).
- Approved-decision defaults encoded by the mockups (Q1/Q2 9-person roster + redistribute
  disclosed; Q3 archived history visible, no capacity; Q4 fee-class framing; Q5 session-only
  controls; Q6 option (a)) — implement as shown; each remains a one-line config/copy change if
  Asad revisits.
