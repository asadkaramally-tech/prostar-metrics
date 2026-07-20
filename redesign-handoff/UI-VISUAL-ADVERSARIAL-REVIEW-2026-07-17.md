# Pro Star Metrics UI / Visual Design Adversarial Review

Date: 2026-07-17
Scope: desktop-first product redesign plan. This is not an implementation patch.

Evidence captured from the local app at 1440 x 900 with real persisted read models:

- `output/playwright/ui-review/quotes-1440x900.png`
- `output/playwright/ui-review/jobs-1440x900.png`
- `output/playwright/ui-review/technicians-1440x900.png`
- `output/playwright/ui-review/commissions-1440x900.png`
- `output/playwright/ui-review/today-1440x900.png`
- Full-page captures are also in `output/playwright/ui-review/*-full.png`.

## Executive Verdict

The current redesign improved component craft, but it failed product composition. It still behaves like a set of handsome reports plus operational work queues, not like a dense metrics dashboard for an owner/operator.

The biggest design failure is not typography or color. It is information architecture: the first viewport repeatedly spends prime space on the wrong object. Quotes leads with a follow-up queue. Today leads with "Needs a Decision." Jobs pushes the actual economic bridge below the fold. Technicians makes a table the dominant object. The left rail burns 250px of desktop width and a large amount of vertical attention while providing little navigational value.

The new design must be rebuilt around four primary monthly metrics pages:

1. Quotes
2. Jobs
3. Technicians
4. Commissions

Today is removed from primary navigation. If retained, it is a hidden/current-month snapshot route, not a core dashboard tab.

## Adversarial Findings

### P0 - Primary Navigation Is Wrong

Evidence: every captured page shows the 250px dark rail with five links including Today.

Problem: the rail is visually dominant but low utility. It steals width from analytical content and makes page switching look like an application menu when the dashboard really needs a compact set of peer metric tabs.

Fix:

- Replace the rail with a compact top shell.
- Primary nav is a segmented control: `Quotes | Jobs | Technicians | Commissions`.
- Page switching stays visible in the top bar, not in a permanent left panel.
- Data health becomes one icon/button in the top right, not a bottom-left badge.

### P0 - Today Is the Wrong Product

Evidence: `today-1440x900.png` shows "Needs a Decision" occupying the right side of the hero and includes quote queue rows, roster flags, losses, and completions.

Problem: this is an action dashboard. The owner asked for a metrics dashboard. The page competes with the actual monthly metrics pages and introduces operational queues that were not requested as the product center.

Fix:

- Remove Today from primary nav.
- Do not rebuild "Needs a Decision."
- Do not include quote follow-up queues or roster flags in the primary dashboard experience.
- If `/today` remains, it is a small current-month snapshot with MTD revenue/jobs/quotes/hours and links into the real monthly pages.

### P0 - Quotes Promotes a Fabricated Work Queue Over Metrics

Evidence: `quotes-1440x900.png` shows "Open Quotes - Follow-Up Queue" occupying the full right side of the first viewport. The actual trend and tier analytics are below the fold.

Problem: open/not accepted quotes are a metric. A follow-up queue with suggested action framing is a workflow product. That is not the core dashboard.

Fix:

- Remove `FollowUpQueueCard` from the hero.
- Replace it with a metric composition:
  - accepted vs not accepted value bar
  - open/not accepted aging distribution
  - tier mix
- Quote rows move to a compact drilldown table below visual analytics.
- Remove suggested-action copy from quote drawers.

### P0 - Loss Semantics Are Overdesigned and Misleading

Evidence: Jobs still renders "Loss-Making Jobs" and supporting classifications. The prior handoff explicitly promoted diagnostic-fee vs execution-loss framing.

Problem: a service company can profit from labor-only work. The app must not imply a service call is a loss because it has labor and little/no material. The only acceptable loss cohort is known Simpro actual net profit below zero.

Fix:

- Loss row inclusion rule: `Simpro NetProfit Actual < 0`.
- If net profit is missing, display "net unavailable"; do not classify.
- Remove diagnostic-fee/execution-loss language from the owner UI.
- Negative-net jobs become a small exception module, not a headline page section.

### P1 - Jobs Hides the Actual Money Story

Evidence: `jobs-1440x900.png` shows the large dark hero plus over-tall trend card. "Revenue to Net Profit" and "Profitability by Work Source" start below the fold.

Problem: the Jobs page should immediately answer how completed work converted revenue into net profit and which work sources/categories/sites are driving it. Instead it makes the user scroll to reach the economics.

Fix:

- First viewport after KPI strip must include:
  - compact revenue-to-net bridge
  - 12-month profit trend
  - work-source mix beginning in the same viewport
- The hero number becomes part of a KPI strip, not a giant focal card.

### P1 - Technicians Uses the Table as the Product

Evidence: `technicians-1440x900.png` shows a useful top summary, but the scorecard becomes the dominant object immediately.

Problem: scorecards are useful drilldowns, but the owner first needs team-level visual answers: how hours were used, who is over/under capacity, whether productivity and coverage are healthy.

Fix:

- First screen prioritizes:
  - team hours composition
  - utilization/capacity ranking
  - profitability per hour / labor efficiency / on-time coverage summary
- Scorecard remains full-width below those visuals.
- Default month must never fall forward into future thin technician payloads.

### P1 - Chart Density Is Poor

Evidence:

- Jobs full page is 3555px tall.
- Technicians full page is 3301px tall.
- Quotes full page is 2036px tall even while the first viewport is queue-heavy.

Problem: the pages use many tall cards and long row lists to express compact relationships. The visual system is spacious, but not efficient enough for repeated operator use.

Fix:

- Replace six-step vertical waterfall with one compact horizontal profit bridge.
- Replace work-source rows with one proportional/stacked card plus numeric labels.
- Prefer short ranked bars, bullets, stacked strips, and small multiples over tall tables.
- Tables are drilldown surfaces only.

### P2 - Visual Style Is Too Heavy for an Operations Tool

Evidence: all main pages use large dark focal cards with decorative dot/gradient texture and oversized display numbers.

Problem: the dark hero treatment makes every page feel like an executive slide. This reduces scanning density and over-prioritizes one number at the expense of comparison.

Fix:

- Use a quiet light dashboard surface.
- Keep dark treatment only for compact emphasis if needed, never as a half-screen object.
- Cards use 8px radius or less.
- Page sections are unframed layouts or single cards; no nested card feel.
- Typography is compact: 13-14px body, 11-12px labels, 22-28px KPI numerals, no 54px hero numerals.

## Locked Global Layout

Viewport target: desktop 1440 x 900. Mobile is secondary and must not drive layout decisions.

### Shell

Top bar:

- Height: 56px.
- Left: Pro Star logo, "Metrics".
- Center: segmented nav, 4 items only:
  - Quotes
  - Jobs
  - Technicians
  - Commissions
- Right:
  - month selector
  - freshness pill
  - data health icon/button
  - user/menu icon if needed

Content:

- Max width: 1440px.
- Horizontal padding: 24px.
- Vertical padding under top bar: 18px.
- 12-column grid.
- Column gap: 16px.
- Row gap: 16px.
- Card radius: 8px.

Page header:

- Height budget: 52px.
- Left: title + one-line description.
- Right controls live in shell unless page-specific filters are required.
- No methodology copy in the header.

KPI strip:

- Always directly below the page header.
- 5 or 6 equal cards.
- Height: 86px.
- Each KPI: label, value, small context/delta.
- No chart inside KPI cards.

Primary analysis row:

- Height: 260-300px.
- Contains the page's main visual answer.
- Must fit entirely in the first 900px viewport.

Secondary row:

- Height: 220-260px.
- Starts in the first viewport on desktop where possible.

Drilldown:

- Tables start below the first visual rows.
- Default rows: 8-12.
- Row height: 38-44px.
- Full record details go in drawers.

## Page Specs

## Quotes

Purpose: quote activity, accepted value, acceptance rate, and mix.

First viewport layout:

- KPI strip, 6 cards:
  1. Quotes sent
  2. Quote value
  3. Accepted quotes
  4. Accepted value
  5. Acceptance rate
  6. Open/not accepted value

- Row 1:
  - Columns 1-8: 12-month quote trend, height 280.
    - Toggle: `Acceptance | Value | Count`.
    - Default: acceptance by count and value, two lines.
  - Columns 9-12: quote status mix, height 280.
    - One stacked bar: accepted value vs open/not accepted value.
    - Below it: open aging mini distribution: `0-14d | 15-30d | 31-45d | 46d+`.

- Row 2:
  - Columns 1-5: tier mix, height 230.
    - One stacked bar by tier, labels for count and value.
  - Columns 6-12: tier x month heatmap, height 230.

Below:

- Compact quote drilldown table.
- Columns: quote, customer/site, approved/sent date, value, status, age.
- No "follow-up queue" title.
- No suggested action language.
- Optional customer concentration card is allowed below Row 2, but it is a metric card, not a call list.

Components to remove or demote:

- `FollowUpQueueCard` removed from hero.
- `QuoteDrawerDetail` removes suggested action.
- Any "call this week" style copy removed.

## Jobs

Purpose: completed-job economics.

First viewport layout:

- KPI strip, 6 cards:
  1. Completed jobs
  2. Revenue
  3. Gross profit
  4. Net profit
  5. Net margin
  6. Avg job value

- Row 1:
  - Columns 1-7: revenue-to-net bridge, height 280.
    - One horizontal bridge, not six vertical bars.
    - Segments: revenue, materials, labor, overhead/other, net.
    - Labels show dollars; final label shows net margin.
  - Columns 8-12: 12-month trend, height 280.
    - Toggle: `Revenue | Gross | Net | Margin`.
    - Default: net profit and net margin.

- Row 2:
  - Columns 1-4: work-source mix, height 230.
    - One proportional card: Direct Service, Recurring, Quote-generated.
    - Shows job share, revenue share, net share.
  - Columns 5-8: category profitability ranked bars, height 230.
  - Columns 9-12: site/customer profitability ranked bars, height 230.

Below:

- Labor variance card.
- Net-negative jobs exception card:
  - Rule shown exactly: `Known Simpro NetProfit Actual < 0`.
  - Small ranked list only, not a major module.
- Completed jobs drilldown table.

Components to change:

- `BridgeCard` becomes compact horizontal bridge.
- `WorkSourceCard` becomes proportional visual, not a row list.
- `LossCard` becomes `NetNegativeJobsCard` or equivalent.
- Remove diagnostic-fee/execution classification from owner UI.

## Technicians

Purpose: team productivity, capacity, coverage, and technician-level comparison.

Data contract fix:

- Default month is current business month.
- Do not select future ready technician payloads by max period.
- Empty future/zero payloads render empty state only when explicitly selected.
- Thin payloads do not render as "could not be loaded" when the selected month is legitimately empty.

First viewport layout:

- KPI strip, 6 cards:
  1. Active technicians
  2. Recorded hours
  3. Job hours
  4. Productive utilization
  5. Capacity used
  6. Net profit per job hour, if covered

- Row 1:
  - Columns 1-7: team hours composition, height 280.
    - One stacked horizontal bar: job, travel, pickup parts, support/unassigned, leave.
    - Capacity marker shown on the same scale.
  - Columns 8-12: technician utilization/capacity ranking, height 280.
    - Compact horizontal rows, one per tech.
    - Each row: job hours bar, recorded/capacity marker, over-capacity highlight.

- Row 2:
  - Columns 1-4: profitability per hour ranking, height 230.
  - Columns 5-8: labor efficiency, height 230.
  - Columns 9-12: on-time coverage/rate, height 230.

Below:

- Technician scorecard table.
- Technician drilldown drawer or inline detail.
- Exceptions strip only if factual and compact.

Components to change:

- `TechniciansHero` loses giant dark-card treatment.
- `ScorecardCard` moves below visual summary.
- `CapacityCard`, `EfficiencyCard`, and `PunctualityCard` become Row 1/Row 2 visuals, not downstream extras.

## Commissions

Purpose: calculated pool, distribution, eligibility, and controlled worksheet changes.

First viewport layout:

- KPI strip, 5 cards:
  1. Completed work value
  2. Commission pool
  3. Pool percent
  4. Eligible technicians
  5. Top calculated payout

- Row 1:
  - Columns 1-8: payout distribution by technician, height 300.
    - Ranked horizontal bars.
    - Segments: base share, rank boost, efficiency effect if enabled.
  - Columns 9-12: pool calculation/status, height 300.
    - Work value x pool percent = pool.
    - Status: calculated/not paid.
    - Period state and last update.

- Row 2:
  - Columns 1-6: worksheet controls, height 180.
    - Pool percent.
    - Efficiency toggle.
    - Max adjustment slider.
  - Columns 7-12: adjustment impact, height 180.
    - Shows who changes and by how much when efficiency is enabled.

Below:

- Technician payout table.
- Expanded job detail.
- Summary tab remains secondary.
- Admin/export/audit controls stay contained and do not dominate first viewport.

## Today

Decision: remove from primary navigation.

Allowed options:

1. Redirect `/today` to `/jobs?month=current`.
2. Keep `/today` as an unlinked "MTD Snapshot" route.

If option 2 is used:

- KPI strip only:
  - MTD revenue
  - MTD net profit
  - completed jobs
  - quotes sent
  - team hours
- One compact cumulative revenue chart.
- No "Needs a Decision."
- No quote queue.
- No roster flags.
- No loss card.
- No biggest-completions list.

## Visual System Rules

- Desktop-first. Do not optimize the main IA for mobile.
- Cards max radius: 8px.
- No nested cards.
- No decorative gradient/orb background treatment.
- Dark panels are rare and compact; no half-screen dark hero.
- Tables are secondary, never the first thing that defines a page.
- Every chart must answer one operator question in its title/subtitle.
- No in-app instructional prose blocks. Definitions belong in tooltips or concise labels.
- Red means negative money or late only.
- Amber means stale/suspect/attention.
- Green means favorable only when direction is objectively favorable.
- Dotted underline means definition, not action.
- Buttons use icon+label only for explicit commands; charts and modes use segmented controls.

## Acceptance Criteria Before Implementation Is Considered Done

Desktop screenshot criteria at 1440 x 900:

- No left rail.
- Top nav shows only Quotes, Jobs, Technicians, Commissions.
- First viewport of each primary page shows:
  - page title
  - month/freshness controls
  - KPI strip
  - primary analysis row
- Quotes first viewport contains no follow-up queue.
- Today is not in primary nav.
- Jobs first viewport includes the revenue-to-net bridge.
- Jobs page contains no diagnostic-fee/execution-loss classification.
- Technicians default route does not show "Technician data could not be loaded" when current-month data exists.
- Technicians first viewport includes a team-hours visual and utilization/capacity ranking before the scorecard.
- Commissions first viewport separates payout distribution from worksheet/admin detail.
- No text overlaps or clipped controls at 1440 x 900 and 1280 x 800.

Semantic criteria:

- Loss means known Simpro actual net profit below zero.
- Unknown net profit never becomes loss.
- Open quotes are metrics, not assigned actions.
- Page titles and chart titles use business language, not validation/system language.
- Freshness is visible but quiet.

Performance criteria:

- Page render reads persisted read models.
- No page performs live Simpro fan-out.
- Page cache remains bounded by page/month/filter key.
- `/technicians` does not select future empty read models by default.

## Implementation Order After This Review Is Accepted

1. Fix technician month/read-model selection and empty-state handling.
2. Replace shell with compact top navigation.
3. Remove Today from primary nav and strip action-dashboard content.
4. Recompose Quotes page according to the locked grid.
5. Recompose Jobs page and fix loss semantics/copy.
6. Recompose Technicians page around visuals before scorecard.
7. Tighten Commissions page hierarchy.
8. Run desktop screenshot review at 1440 x 900 and 1280 x 800.
9. Run targeted component/store tests, then build.

## Explicit Rejection Of Prior Handoff Choices

The prior round-6 handoff promoted "Quotes is action-first" and treated Today as a "Needs me today" page. That direction is rejected for this product. It creates an action/workflow dashboard and crowds out the metrics system the owner asked for.

Keep from the prior work:

- persisted read models
- truthful freshness
- chart component infrastructure
- useful calculations where semantically valid
- bounded drilldown tables

Reject from the prior work:

- primary follow-up queue
- "Needs a Decision"
- diagnostic-fee/execution-loss loss framing
- large dark hero as the dominant page grammar
- table-first technician layout
- tall sidebar primary nav
