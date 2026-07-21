export type QuoteAcceptanceOutcome = "accepted" | "not_accepted" | "excluded";
export type QuoteOutcome = "won" | "lost" | "open" | "excluded" | "unknown";

export type QuoteAcceptancePath =
  | "accepted_online_and_converted"
  | "accepted_online_only"
  | "converted_only"
  | "not_accepted"
  | "excluded";

export type QuoteClassificationInput = {
  quoteId: string | number;
  totalValue: number;
  dateIssued?: string | null;
  dateApproved?: string | null;
  statusName?: string | null;
  linkedJobId?: string | number | null;
  /** @deprecated Descriptive JobNo equality is never acceptance evidence. */
  exactJobNoMatchId?: string | number | null;
  convertedFromJobId?: string | number | null;
  outcomeOverride?: string | null;
  wonOverride?: boolean | null;
  stageName?: string | null;
  customerStageName?: string | null;
  isClosed?: boolean | null;
  verifiedStageOutcome?: QuoteOutcome | null;
  verifiedStageReason?: string | null;
};

export type QuoteAcceptanceClassification = {
  outcome: QuoteOutcome;
  acceptanceOutcome: QuoteAcceptanceOutcome;
  accepted: boolean;
  won: boolean;
  path: QuoteAcceptancePath;
  reason: string;
  dealTier: "Under $750" | "$750-$2K" | "$2K-$10K" | "$10K+";
};

export type PaceInput = {
  actualToDate: number;
  elapsedDays: number;
  daysInMonth: number;
};

export type NormalizedQuoteSnapshot = QuoteClassificationInput & {
  quoteNo?: string | null;
  category?: string | null;
  sourceDeletedAt?: string | null;
};

export type QuoteMonthlyReadModel = {
  periodStart: string;
  periodEnd: string;
  quoteCount: number;
  quoteValue: number;
  acceptedCount: number;
  acceptedValue: number;
  notAcceptedCount: number;
  notAcceptedValue: number;
  acceptanceDenominatorCount: number;
  acceptanceDenominatorValue: number;
  excludedCount: number;
  acceptanceRateByCount: number;
  acceptanceRateByValue: number;
  averageAcceptedDeal: number;
  dateBasis: "DateIssued";
  tiers: Record<QuoteAcceptanceClassification["dealTier"], {
    quoteCount: number;
    quoteValue: number;
    acceptedCount: number;
    acceptedValue: number;
    notAcceptedCount: number;
    notAcceptedValue: number;
  }>;
  acceptancePaths: Record<QuoteAcceptancePath, number>;
  overrideCount: number;
  excludedWithoutDateIssued: number;
  /** @deprecated Internal compatibility accessor; omitted from serialized payloads. */
  wonCount: number;
  /** @deprecated Internal compatibility accessor; omitted from serialized payloads. */
  winRateByCount: number;
};

export const ACCEPTED_ONLINE_STATUS = "quote accepted online";
const QUOTE_STATUS_NAMESPACE = "quote:";

export function normalizeQuoteStatusName(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.startsWith(QUOTE_STATUS_NAMESPACE)
    ? normalized.slice(QUOTE_STATUS_NAMESPACE.length).trim()
    : normalized;
}

export function isAcceptedOnlineStatus(value: string | null | undefined): boolean {
  return normalizeQuoteStatusName(value) === ACCEPTED_ONLINE_STATUS;
}

export function acceptedOnlineStatusSql(columnExpression: string): string {
  const trimmed = `trim(coalesce(${columnExpression}, ''))`;
  const normalized = `lower(${trimmed})`;
  return `lower(trim(case
    when ${normalized} like '${QUOTE_STATUS_NAMESPACE}%'
      then substr(${trimmed}, position(':' in ${trimmed}) + 1)
    else ${trimmed}
  end)) = '${ACCEPTED_ONLINE_STATUS}'`;
}

export function classifyQuote(input: QuoteClassificationInput): QuoteAcceptanceClassification {
  if (normalizeOutcome(input.outcomeOverride) === "excluded") {
    return classification("excluded", "excluded", "manual_excluded", input.totalValue);
  }

  const acceptedOnline = isAcceptedOnlineStatus(input.statusName);
  const converted = hasValue(input.linkedJobId) || hasValue(input.convertedFromJobId);

  if (acceptedOnline && converted) {
    return classification("accepted", "accepted_online_and_converted", "accepted_online_and_converted", input.totalValue);
  }
  if (acceptedOnline) {
    return classification("accepted", "accepted_online_only", "accepted_online", input.totalValue);
  }
  if (converted) {
    return classification("accepted", "converted_only", "converted_job", input.totalValue);
  }

  return classification("not_accepted", "not_accepted", "no_acceptance_evidence", input.totalValue);
}

function classification(
  outcome: QuoteAcceptanceOutcome,
  path: QuoteAcceptancePath,
  reason: string,
  value: number,
): QuoteAcceptanceClassification {
  const accepted = outcome === "accepted";
  return {
    outcome: outcome === "excluded" ? "excluded" : accepted ? "won" : "lost",
    acceptanceOutcome: outcome,
    accepted,
    won: accepted,
    path,
    reason,
    dealTier: dealTier(value),
  };
}

// Legacy ingestion callers still provide stage data through this helper. Stage is
// deliberately not acceptance evidence under the locked rule.
export function verifiedQuoteStageClassification(customerStageName?: string | null): Pick<QuoteClassificationInput, "verifiedStageOutcome" | "verifiedStageReason"> {
  void customerStageName;
  return { verifiedStageOutcome: null, verifiedStageReason: null };
}

export function dealTier(value: number): QuoteAcceptanceClassification["dealTier"] {
  if (value < 750) return "Under $750";
  if (value < 2000) return "$750-$2K";
  if (value < 10000) return "$2K-$10K";
  return "$10K+";
}

export function projectedMonthEndPace({ actualToDate, elapsedDays, daysInMonth }: PaceInput): number {
  if (elapsedDays <= 0 || daysInMonth <= 0) return 0;
  return (actualToDate / elapsedDays) * daysInMonth;
}

export function sameDayNormalizedYoY(currentToDate: number, priorSameDayActual: number): number {
  if (priorSameDayActual === 0) return currentToDate === 0 ? 0 : 100;
  return ((currentToDate - priorSameDayActual) / priorSameDayActual) * 100;
}

export function rollingAverage(values: number[], windowSize: number): Array<number | null> {
  return values.map((_, index) => {
    if (index + 1 < windowSize) return null;
    const window = values.slice(index + 1 - windowSize, index + 1);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

export function buildQuoteMonthlyReadModel(params: {
  quotes: NormalizedQuoteSnapshot[];
  periodStart: string;
  periodEnd: string;
}): QuoteMonthlyReadModel {
  const tiers = emptyTierBuckets();
  const acceptancePaths = emptyAcceptancePaths();
  let quoteCount = 0;
  let quoteValue = 0;
  let acceptedCount = 0;
  let acceptedValue = 0;
  let notAcceptedCount = 0;
  let notAcceptedValue = 0;
  let excludedCount = 0;
  let overrideCount = 0;
  let excludedWithoutDateIssued = 0;

  for (const quote of params.quotes) {
    if (quote.sourceDeletedAt) continue;
    if (!quote.dateIssued) {
      excludedWithoutDateIssued += 1;
      continue;
    }
    if (!isDateInRange(quote.dateIssued, params.periodStart, params.periodEnd)) continue;

    const result = classifyQuote(quote);
    const value = finiteNumber(quote.totalValue);
    if (quote.outcomeOverride || quote.wonOverride !== undefined && quote.wonOverride !== null) overrideCount += 1;
    acceptancePaths[result.path] += 1;
    if (result.acceptanceOutcome === "excluded") {
      excludedCount += 1;
      continue;
    }

    const tier = tiers[result.dealTier];
    quoteCount += 1;
    quoteValue += value;
    tier.quoteCount += 1;
    tier.quoteValue += value;
    if (result.accepted) {
      acceptedCount += 1;
      acceptedValue += value;
      tier.acceptedCount += 1;
      tier.acceptedValue += value;
    } else {
      notAcceptedCount += 1;
      notAcceptedValue += value;
      tier.notAcceptedCount += 1;
      tier.notAcceptedValue += value;
    }
  }

  const model = {
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    quoteCount,
    quoteValue,
    acceptedCount,
    acceptedValue,
    notAcceptedCount,
    notAcceptedValue,
    acceptanceDenominatorCount: quoteCount,
    acceptanceDenominatorValue: quoteValue,
    excludedCount,
    acceptanceRateByCount: quoteCount > 0 ? acceptedCount / quoteCount * 100 : 0,
    acceptanceRateByValue: quoteValue > 0 ? acceptedValue / quoteValue * 100 : 0,
    averageAcceptedDeal: acceptedCount > 0 ? acceptedValue / acceptedCount : 0,
    dateBasis: "DateIssued",
    tiers,
    acceptancePaths,
    overrideCount,
    excludedWithoutDateIssued,
  } as QuoteMonthlyReadModel;
  Object.defineProperties(model, {
    wonCount: { enumerable: false, get: () => model.acceptedCount },
    winRateByCount: { enumerable: false, get: () => model.acceptanceRateByCount },
  });
  return model;
}

function emptyTierBuckets(): QuoteMonthlyReadModel["tiers"] {
  const bucket = () => ({ quoteCount: 0, quoteValue: 0, acceptedCount: 0, acceptedValue: 0, notAcceptedCount: 0, notAcceptedValue: 0 });
  return {
    "Under $750": bucket(),
    "$750-$2K": bucket(),
    "$2K-$10K": bucket(),
    "$10K+": bucket(),
  };
}

function emptyAcceptancePaths(): Record<QuoteAcceptancePath, number> {
  return { accepted_online_and_converted: 0, accepted_online_only: 0, converted_only: 0, not_accepted: 0, excluded: 0 };
}

function isDateInRange(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeOutcome(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function hasValue(value: string | number | null | undefined) {
  return value !== null && value !== undefined && value !== "";
}
