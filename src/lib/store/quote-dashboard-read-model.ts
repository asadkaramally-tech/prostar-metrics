import type { FreshnessStatus } from "@/lib/metrics/freshness";
import { classifyQuote, dealTier, type QuoteAcceptancePath } from "@/lib/metrics/quotes";
import { getPageFreshness } from "@/lib/store/freshness";
import { queryPostgres } from "@/lib/store/postgres";
import { plainDisplayText } from "@/lib/text/plain-display-text";

export const quoteDealTiers = ["Under $750", "$750-$2K", "$2K-$10K", "$10K+"] as const;
export type QuoteDealTier = (typeof quoteDealTiers)[number];

// Kept for the persistence-only override module and immutable legacy history.
export type QuoteOutcome = "won" | "lost" | "open" | "excluded" | "unknown";
export const quoteAcceptanceOutcomes = ["accepted", "not_accepted", "excluded"] as const;
export type QuoteAcceptanceOutcome = (typeof quoteAcceptanceOutcomes)[number];
export const quoteAcceptancePaths = [
  "accepted_online_and_converted",
  "accepted_online_only",
  "converted_only",
  "not_accepted",
  "excluded",
] as const satisfies readonly QuoteAcceptancePath[];
export const quoteAcceptancePathLabels: Record<QuoteAcceptancePath, string> = {
  accepted_online_and_converted: "Accepted online + converted",
  accepted_online_only: "Accepted online only",
  converted_only: "Converted only",
  not_accepted: "Not Accepted",
  excluded: "Excluded",
};
export const quoteSorts = ["date-desc", "date-asc", "value-desc", "value-asc", "quote-asc", "quote-desc"] as const;
export type QuoteSort = (typeof quoteSorts)[number];
export const quoteDashboardPageSize = 50;

export type QuoteDashboardFilters = {
  search: string;
  category: string;
  tier: QuoteDealTier | "";
  outcome: QuoteAcceptanceOutcome | "";
  acceptancePath: QuoteAcceptancePath | "";
  sort: QuoteSort;
  page: number;
};

export type QuoteMetricsReadModelOptions = {
  selectedMonth?: string;
  now?: Date;
  search?: string;
  category?: string;
  tier?: string;
  outcome?: string;
  acceptancePath?: string;
  sort?: string;
  page?: string | number;
};

export type QuoteCanonicalRow = {
  quote_id: string | number;
  quote_no: string | null;
  name: string | null;
  status_name: string | null;
  linked_job_id: string | number | null;
  job_no?: string | null;
  linked_job_match: boolean | null;
  inverse_conversion_match: boolean | null;
  date_issued: string | null;
  date_approved: string | null;
  customer_name?: string | null;
  site_id?: string | number | null;
  site_name?: string | null;
  total_value: string | number | null;
  deal_tier: string | null;
  category: string | null;
  category_basis: string | null;
  outcome: string | null;
  outcome_reason: string | null;
  updated_at: string;
  override_id: string | number | null;
  override_outcome: string | null;
  legacy_won_override: boolean | null;
  override_reason: string | null;
  override_evidence_url: string | null;
  override_actor_email: string | null;
  override_revision: string | number | null;
  override_created_at: string | null;
};

export type QuoteTierMetric = {
  quoteCount: number;
  quoteValue: number;
  acceptedCount: number;
  acceptedValue: number;
  notAcceptedCount: number;
  notAcceptedValue: number;
};

export type QuoteMonthlyMetric = QuoteTierMetric & {
  month: string;
  label: string;
  excludedCount: number;
  excludedValue: number;
  averageAcceptedDeal: number | null;
  acceptanceRateCount: number | null;
  acceptanceRateValue: number | null;
  provisional: boolean;
  sourceRecords: number;
  byTier: Record<QuoteDealTier, QuoteTierMetric>;
};

export type QuoteKpiTrend = {
  key: "quoteCount" | "quoteValue" | "acceptedCount" | "acceptanceRateCount";
  label: string;
  value: number | null;
  previousValue: number | null;
  deltaPercent: number | null;
  format: "count" | "currency" | "percent";
  supportingText: string;
  sparkline: Array<{ month: string; value: number | null }>;
};

export type QuoteMonthlyTierTrend = {
  month: string;
  monthKey: string;
  provisional: boolean;
  byTier: Record<QuoteDealTier, {
    quoteCount: number;
    acceptedCount: number;
    notAcceptedCount: number;
    acceptanceRateCount: number | null;
  }>;
};

export type QuoteSentMonthlyMetric = {
  month: string;
  label: string;
  provisional: boolean;
  sentCount: number;
  sentValue: number;
};

export type QuoteFollowUpQueueRow = {
  quoteId: number;
  quoteNo: string;
  name: string;
  customer: string;
  site: string;
  status: string;
  sentDate: string;
  ageDays: number;
  value: number;
  tier: QuoteDealTier;
};

export type QuoteFollowUpQueue = {
  scope: string;
  asOf: string;
  totalCount: number;
  totalValue: number;
  rows: QuoteFollowUpQueueRow[];
  byCustomer: Array<{
    customer: string;
    count: number;
    totalValue: number;
    oldestAgeDays: number;
    newestAgeDays: number;
  }>;
};

export type QuoteClassificationRow = {
  quoteId: number;
  quoteNo: string;
  name: string;
  dateIssued: string;
  dateApproved: string | null;
  value: number;
  status: string;
  category: string;
  categoryBasis: string;
  tier: QuoteDealTier;
  outcome: QuoteAcceptanceOutcome;
  acceptancePath: QuoteAcceptancePath;
  evidence: string;
  linkedJobId: number | null;
  inverseConversionMatch: boolean;
  override: {
    id: number;
    requestedEffect: "excluded" | "legacy_accept" | "legacy_not_accept";
    effective: boolean;
    reason: string;
    evidenceUrl: string | null;
    actorEmail: string;
    revision: number;
    createdAt: string;
  } | null;
};

export type QuoteMetricsReadModel = {
  freshness: FreshnessStatus;
  generatedAt: string;
  selectedMonth: string;
  warnings: string[];
  contractGaps: string[];
  quotesLoaded: number;
  currentMonth: QuoteMonthlyMetric | null;
  priorMonth: QuoteMonthlyMetric | null;
  priorYearSameDay: QuoteMonthlyMetric | null;
  priorYearSameMonth: QuoteMonthlyMetric | null;
  provisional: {
    isCurrentMonthPartial: boolean;
    elapsedDays: number;
    daysInMonth: number;
    pace: { quoteCount: number; acceptedCount: number; quoteValue: number };
    sameDayYoY: { quoteCount: number | null; acceptedCount: number | null; quoteValue: number | null };
  };
  trailingWindow: { startMonth: string; endMonth: string; monthCount: number };
  trailingKpis: QuoteKpiTrend[];
  acceptanceSummary: {
    acceptedCount: number;
    notAcceptedCount: number;
    excludedCount: number;
    denominatorCount: number;
    acceptanceRateCount: number | null;
    acceptedValue: number;
    notAcceptedValue: number;
    denominatorValue: number;
    acceptanceRateValue: number | null;
  };
  yoyRows: Array<{
    label: string;
    current: number | null;
    priorYear: number | null;
    priorYearFull: number | null;
    changePercent: number | null;
    format: "count" | "currency" | "percent";
  }>;
  monthlyAcceptance: Array<{
    month: string;
    acceptedCount: number;
    notAcceptedCount: number;
    acceptedValue: number;
    notAcceptedValue: number;
  }>;
  sentMonthly: QuoteSentMonthlyMetric[];
  sentBasis: "DateIssued";
  followUpQueue: QuoteFollowUpQueue;
  monthlyTierTrends: QuoteMonthlyTierTrend[];
  acceptanceByTier: Array<QuoteTierMetric & { tier: QuoteDealTier; acceptanceRateCount: number | null; acceptanceRateValue: number | null }>;
  trends: Array<{
    month: string;
    provisional: boolean;
    acceptanceRateCount: number | null;
    acceptanceRateCount3Month: number | null;
    acceptanceRateCount12Month: number | null;
    acceptanceRateValue: number | null;
    acceptanceRateValue3Month: number | null;
    acceptanceRateValue12Month: number | null;
  }>;
  heatmap: Array<{
    tier: QuoteDealTier;
    months: Array<{ month: string; label: string; accepted: number; total: number; acceptanceRate: number | null; provisional: boolean }>;
  }>;
  monthlyBreakdown: QuoteMonthlyMetric[];
  monthlyFooter: QuoteTierMetric & {
    averageAcceptedDeal: number | null;
    acceptanceRateCount: number | null;
    acceptanceRateValue: number | null;
  };
  acceptanceByCategory: Array<QuoteTierMetric & { category: "HVAC" | "Water Heating" | "Unclassified"; acceptanceRateCount: number | null; acceptanceRateValue: number | null }>;
  acceptancePaths: Array<{ path: QuoteAcceptancePath; label: string; count: number; value: number }>;
  largestNotAccepted: Array<{ rank: number; quoteId: number; quoteNo: string; name: string; dateIssued: string; ageDays: number; value: number; category: string; tier: QuoteDealTier; evidence: string }>;
  classificationRows: QuoteClassificationRow[];
  filters: QuoteDashboardFilters;
  pagination: { page: number; pageSize: number; classificationPages: number; classificationTotal: number };
  filterOptions: {
    categories: string[];
    tiers: QuoteDealTier[];
    outcomes: QuoteAcceptanceOutcome[];
    acceptancePaths: Array<{ path: QuoteAcceptancePath; label: string }>;
  };
  methodology: {
    acceptanceDefinition: string;
    acceptanceDenominator: string;
    dateBasis: string;
    provisionalHandling: string;
    overrides: { activeCount: number; latestAt: string | null; affordance: string };
  };
};

type OverrideSummaryRow = { active_count: string; latest_at: string | null };
type NormalizedQuote = ReturnType<typeof normalizeCanonicalRow>;
type PersistedQuoteDashboardRow = { dashboard: QuoteMetricsReadModel | null };
type PersistedQuoteRecordsRow = { period_start: string; quote_records: unknown };

/**
 * Compact, app-classified quote facts stored alongside each monthly dashboard
 * payload. They are sufficient for all supported API filters and avoid
 * rebuilding the 2023-current canonical quote corpus on page/filter changes.
 */
export type PersistedQuoteDashboardRecord = Pick<QuoteClassificationRow,
  "quoteId" | "quoteNo" | "name" | "dateApproved" | "value" | "status" |
  "category" | "categoryBasis" | "tier" | "outcome" | "acceptancePath" |
  "evidence" | "linkedJobId" | "inverseConversionMatch" | "override"
> & {
  dateIssued: string | null;
  customer: string;
  siteName: string;
};

const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export type QuoteDashboardRowsQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<{ rows: T[] }>;

type QuoteFollowUpQueueDbRow = {
  quote_id: string | number;
  quote_no: string | null;
  name: string | null;
  status_name: string | null;
  linked_job_id: string | number | null;
  linked_job_match: boolean | null;
  inverse_conversion_match: boolean | null;
  date_issued: string | null;
  date_approved: string | null;
  customer_name: string | null;
  site_name: string | null;
  total_value: string | number | null;
  deal_tier: string | null;
  override_outcome: string | null;
};

export async function loadQuoteDashboardRows(
  query: QuoteDashboardRowsQuery = queryPostgres,
): Promise<QuoteCanonicalRow[]> {
  const result = await query<QuoteCanonicalRow>(
    `with inverse_jobs as (
       select distinct on (j.converted_from_id) j.converted_from_id, j.job_id
         from metrics.metrics_jobs j
        where j.converted_from_type = 'Quote'
          and j.converted_from_id is not null
          and j.source_deleted_at is null
        order by j.converted_from_id, j.job_id
     ), active_exclusions as (
       select distinct on (quote_id)
              id, quote_id, outcome, won_override, reason, evidence_url, actor_email, revision, created_at
         from metrics.quote_classification_overrides
        where active = true and outcome = 'excluded'
        order by quote_id, revision desc, created_at desc, id desc
     )
     select q.quote_id::text, q.quote_no, q.name, q.status_name,
            q.linked_job_id::text as linked_job_id,
            q.date_issued::text, q.date_approved::text,
            nullif(btrim(q.customer_name), '') as customer_name,
            q.site_id::text as site_id,
            nullif(btrim(q.site_name), '') as site_name,
            q.total::text as total_value, q.deal_tier, q.category, q.category_basis,
            q.outcome, q.outcome_reason, q.updated_from_source_at::text as updated_at,
            (linked_job.job_id is not null) as linked_job_match,
            (inverse_job.job_id is not null) as inverse_conversion_match,
            o.id::text as override_id, o.outcome as override_outcome,
            o.won_override as legacy_won_override, o.reason as override_reason,
            o.evidence_url as override_evidence_url, o.actor_email as override_actor_email,
            o.revision::text as override_revision, o.created_at::text as override_created_at
       from metrics.metrics_quotes q
       left join metrics.metrics_jobs linked_job
         on linked_job.job_id = q.linked_job_id
        and linked_job.source_deleted_at is null
       left join inverse_jobs inverse_job
         on inverse_job.converted_from_id = q.quote_id
       left join active_exclusions o
         on o.quote_id = q.quote_id
      where q.source_deleted_at is null
        and q.date_issued >= date '2023-01-01'
      order by q.date_issued desc, q.quote_id desc`,
  );
  return result.rows;
}

export async function getQuoteFollowUpQueue(
  selectedMonth: string,
  options: { now?: Date; query?: QuoteDashboardRowsQuery } = {},
): Promise<QuoteFollowUpQueue> {
  const month = normalizeMonthKey(selectedMonth);
  if (!month) throw new Error(`Invalid quote follow-up month: ${selectedMonth}`);

  const result = await (options.query ?? queryPostgres)<QuoteFollowUpQueueDbRow>(
    `with inverse_jobs as (
       select distinct on (j.converted_from_id) j.converted_from_id, j.job_id
         from metrics.metrics_jobs j
        where j.converted_from_type = 'Quote'
          and j.converted_from_id is not null
          and j.source_deleted_at is null
        order by j.converted_from_id, j.job_id
     ), active_exclusions as (
       select distinct on (quote_id) quote_id, outcome
         from metrics.quote_classification_overrides
        where active = true
          and outcome = 'excluded'
        order by quote_id, revision desc, created_at desc, id desc
     )
     select q.quote_id::text, q.quote_no, q.name, q.status_name,
            q.linked_job_id::text as linked_job_id,
            (linked_job.job_id is not null) as linked_job_match,
            (inverse_job.job_id is not null) as inverse_conversion_match,
            q.date_issued::text, q.date_approved::text,
            nullif(btrim(q.customer_name), '') as customer_name,
            nullif(btrim(q.site_name), '') as site_name,
            q.total::text as total_value, q.deal_tier,
            o.outcome as override_outcome
       from metrics.metrics_quotes q
       left join metrics.metrics_jobs linked_job
         on linked_job.job_id = q.linked_job_id
        and linked_job.source_deleted_at is null
       left join inverse_jobs inverse_job
         on inverse_job.converted_from_id = q.quote_id
       left join active_exclusions o
         on o.quote_id = q.quote_id
      where q.source_deleted_at is null
        and q.date_issued >= $1::date
        and q.date_issued < $2::date
      order by q.date_issued asc, q.quote_id asc`,
    [`${month}-01`, `${addMonthsKey(month, 1)}-01`],
  );

  const asOfDate = losAngelesDate(options.now ?? new Date());
  const rows = result.rows
    .flatMap((row): QuoteFollowUpQueueRow[] => {
      const issued = parseDate(row.date_issued);
      if (!issued) return [];
      const totalValue = finiteNumber(row.total_value);
      const classification = classifyQuote({
        quoteId: row.quote_id,
        totalValue,
        statusName: row.status_name,
        linkedJobId: row.linked_job_match === true ? row.linked_job_id : null,
        convertedFromJobId: row.inverse_conversion_match === true ? "matched" : null,
        outcomeOverride: row.override_outcome,
      });
      if (classification.acceptanceOutcome !== "not_accepted") return [];
      return [{
        quoteId: finiteInteger(row.quote_id),
        quoteNo: cleanDisplayText(row.quote_no) ?? String(row.quote_id),
        name: cleanDisplayText(row.name) ?? "Untitled quote",
        customer: cleanDisplayText(row.customer_name) ?? "Customer unavailable",
        site: cleanDisplayText(row.site_name) ?? "Site unavailable",
        status: cleanDisplayText(row.status_name) ?? "Not provided",
        sentDate: row.date_issued?.slice(0, 10) ?? issued.toISOString().slice(0, 10),
        ageDays: calendarAgeInDays(issued, asOfDate),
        value: totalValue,
        tier: normalizeTier(row.deal_tier, totalValue),
      }];
    })
    .sort((left, right) => left.sentDate.localeCompare(right.sentDate) || left.quoteId - right.quoteId);

  return summarizeFollowUpQueue(rows, month, asOfDate);
}

export async function getQuoteMetricsReadModel(options: QuoteMetricsReadModelOptions = {}): Promise<QuoteMetricsReadModel> {
  const now = options.now ?? new Date();
  const currentCalendarMonth = monthKey(losAngelesDate(now));
  const selectedMonth = normalizeMonthKey(options.selectedMonth) ?? currentCalendarMonth;
  const freshnessPromise = getPageFreshness(
    "quotes",
    `${selectedMonth}-01`,
  );
  try {
    const [freshness, records, overrideSummary] = await Promise.all([
      freshnessPromise,
      getPersistedQuoteDashboardRecords(selectedMonth, currentCalendarMonth),
      getQuoteOverrideSummary(),
    ]);
    // Reclassify persisted facts at read time. This keeps accepted-status
    // normalization correct even when a prior dashboard payload was built with
    // an older classifier; a missing monthly fact set still falls back below.
    if (records) return buildQuoteMetricsReadModelFromPersistedRecords(freshness, records, overrideSummary, options);
  } catch {
    // A complete persisted corpus is required for exact filtered results. Fall
    // back to canonical reconstruction whenever a monthly model is missing or
    // unreadable rather than silently filtering a partial history.
  }

  try {
    const [freshness, [quoteResult, overrideResult]] = await Promise.all([
      freshnessPromise,
      Promise.all([
        loadQuoteDashboardRows(),
        queryPostgres<OverrideSummaryRow>(
          `select count(*)::text as active_count, max(created_at)::text as latest_at
             from metrics.quote_classification_overrides
            where active = true and outcome = 'excluded'`,
        ),
      ]),
    ]);
    return buildQuoteMetricsReadModel(freshness, quoteResult, overrideResult.rows[0], options);
  } catch (error) {
    const freshness = await freshnessPromise;
    return emptyQuoteMetricsReadModel(freshness, error instanceof Error ? error.message : "Unable to read quote metrics.", options);
  }
}

export async function getPersistedQuoteDashboard(
  selectedMonth: string,
  query: QuoteDashboardRowsQuery = queryPostgres,
): Promise<QuoteMetricsReadModel | null> {
  const result = await query<PersistedQuoteDashboardRow>(
    `select values_json -> 'dashboard' as dashboard
       from metrics.dashboard_read_models
      where metric_family = 'quotes'
        and period_grain = 'month'
        and period_start = $1::date
        and superseded_at is null
        and jsonb_typeof(values_json -> 'dashboard') = 'object'
      order by rebuilt_at desc
      limit 1`,
    [`${selectedMonth}-01`],
  );
  const dashboard = result.rows[0]?.dashboard ?? null;
  return isUsablePersistedQuoteDashboard(dashboard, selectedMonth) ? dashboard : null;
}

export async function getPersistedQuoteDashboardRecords(
  selectedMonth: string,
  throughMonthOrQuery: string | QuoteDashboardRowsQuery = selectedMonth,
  query: QuoteDashboardRowsQuery = queryPostgres,
): Promise<PersistedQuoteDashboardRecord[] | null> {
  const throughMonth = typeof throughMonthOrQuery === "function" ? selectedMonth : throughMonthOrQuery;
  const effectiveQuery = typeof throughMonthOrQuery === "function" ? throughMonthOrQuery : query;
  const through = throughMonth > selectedMonth ? throughMonth : selectedMonth;
  const months: string[] = [];
  for (let month = "2023-01"; month <= through; month = addMonthsKey(month, 1)) months.push(month);
  const result = await effectiveQuery<PersistedQuoteRecordsRow>(
    `select period_start::text, values_json -> 'quoteRecords' as quote_records
       from metrics.dashboard_read_models
      where metric_family = 'quotes'
        and period_grain = 'month'
        and period_start = any($1::date[])
        and superseded_at is null
        and jsonb_typeof(values_json -> 'quoteRecords') = 'array'
      order by period_start`,
    [months.map((month) => `${month}-01`)],
  );
  if (result.rows.length !== months.length) return null;
  const byMonth = new Map(result.rows.map((row) => [row.period_start.slice(0, 7), row.quote_records]));
  if (months.some((month) => !byMonth.has(month))) return null;
  const records: PersistedQuoteDashboardRecord[] = [];
  for (const month of months) {
    const value = byMonth.get(month);
    if (!Array.isArray(value) || !value.every(isPersistedQuoteDashboardRecord)) return null;
    records.push(...value);
  }
  return records;
}

async function getQuoteOverrideSummary(
  query: QuoteDashboardRowsQuery = queryPostgres,
): Promise<OverrideSummaryRow> {
  const result = await query<OverrideSummaryRow>(
    `select count(*)::text as active_count, max(created_at)::text as latest_at
       from metrics.quote_classification_overrides
      where active = true`,
  );
  return result.rows[0] ?? { active_count: "0", latest_at: null };
}

function isUsablePersistedQuoteDashboard(
  dashboard: QuoteMetricsReadModel | null,
  selectedMonth: string,
): dashboard is QuoteMetricsReadModel {
  return Boolean(dashboard)
    && dashboard!.selectedMonth === selectedMonth
    && typeof dashboard!.quotesLoaded === "number"
    && Array.isArray(dashboard!.trends)
    && Array.isArray(dashboard!.monthlyBreakdown)
    && Array.isArray(dashboard!.classificationRows)
    && Array.isArray(dashboard!.followUpQueue?.rows)
    && Array.isArray(dashboard!.followUpQueue?.byCustomer)
    && typeof dashboard!.filters === "object"
    && dashboard!.filters !== null
    && typeof dashboard!.filterOptions === "object"
    && dashboard!.filterOptions !== null;
}

export function buildQuoteMetricsReadModel(
  freshness: FreshnessStatus,
  rows: QuoteCanonicalRow[],
  overrideSummary: OverrideSummaryRow = { active_count: "0", latest_at: null },
  options: QuoteMetricsReadModelOptions = {},
): QuoteMetricsReadModel {
  return buildQuoteMetricsReadModelFromNormalized(
    freshness,
    rows.map(normalizeCanonicalRow),
    overrideSummary,
    options,
  );
}

export function buildQuoteMetricsReadModelFromPersistedRecords(
  freshness: FreshnessStatus,
  records: PersistedQuoteDashboardRecord[],
  overrideSummary: OverrideSummaryRow = { active_count: "0", latest_at: null },
  options: QuoteMetricsReadModelOptions = {},
): QuoteMetricsReadModel {
  return buildQuoteMetricsReadModelFromNormalized(
    freshness,
    uniquePersistedQuoteRecords(records).map(normalizePersistedQuoteDashboardRecord),
    overrideSummary,
    options,
  );
}

export function buildPersistedQuoteDashboardRecords(
  rows: QuoteCanonicalRow[],
  periodStart: string,
): PersistedQuoteDashboardRecord[] {
  const month = periodStart.slice(0, 7);
  return rows.map(normalizeCanonicalRow)
    .filter((quote) => quote.monthKey === month || quote.issuedMonthKey === month)
    .map((quote) => ({
      quoteId: quote.quoteId,
      quoteNo: quote.quoteNo,
      name: quote.name,
      dateApproved: quote.dateApproved ?? "",
      dateIssued: quote.dateIssued,
      value: quote.totalValue,
      status: quote.status,
      customer: quote.customer,
      siteName: quote.siteName,
      category: quote.category,
      categoryBasis: quote.categoryBasis,
      tier: quote.tier,
      outcome: quote.outcome,
      acceptancePath: quote.acceptancePath,
      evidence: quote.evidence,
      linkedJobId: quote.linkedJobId,
      inverseConversionMatch: quote.inverseConversionMatch,
      override: quote.override,
    }));
}

function buildQuoteMetricsReadModelFromNormalized(
  freshness: FreshnessStatus,
  normalized: NormalizedQuote[],
  overrideSummary: OverrideSummaryRow,
  options: QuoteMetricsReadModelOptions,
): QuoteMetricsReadModel {
  const now = options.now ?? new Date();
  const localToday = losAngelesDate(now);
  const currentCalendarMonth = monthKey(localToday);
  const selectedMonth = normalizeMonthKey(options.selectedMonth) ?? currentCalendarMonth;
  const daysInMonth = getDaysInMonth(parseMonthKey(selectedMonth));
  const isCurrentMonthPartial = selectedMonth === currentCalendarMonth;
  const elapsedDays = isCurrentMonthPartial ? localToday.getUTCDate() : daysInMonth;
  const requestedFilters = normalizeDashboardFilters(options);
  const filtered = normalized.filter((quote) => matchesDashboardFilters(quote, requestedFilters));
  const warnings = normalized.length === 0 ? ["No quote rows are available for the dashboard."] : [];
  const unclassifiedCount = normalized.filter((quote) => quote.category === "Unclassified").length;
  const contractGaps = unclassifiedCount > 0
    ? [`${unclassifiedCount} quote records are Unclassified; that group remains visible in category acceptance.`]
    : [];

  const trendMonths = buildMonthKeys(selectedMonth, 23).reverse().map((month) => buildMonthlyMetric(
    month,
    filtered,
    month === selectedMonth && isCurrentMonthPartial,
    month === selectedMonth && isCurrentMonthPartial ? elapsedDays : undefined,
  ));
  const chartMonths = trendMonths.slice(-12);
  const currentMonth = chartMonths.find((month) => month.month === selectedMonth) ?? null;
  const priorMonth = trendMonths.find((month) => month.month === addMonthsKey(selectedMonth, -1)) ?? null;
  const priorYearFull = trendMonths.find((month) => month.month === addMonthsKey(selectedMonth, -12)) ?? null;
  const priorYearSameDay = isCurrentMonthPartial
    ? buildMonthlyMetric(addMonthsKey(selectedMonth, -12), filtered, false, elapsedDays)
    : priorYearFull;
  const stableEnd = isCurrentMonthPartial ? addMonthsKey(selectedMonth, -1) : selectedMonth;
  const stableMonthKeys = buildMonthKeys(stableEnd, 12).reverse();
  const stableTrailing = stableMonthKeys.map((month) => buildMonthlyMetric(month, filtered, false));
  const selectedActivity = filtered.filter((quote) => quote.issuedMonthKey === selectedMonth && (!isCurrentMonthPartial || quote.issuedDay !== null && quote.issuedDay <= elapsedDays));
  const allClassificationRows = buildClassificationRows(selectedActivity, requestedFilters.sort);
  const classificationPages = Math.max(1, Math.ceil(allClassificationRows.length / quoteDashboardPageSize));
  const page = Math.min(requestedFilters.page, classificationPages);
  const pageStart = (page - 1) * quoteDashboardPageSize;
  const filters = { ...requestedFilters, page };
  const filterOptions = includeActiveFilterOptions(buildFilterOptions(normalized), filters);

  return {
    freshness,
    generatedAt: now.toISOString(),
    selectedMonth,
    warnings,
    contractGaps,
    quotesLoaded: normalized.length,
    currentMonth,
    priorMonth,
    priorYearSameDay,
    priorYearSameMonth: priorYearFull,
    provisional: buildProvisional(currentMonth, priorYearSameDay, elapsedDays, daysInMonth, isCurrentMonthPartial),
    trailingWindow: { startMonth: stableMonthKeys[0], endMonth: stableEnd, monthCount: stableTrailing.length },
    trailingKpis: buildTrailingKpis(stableTrailing),
    acceptanceSummary: buildAcceptanceSummary(stableTrailing),
    yoyRows: buildYoyRows(currentMonth, priorYearSameDay, priorYearFull),
    monthlyAcceptance: chartMonths.map((month) => ({
      month: month.label,
      acceptedCount: month.acceptedCount,
      notAcceptedCount: month.notAcceptedCount,
      acceptedValue: month.acceptedValue,
      notAcceptedValue: month.notAcceptedValue,
    })),
    sentMonthly: chartMonths.map((month) => ({
      month: month.month,
      label: month.label,
      provisional: month.provisional,
      sentCount: month.quoteCount,
      sentValue: month.quoteValue,
    })),
    sentBasis: "DateIssued",
    followUpQueue: buildFollowUpQueue(selectedActivity, selectedMonth, localToday),
    monthlyTierTrends: chartMonths.map(buildMonthlyTierTrend),
    acceptanceByTier: quoteDealTiers.map((tier) => acceptanceSegment(tier, currentMonth?.byTier[tier] ?? emptyTierMetric())),
    trends: buildTrends(trendMonths).slice(-12),
    heatmap: quoteDealTiers.map((tier) => ({
      tier,
      months: chartMonths.map((month) => ({
        month: month.month,
        label: month.label,
        accepted: month.byTier[tier].acceptedCount,
        total: month.byTier[tier].quoteCount,
        acceptanceRate: nullableRate(month.byTier[tier].acceptedCount, month.byTier[tier].quoteCount),
        provisional: month.provisional,
      })),
    })),
    monthlyBreakdown: [...chartMonths].reverse(),
    monthlyFooter: buildMonthlyFooter(stableTrailing),
    acceptanceByCategory: buildCategoryAcceptance(selectedActivity),
    acceptancePaths: buildAcceptancePaths(selectedActivity),
    largestNotAccepted: buildLargestNotAccepted(selectedActivity, localToday),
    classificationRows: allClassificationRows.slice(pageStart, pageStart + quoteDashboardPageSize),
    filters,
    pagination: { page, pageSize: quoteDashboardPageSize, classificationPages, classificationTotal: allClassificationRows.length },
    filterOptions,
    methodology: {
      acceptanceDefinition: "After an explicit Excluded override, Accepted requires normalized status exactly Quote Accepted Online, a current direct LinkedJobID relationship, or a current inverse ConvertedFrom Quote job relationship. Descriptive JobNo equality is never evidence. Every other quote is Not Accepted. Legacy acceptance overrides are audit history only.",
      acceptanceDenominator: "Count acceptance is Accepted divided by all non-excluded DateIssued quotes. Value acceptance is accepted value divided by all non-excluded DateIssued quote value. No activity record is removed as Open or Unknown.",
      dateBasis: "Monthly quote activity is assigned only by DateIssued. Records without DateIssued are outside monthly activity.",
      provisionalHandling: "Current-month pace uses actual month-to-date values. Same-day YoY uses the same calendar days in both years; the stable trailing 12 excludes a partial current month.",
      overrides: {
        activeCount: Number(overrideSummary.active_count) || 0,
        latestAt: overrideSummary.latest_at,
        affordance: "Admin and operator exclusions and reinstatements require a reason and retain immutable history. Reinstatement immediately restores source-derived classification and cannot create Accepted evidence.",
      },
    },
  };
}

function normalizeCanonicalRow(row: QuoteCanonicalRow) {
  const approved = parseDate(row.date_approved);
  const linkedJobMatch = row.linked_job_match === true;
  const inverseConversionMatch = row.inverse_conversion_match === true;
  const requestedEffect = normalizeOverrideEffect(row.override_outcome, row.legacy_won_override);
  const totalValue = finiteNumber(row.total_value);
  const classification = classifyQuote({
    quoteId: row.quote_id,
    totalValue,
    statusName: row.status_name,
    linkedJobId: linkedJobMatch ? row.linked_job_id : null,
    convertedFromJobId: inverseConversionMatch ? "matched" : null,
    outcomeOverride: row.override_outcome,
  });
  const issued = parseDate(row.date_issued ?? null);
  return {
    quoteId: finiteInteger(row.quote_id),
    quoteNo: cleanDisplayText(row.quote_no) ?? String(row.quote_id),
    name: cleanDisplayText(row.name) ?? "Untitled quote",
    status: cleanDisplayText(row.status_name) ?? "Not provided",
    customer: cleanDisplayText(row.customer_name ?? null) ?? "Customer unavailable",
    siteName: cleanDisplayText(row.site_name ?? null) ?? "Site unavailable",
    linkedJobId: nullableInteger(row.linked_job_id),
    inverseConversionMatch,
    approved: approved ?? new Date("1900-01-01T00:00:00Z"),
    hasApprovedDate: approved !== null,
    issued: issued ?? new Date("1900-01-01T00:00:00Z"),
    hasIssuedDate: issued !== null,
    dateApproved: row.date_approved,
    dateIssued: row.date_issued ?? null,
    issuedMonthKey: issued ? monthKey(issued) : null,
    issuedDay: issued ? issued.getUTCDate() : null,
    monthKey: approved ? monthKey(approved) : null,
    totalValue,
    tier: normalizeTier(row.deal_tier, totalValue),
    category: normalizeCategory(row.category),
    categoryBasis: cleanDisplayText(row.category_basis) ?? "Source category unavailable",
    outcome: classification.acceptanceOutcome,
    acceptancePath: classification.path,
    evidence: acceptanceEvidence(classification.path),
    override: requestedEffect && row.override_id !== null ? {
      id: finiteInteger(row.override_id),
      requestedEffect,
      effective: requestedEffect === "excluded",
      reason: cleanDisplayText(row.override_reason) ?? "No override reason supplied",
      evidenceUrl: row.override_evidence_url,
      actorEmail: row.override_actor_email ?? "Actor unavailable",
      revision: finiteInteger(row.override_revision),
      createdAt: row.override_created_at ?? row.updated_at,
    } : null,
  };
}

function uniquePersistedQuoteRecords(records: PersistedQuoteDashboardRecord[]) {
  // Monthly persistence can contain a quote in both its issued and approved
  // month. Records are loaded oldest-to-newest, so the later approved-month
  // classification wins without double-counting it in filter totals.
  const byQuoteId = new Map<number, PersistedQuoteDashboardRecord>();
  for (const record of records) byQuoteId.set(record.quoteId, record);
  return [...byQuoteId.values()];
}

function normalizePersistedQuoteDashboardRecord(record: PersistedQuoteDashboardRecord): NormalizedQuote {
  const approved = parseDate(record.dateApproved);
  const issued = parseDate(record.dateIssued);
  const classification = classifyQuote({
    quoteId: record.quoteId,
    totalValue: record.value,
    statusName: record.status,
    linkedJobId: record.linkedJobId,
    convertedFromJobId: record.inverseConversionMatch ? "matched" : null,
    outcomeOverride: record.override?.effective && record.override.requestedEffect === "excluded"
      ? "excluded"
      : null,
  });
  return {
    quoteId: record.quoteId,
    quoteNo: record.quoteNo,
    name: record.name,
    status: record.status,
    customer: record.customer,
    siteName: record.siteName,
    linkedJobId: record.linkedJobId,
    inverseConversionMatch: record.inverseConversionMatch,
    approved: approved ?? new Date("1900-01-01T00:00:00Z"),
    hasApprovedDate: approved !== null,
    issued: issued ?? new Date("1900-01-01T00:00:00Z"),
    hasIssuedDate: issued !== null,
    dateApproved: approved ? record.dateApproved : null,
    dateIssued: record.dateIssued,
    issuedMonthKey: issued ? monthKey(issued) : null,
    issuedDay: issued ? issued.getUTCDate() : null,
    monthKey: approved ? monthKey(approved) : null,
    totalValue: record.value,
    tier: record.tier,
    category: normalizeCategory(record.category),
    categoryBasis: record.categoryBasis,
    outcome: classification.acceptanceOutcome,
    acceptancePath: classification.path,
    evidence: acceptanceEvidence(classification.path),
    override: record.override,
  };
}

function isPersistedQuoteDashboardRecord(value: unknown): value is PersistedQuoteDashboardRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.quoteId) && Number(row.quoteId) > 0
    && typeof row.quoteNo === "string"
    && typeof row.name === "string"
    && typeof row.dateApproved === "string"
    && (row.dateIssued === null || typeof row.dateIssued === "string")
    && typeof row.value === "number" && Number.isFinite(row.value)
    && typeof row.status === "string"
    && typeof row.customer === "string"
    && typeof row.siteName === "string"
    && typeof row.category === "string"
    && typeof row.categoryBasis === "string"
    && quoteDealTiers.includes(row.tier as QuoteDealTier)
    && quoteAcceptanceOutcomes.includes(row.outcome as QuoteAcceptanceOutcome)
    && quoteAcceptancePaths.includes(row.acceptancePath as QuoteAcceptancePath)
    && typeof row.evidence === "string"
    && (row.linkedJobId === null || Number.isSafeInteger(row.linkedJobId))
    && typeof row.inverseConversionMatch === "boolean"
    && isPersistedQuoteOverride(row.override);
}

function isPersistedQuoteOverride(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const override = value as Record<string, unknown>;
  return Number.isSafeInteger(override.id)
    && (override.requestedEffect === "excluded" || override.requestedEffect === "legacy_accept" || override.requestedEffect === "legacy_not_accept")
    && typeof override.effective === "boolean"
    && typeof override.reason === "string"
    && (override.evidenceUrl === null || typeof override.evidenceUrl === "string")
    && typeof override.actorEmail === "string"
    && Number.isSafeInteger(override.revision)
    && typeof override.createdAt === "string";
}

function buildMonthlyMetric(month: string, quotes: NormalizedQuote[], provisional: boolean, maxDay?: number): QuoteMonthlyMetric {
  const sourceRows = quotes.filter((quote) => quote.hasIssuedDate && quote.issuedMonthKey === month && (!maxDay || quote.issued.getUTCDate() <= maxDay));
  const activity = sourceRows.filter((quote) => quote.outcome !== "excluded");
  const excluded = sourceRows.filter((quote) => quote.outcome === "excluded");
  const byTier = Object.fromEntries(quoteDealTiers.map((tier) => [tier, emptyTierMetric()])) as Record<QuoteDealTier, QuoteTierMetric>;
  for (const quote of activity) addQuote(byTier[quote.tier], quote);
  const metric = summarizeQuotes(activity);
  return {
    month,
    label: monthFormatter.format(parseMonthKey(month)),
    ...metric,
    excludedCount: excluded.length,
    excludedValue: sum(excluded.map((quote) => quote.totalValue)),
    averageAcceptedDeal: nullableDivide(metric.acceptedValue, metric.acceptedCount),
    acceptanceRateCount: nullableRate(metric.acceptedCount, metric.quoteCount),
    acceptanceRateValue: nullableRate(metric.acceptedValue, metric.quoteValue),
    provisional,
    sourceRecords: sourceRows.length,
    byTier,
  };
}

function buildFollowUpQueue(quotes: NormalizedQuote[], selectedMonth: string, asOfDate: Date): QuoteFollowUpQueue {
  const rows = quotes
    .filter((quote) => quote.outcome === "not_accepted")
    .map((quote) => ({
      quoteId: quote.quoteId,
      quoteNo: quote.quoteNo,
      name: quote.name,
      customer: quote.customer,
      site: quote.siteName,
      status: quote.status,
      sentDate: quote.dateIssued ?? "",
      ageDays: calendarAgeInDays(quote.issued, asOfDate),
      value: quote.totalValue,
      tier: quote.tier,
    }))
    .sort((left, right) => left.sentDate.localeCompare(right.sentDate) || left.quoteId - right.quoteId);
  return summarizeFollowUpQueue(rows, selectedMonth, asOfDate);
}

function summarizeFollowUpQueue(rows: QuoteFollowUpQueueRow[], selectedMonth: string, asOfDate: Date): QuoteFollowUpQueue {
  const byCustomer = new Map<string, { customer: string; count: number; totalValue: number; oldestAgeDays: number; newestAgeDays: number }>();
  for (const row of rows) {
    const entry = byCustomer.get(row.customer) ?? {
      customer: row.customer,
      count: 0,
      totalValue: 0,
      oldestAgeDays: row.ageDays,
      newestAgeDays: row.ageDays,
    };
    entry.count += 1;
    entry.totalValue += row.value;
    entry.oldestAgeDays = Math.max(entry.oldestAgeDays, row.ageDays);
    entry.newestAgeDays = Math.min(entry.newestAgeDays, row.ageDays);
    byCustomer.set(row.customer, entry);
  }
  return {
    scope: `${selectedMonth} cohort: every non-excluded DateIssued quote without acceptance evidence, oldest first. Age is calendar days since DateIssued as of the stated date; a quote leaves the queue on any acceptance or exclusion activity.`,
    asOf: asOfDate.toISOString().slice(0, 10),
    totalCount: rows.length,
    totalValue: sum(rows.map((row) => row.value)),
    rows,
    byCustomer: [...byCustomer.values()].sort((left, right) => right.totalValue - left.totalValue || left.customer.localeCompare(right.customer)),
  };
}

function buildProvisional(current: QuoteMonthlyMetric | null, prior: QuoteMonthlyMetric | null, elapsedDays: number, daysInMonth: number, partial: boolean) {
  const factor = partial && elapsedDays > 0 ? daysInMonth / elapsedDays : 1;
  return {
    isCurrentMonthPartial: partial,
    elapsedDays,
    daysInMonth,
    pace: {
      quoteCount: (current?.quoteCount ?? 0) * factor,
      acceptedCount: (current?.acceptedCount ?? 0) * factor,
      quoteValue: (current?.quoteValue ?? 0) * factor,
    },
    sameDayYoY: {
      quoteCount: percentChange(current?.quoteCount ?? null, prior?.quoteCount ?? null),
      acceptedCount: percentChange(current?.acceptedCount ?? null, prior?.acceptedCount ?? null),
      quoteValue: percentChange(current?.quoteValue ?? null, prior?.quoteValue ?? null),
    },
  };
}

function buildTrailingKpis(months: QuoteMonthlyMetric[]): QuoteKpiTrend[] {
  const previous = months.at(-2) ?? null;
  const totals = buildMonthlyFooter(months);
  const definitions: Array<Omit<QuoteKpiTrend, "deltaPercent">> = [
    { key: "quoteCount", label: "Total Quotes", value: totals.quoteCount, previousValue: previous?.quoteCount ?? null, format: "count", supportingText: `${formatCompact(totals.quoteCount / Math.max(months.length, 1))} average per month`, sparkline: months.map((m) => ({ month: m.label, value: m.quoteCount })) },
    { key: "quoteValue", label: "Total Quote Value", value: totals.quoteValue, previousValue: previous?.quoteValue ?? null, format: "currency", supportingText: `${formatCompactCurrency(totals.quoteValue / Math.max(months.length, 1))} average per month`, sparkline: months.map((m) => ({ month: m.label, value: m.quoteValue })) },
    { key: "acceptedCount", label: "Accepted Quotes", value: totals.acceptedCount, previousValue: previous?.acceptedCount ?? null, format: "count", supportingText: `${formatCompactCurrency(totals.acceptedValue)} accepted value`, sparkline: months.map((m) => ({ month: m.label, value: m.acceptedCount })) },
    { key: "acceptanceRateCount", label: "Overall Acceptance Rate", value: totals.acceptanceRateCount, previousValue: previous?.acceptanceRateCount ?? null, format: "percent", supportingText: `${totals.quoteCount.toLocaleString("en-US")} non-excluded quotes`, sparkline: months.map((m) => ({ month: m.label, value: m.acceptanceRateCount })) },
  ];
  return definitions.map((item) => ({
    ...item,
    deltaPercent: item.key === "acceptanceRateCount"
      ? item.value === null || item.previousValue === null ? null : item.value - item.previousValue
      : percentChange(months.at(-1)?.[item.key] ?? null, item.previousValue),
  }));
}

function buildAcceptanceSummary(months: QuoteMonthlyMetric[]): QuoteMetricsReadModel["acceptanceSummary"] {
  const acceptedCount = sum(months.map((m) => m.acceptedCount));
  const notAcceptedCount = sum(months.map((m) => m.notAcceptedCount));
  const acceptedValue = sum(months.map((m) => m.acceptedValue));
  const notAcceptedValue = sum(months.map((m) => m.notAcceptedValue));
  const denominatorCount = acceptedCount + notAcceptedCount;
  const denominatorValue = acceptedValue + notAcceptedValue;
  return {
    acceptedCount,
    notAcceptedCount,
    excludedCount: sum(months.map((m) => m.excludedCount)),
    denominatorCount,
    acceptanceRateCount: nullableRate(acceptedCount, denominatorCount),
    acceptedValue,
    notAcceptedValue,
    denominatorValue,
    acceptanceRateValue: nullableRate(acceptedValue, denominatorValue),
  };
}

function buildYoyRows(current: QuoteMonthlyMetric | null, prior: QuoteMonthlyMetric | null, priorFull: QuoteMonthlyMetric | null) {
  const specs: Array<[string, keyof QuoteMonthlyMetric, "count" | "currency" | "percent"]> = [
    ["Quotes", "quoteCount", "count"],
    ["Quote Value", "quoteValue", "currency"],
    ["Accepted", "acceptedCount", "count"],
    ["Not Accepted", "notAcceptedCount", "count"],
    ["Count Acceptance", "acceptanceRateCount", "percent"],
    ["Accepted Value", "acceptedValue", "currency"],
    ["Value Acceptance", "acceptanceRateValue", "percent"],
  ];
  return specs.map(([label, key, format]) => ({
    label,
    current: numericMetric(current?.[key]),
    priorYear: numericMetric(prior?.[key]),
    priorYearFull: numericMetric(priorFull?.[key]),
    changePercent: format === "percent" ? null : percentChange(numericMetric(current?.[key]), numericMetric(prior?.[key])),
    format,
  }));
}

function buildTrends(months: QuoteMonthlyMetric[]): QuoteMetricsReadModel["trends"] {
  return months.map((month, index) => ({
    month: month.label,
    provisional: month.provisional,
    acceptanceRateCount: month.acceptanceRateCount,
    acceptanceRateCount3Month: aggregateWindowRate(months, index, 3, "acceptedCount", "quoteCount"),
    acceptanceRateCount12Month: aggregateWindowRate(months, index, 12, "acceptedCount", "quoteCount"),
    acceptanceRateValue: month.acceptanceRateValue,
    acceptanceRateValue3Month: aggregateWindowRate(months, index, 3, "acceptedValue", "quoteValue"),
    acceptanceRateValue12Month: aggregateWindowRate(months, index, 12, "acceptedValue", "quoteValue"),
  }));
}

function buildMonthlyTierTrend(month: QuoteMonthlyMetric): QuoteMonthlyTierTrend {
  const byTier = Object.fromEntries(quoteDealTiers.map((tier) => {
    const metric = month.byTier[tier];
    return [tier, {
      quoteCount: metric.quoteCount,
      acceptedCount: metric.acceptedCount,
      notAcceptedCount: metric.notAcceptedCount,
      acceptanceRateCount: nullableRate(metric.acceptedCount, metric.quoteCount),
    }];
  })) as QuoteMonthlyTierTrend["byTier"];
  return { month: month.label, monthKey: month.month, provisional: month.provisional, byTier };
}

function aggregateWindowRate(months: QuoteMonthlyMetric[], index: number, size: number, numerator: "acceptedCount" | "acceptedValue", denominator: "quoteCount" | "quoteValue") {
  const window = months.slice(Math.max(0, index + 1 - size), index + 1);
  return nullableRate(sum(window.map((m) => m[numerator])), sum(window.map((m) => m[denominator])));
}

function buildMonthlyFooter(months: QuoteMonthlyMetric[]): QuoteMetricsReadModel["monthlyFooter"] {
  const metric = {
    quoteCount: sum(months.map((m) => m.quoteCount)),
    quoteValue: sum(months.map((m) => m.quoteValue)),
    acceptedCount: sum(months.map((m) => m.acceptedCount)),
    acceptedValue: sum(months.map((m) => m.acceptedValue)),
    notAcceptedCount: sum(months.map((m) => m.notAcceptedCount)),
    notAcceptedValue: sum(months.map((m) => m.notAcceptedValue)),
  };
  return { ...metric, averageAcceptedDeal: nullableDivide(metric.acceptedValue, metric.acceptedCount), acceptanceRateCount: nullableRate(metric.acceptedCount, metric.quoteCount), acceptanceRateValue: nullableRate(metric.acceptedValue, metric.quoteValue) };
}

function buildCategoryAcceptance(quotes: NormalizedQuote[]): QuoteMetricsReadModel["acceptanceByCategory"] {
  return (["HVAC", "Water Heating", "Unclassified"] as const).map((category) => {
    const metric = summarizeQuotes(quotes.filter((q) => q.outcome !== "excluded" && q.category === category));
    return { category, ...metric, acceptanceRateCount: nullableRate(metric.acceptedCount, metric.quoteCount), acceptanceRateValue: nullableRate(metric.acceptedValue, metric.quoteValue) };
  });
}

function buildAcceptancePaths(quotes: NormalizedQuote[]): QuoteMetricsReadModel["acceptancePaths"] {
  return quoteAcceptancePaths.filter((path) => path !== "excluded").map((path) => {
    const matching = quotes.filter((q) => q.acceptancePath === path);
    return { path, label: quoteAcceptancePathLabels[path], count: matching.length, value: sum(matching.map((q) => q.totalValue)) };
  });
}

function buildLargestNotAccepted(quotes: NormalizedQuote[], asOfDate: Date): QuoteMetricsReadModel["largestNotAccepted"] {
  return quotes.filter((q) => q.outcome === "not_accepted").sort((a, b) => b.totalValue - a.totalValue || a.quoteId - b.quoteId).slice(0, 15).map((q, index) => ({
    rank: index + 1, quoteId: q.quoteId, quoteNo: q.quoteNo, name: q.name, dateIssued: q.dateIssued!, ageDays: calendarAgeInDays(q.issued, asOfDate), value: q.totalValue, category: q.category, tier: q.tier, evidence: q.evidence,
  }));
}

function buildClassificationRows(quotes: NormalizedQuote[], sort: QuoteSort): QuoteClassificationRow[] {
  return quotes.map((q) => ({
    quoteId: q.quoteId,
    quoteNo: q.quoteNo,
    name: q.name,
    dateIssued: q.dateIssued!,
    dateApproved: q.dateApproved,
    value: q.totalValue,
    status: q.status,
    category: q.category,
    categoryBasis: q.categoryBasis,
    tier: q.tier,
    outcome: q.outcome,
    acceptancePath: q.acceptancePath,
    evidence: q.evidence,
    linkedJobId: q.linkedJobId,
    inverseConversionMatch: q.inverseConversionMatch,
    override: q.override,
  })).sort((a, b) => compareRows(a, b, sort));
}

function buildFilterOptions(quotes: NormalizedQuote[]) {
  return {
    categories: uniqueSorted(quotes.map((q) => q.category)),
    tiers: [...quoteDealTiers],
    outcomes: [...quoteAcceptanceOutcomes],
    acceptancePaths: quoteAcceptancePaths.map((path) => ({ path, label: quoteAcceptancePathLabels[path] })),
  };
}

function includeActiveFilterOptions(options: QuoteMetricsReadModel["filterOptions"], filters: QuoteDashboardFilters) {
  return {
    categories: filters.category && !options.categories.includes(filters.category) ? [...options.categories, filters.category].sort() : options.categories,
    tiers: options.tiers,
    outcomes: options.outcomes,
    acceptancePaths: options.acceptancePaths,
  };
}

function normalizeDashboardFilters(options: QuoteMetricsReadModelOptions): QuoteDashboardFilters {
  const tier = quoteDealTiers.includes(options.tier as QuoteDealTier) ? options.tier as QuoteDealTier : "";
  const outcome = quoteAcceptanceOutcomes.includes(options.outcome as QuoteAcceptanceOutcome) ? options.outcome as QuoteAcceptanceOutcome : "";
  const acceptancePath = quoteAcceptancePaths.includes(options.acceptancePath as QuoteAcceptancePath) ? options.acceptancePath as QuoteAcceptancePath : "";
  const sort = quoteSorts.includes(options.sort as QuoteSort) ? options.sort as QuoteSort : "date-desc";
  const page = Number(options.page);
  return {
    search: cleanFilter(options.search),
    category: cleanFilter(options.category),
    tier,
    outcome,
    acceptancePath,
    sort,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

function matchesDashboardFilters(quote: NormalizedQuote, filters: QuoteDashboardFilters) {
  const search = filters.search.toLowerCase();
  return (!search || quote.quoteNo.toLowerCase().includes(search) || quote.name.toLowerCase().includes(search))
    && (!filters.category || quote.category === filters.category)
    && (!filters.tier || quote.tier === filters.tier)
    && (!filters.outcome || quote.outcome === filters.outcome)
    && (!filters.acceptancePath || quote.acceptancePath === filters.acceptancePath);
}

function compareRows(a: QuoteClassificationRow, b: QuoteClassificationRow, sort: QuoteSort) {
  const byId = a.quoteId - b.quoteId;
  if (sort === "date-asc") return a.dateIssued.localeCompare(b.dateIssued) || byId;
  if (sort === "value-desc") return b.value - a.value || byId;
  if (sort === "value-asc") return a.value - b.value || byId;
  if (sort === "quote-asc") return a.quoteNo.localeCompare(b.quoteNo) || byId;
  if (sort === "quote-desc") return b.quoteNo.localeCompare(a.quoteNo) || byId;
  return b.dateIssued.localeCompare(a.dateIssued) || b.quoteId - a.quoteId;
}

function acceptanceSegment(tier: QuoteDealTier, metric: QuoteTierMetric) {
  return { tier, ...metric, acceptanceRateCount: nullableRate(metric.acceptedCount, metric.quoteCount), acceptanceRateValue: nullableRate(metric.acceptedValue, metric.quoteValue) };
}

function summarizeQuotes(quotes: NormalizedQuote[]): QuoteTierMetric {
  const metric = emptyTierMetric();
  for (const quote of quotes) addQuote(metric, quote);
  return metric;
}

function addQuote(metric: QuoteTierMetric, quote: NormalizedQuote) {
  metric.quoteCount += 1;
  metric.quoteValue += quote.totalValue;
  if (quote.outcome === "accepted") {
    metric.acceptedCount += 1;
    metric.acceptedValue += quote.totalValue;
  } else {
    metric.notAcceptedCount += 1;
    metric.notAcceptedValue += quote.totalValue;
  }
}

function emptyTierMetric(): QuoteTierMetric {
  return { quoteCount: 0, quoteValue: 0, acceptedCount: 0, acceptedValue: 0, notAcceptedCount: 0, notAcceptedValue: 0 };
}

function acceptanceEvidence(path: QuoteAcceptancePath) {
  if (path === "accepted_online_and_converted") return "Accepted-online status and exact converted-job relationship";
  if (path === "accepted_online_only") return "Accepted-online status";
  if (path === "converted_only") return "Exact converted-job relationship";
  if (path === "excluded") return "Explicit Excluded override";
  return "No accepted-online status or exact converted-job relationship";
}

function normalizeOverrideEffect(outcome: string | null, legacyWon: boolean | null): "excluded" | "legacy_accept" | "legacy_not_accept" | null {
  if (outcome?.toLowerCase() === "excluded") return "excluded";
  if (outcome?.toLowerCase() === "won" || legacyWon === true) return "legacy_accept";
  if (outcome?.toLowerCase() === "lost" || legacyWon === false) return "legacy_not_accept";
  return null;
}

function normalizeCategory(value: string | null): "HVAC" | "Water Heating" | "Unclassified" {
  const clean = cleanDisplayText(value)?.toLowerCase();
  if (clean === "hvac") return "HVAC";
  if (clean === "water heating") return "Water Heating";
  return "Unclassified";
}

function normalizeTier(value: string | null, total: number): QuoteDealTier {
  return quoteDealTiers.includes(value as QuoteDealTier) ? value as QuoteDealTier : dealTier(total);
}

function emptyQuoteMetricsReadModel(freshness: FreshnessStatus, warning: string, options: QuoteMetricsReadModelOptions): QuoteMetricsReadModel {
  const now = options.now ?? new Date();
  const selectedMonth = normalizeMonthKey(options.selectedMonth) ?? monthKey(losAngelesDate(now));
  const filters = normalizeDashboardFilters(options);
  return {
    freshness, generatedAt: now.toISOString(), selectedMonth, warnings: [warning], contractGaps: [], quotesLoaded: 0,
    currentMonth: null, priorMonth: null, priorYearSameDay: null, priorYearSameMonth: null,
    provisional: { isCurrentMonthPartial: false, elapsedDays: 0, daysInMonth: getDaysInMonth(parseMonthKey(selectedMonth)), pace: { quoteCount: 0, acceptedCount: 0, quoteValue: 0 }, sameDayYoY: { quoteCount: null, acceptedCount: null, quoteValue: null } },
    trailingWindow: { startMonth: addMonthsKey(selectedMonth, -11), endMonth: selectedMonth, monthCount: 12 }, trailingKpis: [],
    acceptanceSummary: { acceptedCount: 0, notAcceptedCount: 0, excludedCount: 0, denominatorCount: 0, acceptanceRateCount: null, acceptedValue: 0, notAcceptedValue: 0, denominatorValue: 0, acceptanceRateValue: null },
    yoyRows: [], monthlyAcceptance: [], monthlyTierTrends: [], acceptanceByTier: quoteDealTiers.map((tier) => acceptanceSegment(tier, emptyTierMetric())), trends: [], heatmap: quoteDealTiers.map((tier) => ({ tier, months: [] })), monthlyBreakdown: [],
    sentMonthly: [], sentBasis: "DateIssued",
    followUpQueue: {
      scope: `${selectedMonth} cohort: pending quote data.`,
      asOf: losAngelesDate(now).toISOString().slice(0, 10),
      totalCount: 0,
      totalValue: 0,
      rows: [],
      byCustomer: [],
    },
    monthlyFooter: { ...emptyTierMetric(), averageAcceptedDeal: null, acceptanceRateCount: null, acceptanceRateValue: null },
    acceptanceByCategory: (["HVAC", "Water Heating", "Unclassified"] as const).map((category) => ({ category, ...emptyTierMetric(), acceptanceRateCount: null, acceptanceRateValue: null })),
    acceptancePaths: [], largestNotAccepted: [], classificationRows: [], filters,
    pagination: { page: 1, pageSize: quoteDashboardPageSize, classificationPages: 1, classificationTotal: 0 },
    filterOptions: includeActiveFilterOptions({
      categories: [],
      tiers: [...quoteDealTiers],
      outcomes: [...quoteAcceptanceOutcomes],
      acceptancePaths: quoteAcceptancePaths.map((path) => ({ path, label: quoteAcceptancePathLabels[path] })),
    }, filters),
    methodology: { acceptanceDefinition: "Pending quote data.", acceptanceDenominator: "All non-excluded DateIssued quotes.", dateBasis: "DateIssued.", provisionalHandling: "Pending quote data.", overrides: { activeCount: 0, latestAt: null, affordance: "Only Excluded can change dashboard classification." } },
  };
}

function cleanDisplayText(value: string | null | undefined) {
  return plainDisplayText(value ?? null, "") || null;
}
function cleanFilter(value: string | undefined) { return value?.trim().slice(0, 200) ?? ""; }
function uniqueSorted(values: string[]) { return [...new Set(values)].sort((a, b) => a.localeCompare(b)); }
function normalizeMonthKey(value: string | undefined) { return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null; }
function parseMonthKey(value: string) { return new Date(`${value}-01T00:00:00Z`); }
function monthKey(date: Date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }
function addMonthsKey(value: string, amount: number) { const d = parseMonthKey(value); d.setUTCMonth(d.getUTCMonth() + amount); return monthKey(d); }
function buildMonthKeys(end: string, count: number) { return Array.from({ length: count }, (_, index) => addMonthsKey(end, -index)); }
function getDaysInMonth(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); }
function parseDate(value: string | null) { if (!value) return null; const d = new Date(`${value.slice(0, 10)}T00:00:00Z`); return Number.isNaN(d.getTime()) ? null : d; }
function losAngelesDate(now: Date) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now); const get = (type: string) => Number(parts.find((p) => p.type === type)?.value); return new Date(Date.UTC(get("year"), get("month") - 1, get("day"))); }
function calendarAgeInDays(dateIssued: Date, asOfDate: Date) { return Math.max(0, Math.floor((asOfDate.getTime() - dateIssued.getTime()) / 86_400_000)); }
function nullableRate(numerator: number, denominator: number) { return denominator > 0 ? numerator / denominator * 100 : null; }
function nullableDivide(numerator: number, denominator: number) { return denominator > 0 ? numerator / denominator : null; }
function percentChange(current: number | null, previous: number | null) { if (current === null || previous === null || previous === 0) return null; return (current - previous) / previous * 100; }
function numericMetric(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }
function finiteNumber(value: string | number | null) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function finiteInteger(value: string | number | null) { const n = Number(value); return Number.isSafeInteger(n) ? n : 0; }
function nullableInteger(value: string | number | null) { if (value === null || value === "") return null; const n = Number(value); return Number.isSafeInteger(n) ? n : null; }
function formatCompact(value: number) { return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatCompactCurrency(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value); }
