# Mockup Decisions — Pro Star Metrics Dashboard Reset

Prepared: 2026-07-14. The small number of consequential choices embodied in the first-round mockups,
the data provenance for every number shown, and the batched business-policy questions that need
Asad's answer. Everything else follows the takeover brief and PRODUCT-CONTENT-MAP.md directly.

## Consequential design choices

0. **Every element passes the ten-point functional-vs-decorative checklist** in DESIGN-RESEARCH.md
   (Few/Tufte/NN/g): no graphic ships without its scale and values readable on or beside it. Round
   three applies the research verbatim: YoY-first comparisons (HVAC seasonality), per-KPI definition
   tooltips with formula and date anchor, bullet-strip month-vs-year context in heroes, labeled
   share-bar breakdown rows with "remaining" totals, rule-driven quote aging, sortable scorecard with
   a team footer, and a per-payout calculation trace on commissions.

1. **June 2026 is the mockups' selected month.** It is the most recent *complete* month, and every
   headline number for it is verified against source (jobs CSV ↔ fresh Simpro pull match to the cent).
   July would force partial-month treatments everywhere; instead the partial-month pace treatment is
   shown once, as a documented hero variant.

2. **Technicians hero = team productive utilization with capacity context**, not allocated net profit.
   The old hero duplicated the Jobs hero ($211,534) on a cohort that produced the July contradiction.
   Utilization/capacity is the one question only this page can answer.

3. **One treatment per question.** Each metric appears exactly once as a primary treatment; historical
   tables move behind History/Summary tabs; comparisons collapse into deltas on the hero and KPI
   tiles. This is what turns 6,500–8,500px pages into ~2,000–2,600px pages.

4. **Bounded drilldowns with drawers.** Top-8 largest-not-accepted, top-loss jobs, top-10 completed
   jobs, per-tech job detail: every table is bounded, and record detail lives in a right-side drawer
   instead of 40-column rows.

5. **Direct-service loss is surfaced as a first-class insight** on Jobs (June: 189 direct-service jobs
   net −$2,018 while quote-generated work runs 57.1% net margin). See policy question Q4 — the default
   framing awaits your call.

6. **Commission distribution renders the locked engine faithfully** (hours-share allocation → rank
   tiers ×1.30/1.20/1.10 → pool normalization → 5% minimum forfeiture/redistribution → optional bounded
   efficiency overlay, pool-preserving). Controls are functional in the mockup: pool %, efficiency
   toggle, and max-adjustment slider genuinely recompute the displayed amounts.

## Data provenance in the mockups

Real and verified (safe to trust as shown):
- All June 2026 job economics (272 jobs, $435,979 / $291,641 / $211,534, bridge components, loss-job
  counts and records, work-source split, category and site profitability).
- 18-month completed-job revenue + count trend (fresh Simpro pull, Jan 2025–Jun 2026).
- 12-month quote acceptance history, June tier distribution and tier acceptance, largest
  not-accepted records with real sites and values (Hotel Lulu $323,087, Best Western #259 $178,438…).
- Technician roster (verified from Simpro employees), June recorded/job hours per technician
  (fresh timesheet pull), quote-linked efficiency ratios per technician.
- Commission pool math for June ($435,978.86 × 0.50% = $2,179.89).

Representative structure (clearly marked in the mockups with a dotted underline + footnote):
- Monthly **gross/net profit trend history** for months other than May/Jun 2026 and Jun 2025 (real
  revenue, representative margin shape until each month is independently reconciled).
- **Punctuality** buckets and on-time rates (schedule/mobile matching not yet re-verified; structure
  and June bucket shape shown from current app evidence).
- **Per-technician allocated economics and commission distribution**: allocation shares are computed
  with the locked formula but from an interim equal-split-per-job approximation of hours (the
  hours-share inputs exist and will replace them in implementation; roster eligibility also awaits Q1/Q2).
- Commission **Summary** monthly pools for Jan–May 2026 (current app's draft-run values; will be
  recomputed after the roster decision).

Nothing else in the mockups is invented: no fake technicians, no fabricated customers, no invented
history.

## Batched business-policy questions (need answers before implementation, not before mockup review)

**Q1 — Technician roster membership.** Verified from Simpro: 8 active Service Technicians (Rob Sires,
Roberto Villalta, Juan Serrato, Justin Molina, Jeffrey Perry, Cole Bender, Ismael Contreras, Jim Ochoa)
+ 1 Apprentice (Tadeo Jimenez). Two people with real June field work fall outside that definition:
Stephen Furtado (Technical & Projects Manager, 19.5h) and Piel Sarmiento (Warehouse Associate, hired
Jun 22, 19.5h, 2 jobs). Should the Technician Performance roster be (a) the 9 by position only, with
Furtado/Sarmiento's work disclosed in an "other field work" line, or (b) the 9 plus named inclusions
you approve? *Mockups show (a).*

**Q2 — Commission eligibility.** The seeded commission roster is stale (includes departed Ernie
Hernandez, Erick Eudave, archived Victor Contreras; missing Jim Ochoa, Ismael Contreras, Tadeo
Jimenez). Should commission eligibility be (a) identical to the performance roster from Q1, or (b) a
separate list you maintain (e.g. exclude the Apprentice)? *Mockups show (a): 9 eligible.*

**Q3 — Archived technicians' history.** When someone leaves mid-year (e.g. Victor Contreras), their
past months' performance and commissions should remain visible in history but they should drop out of
current-month capacity and rosters as of their archive date. Confirm that treatment.

**Q4 — Direct-service pricing framing.** 111 of June's 272 jobs have negative net profit; most are $59
diagnostic-fee service calls where the fee doesn't cover technician cost, concentrated in Direct
service (−4.0% net margin as a class). Is the $59 call structurally intended (loss leader for contract
clients) — in which case the loss view should separate "expected-loss service calls" from genuine
overruns — or is this a pricing problem you want surfaced bluntly? *Mockups show it bluntly.*

**Q5 — Commission control persistence.** ~~Pool % / efficiency settings: session-only exploration
controls or persisted period configuration?~~ **Resolved 2026-07-15:** Asad declined the
finalize-month mechanism ("I don't need the finalize month"). The controls are live, session-only
exploration tools — they reset to the saved defaults (0.50%, efficiency off) on reload, and no
month is ever locked. The summary tab reports each month at the saved default.

## Adversarial-review decisions (Asad, 2026-07-15)

From CRITIQUE-SYNTHESIS.md. All Bucket A items (22 defects) were fixed without a decision needed.

| Item | Decision | Where it landed |
|---|---|---|
| B1 flagship default | **Approved** | Jobs chart opens with Net profit + Net margin selected |
| B2 seasonality | **Approved** | "vs last year" chip → 12-mo YoY overlay on the Jobs flagship |
| B5 efficiency chart | **Approved** | Ratio bars → deviation bars anchored at 1.00× (Technicians) |
| B6 summary table | **Approved** | Thinned to Month · Pool · Status (Commissions) |
| C1 Today screen | **Approved** | New fifth screen `today.html`, phone-first, July MTD |
| C2 customer rollup | **Approved** | Read-only "By customer" toggle on Open Quotes (no CRM fields) |
| C3 finalize month | **Declined** | Not built — see Q5 resolution above |
| C4 callback tracking | **Deferred (v1.1)** | Needs an operational tagging convention in Simpro first — a job-name/custom-field marker linking a return visit to the original job. Convention TBD with Asad before any metric is shown. |
| C5 alert digests | **Deferred (v1.1)** | Threshold rules exist on-screen first; delivery channel later |
| C6 targets | **Approved as examples** | Amber target ticks labeled "(example)" — real numbers are Asad's |
| C7 CSV export | **Approved** | Plain "Download CSV" buttons: Completed Jobs table, Commission summary |
| B3 job-mix drilldown | **Deferred** | Revisit after v1 ships with real data |
| B4 quote-detail drawer | **Deferred** | Aging table links suffice for v1 |

**Q6 — Lost/declined quote state (added 2026-07-15, from the full design review).** Simpro gives us
no verified "declined" signal, so every unaccepted quote counts as open forever — the $1.96M
"still in play" figure includes quotes a customer may have silently rejected months ago. Options:
(a) accept as-is (open = not-yet-accepted, stated in the tooltip — current mockup behavior);
(b) add an age-based "gone cold" bucket (e.g. >90 days) reported separately from active open value;
(c) introduce a manual mark-as-lost action in the app. Needs your call before implementation.

## Consolidated access request (needed at implementation/release, listed once per brief §13A)

1. Secure injection of the approved migration connection string at deploy time (or temporary
   `Key Vault Secrets User` on `azure-postgres-connection-string` only).
2. `ProStar Evidence Public Key Reader` (metadata-only) on the three release evidence keys during release.
3. One interactive Asad/Laila Microsoft sign-in in a local browser for authenticated production
   validation when we reach release.

Nothing is needed for the mockup phase — Simpro read-only, Azure control plane, and production-app
state checks all verified working on 2026-07-14.
