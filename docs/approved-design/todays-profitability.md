# Today's Profitability

**Owner request:** 2026-08-28  
**Route:** `/today`  
**Status:** approved for implementation

## Decision the screen supports

Show whether work completed on the current Pacific business date is profitable,
and make the individual jobs responsible for the result immediately visible.
This is an operating screen, not a replacement for the monthly Jobs dashboard.

## Metric contract

- Cohort: active app-owned job rows whose `CompletedDate` equals today in
  `America/Los_Angeles` and whose stage is `Complete` or `Archived`. Job status
  is never used as a completion proxy.
- Revenue: sum of Simpro job `Total` for the cohort.
- Gross profit: sum of Simpro `GrossProfit Actual` for the cohort.
- Net profit: sum of Simpro `NetProfit Actual` for the cohort.
- Gross and net margins: covered profit divided by the revenue of the same
  covered jobs. The UI shows `N/A` for an aggregate profit value unless every
  completed job has that profit field.
- Net-negative jobs: cohort rows whose supported `NetProfit Actual` is below
  zero. This is an attention signal, not an inferred diagnosis.
- Source: app-owned PostgreSQL serving tables only. Pages and API routes never
  read Simpro directly; bounded workers own Simpro access.

## Screen layout

1. Header: **Today's Profitability**, a one-line operating description, and the
   existing Jobs freshness pill.
2. KPI band: primary Net Profit Today card; Revenue, Gross Profit, Completed
   Jobs, and Net-Negative Jobs tiles.
3. Coverage note: explains the Pacific-date cohort, `N/A` behavior, worker
   cadence, and one-minute browser refresh.
4. Today's Completed Jobs: newest source updates first, with Job, Site, Revenue,
   Gross, Net, and Net Margin. Negative net values use the established alert
   color.
5. Context: retain the compact month-to-date Revenue-to-Net, Work Volume, Team
   Capacity, and cumulative revenue pace cards so daily results are not read in
   isolation.

## Live behavior and honest states

- The client requests `/api/today` every 60 seconds without browser caching.
- The API retains a 60-second bounded page cache to prevent refresh storms.
- “Live” means the latest app-owned result from the bounded production worker
  cadence, not a direct request-time Simpro call.
- Empty: explicitly says no jobs have been completed today yet.
- Partial/stale: values remain visible with the existing freshness warning.
- Error: no figures are fabricated; the screen offers a retry.

## Acceptance criteria

- The screen is present in primary Metrics navigation.
- Pacific midnight correctly starts a new cohort.
- Complete and Archived stages are included; all other stages and deleted rows
  are excluded.
- Every displayed number comes from the response model.
- Missing financial fields cannot be mistaken for zero profit.
- Negative jobs are visible in both the KPI band and job table.
- The page, API, auth, loading, empty, stale, and error states have automated
  coverage and pass the repository's full release gates.
