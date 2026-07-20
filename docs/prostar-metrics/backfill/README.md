# Historical Backfill Capacity Basis

The approved source/month capacity estimates are conservative planning values, not claimed source totals.

- Quote baseline: 200 records/month, two daily filter traversals (`DateApproved` and `DateIssued`), and 25 nested requests per quote.
- Job baseline: 350 records/month, daily `CompletedDate` traversal, and 30 nested requests per job.
- Employee baseline: 20 detail records.
- Timesheet baseline: 20 employee pages and 3,000 records/month.
- Schedule baseline: 350 records/month with detail fetches.
- Invoice baseline: 200 global/customer records/month with detail fetches.
- Mobile history remains coverage-only because the source exposes bounded forward logs, not an authoritative historical traversal.

The ledger records actual request, snapshot, and normalization counts. A required work unit cannot become complete until source-to-normalized exact-ID reconciliation matches, so an estimate can never be used as proof of completeness.
