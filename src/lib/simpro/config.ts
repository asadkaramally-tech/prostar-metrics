export type SimproConfig = {
  baseUrl: string;
  companyId: string;
  bearerToken: string;
  requestsPerSecond: number;
  requestTimeoutMs: number;
  maxPageSize: number;
};

type Env = Record<string, string | undefined>;

export function loadSimproConfig(env: Env = process.env): SimproConfig {
  return {
    baseUrl: (env.SIMPRO_BASE_URL || "https://prostarmechanical.simprosuite.com/api/v1.0").replace(/\/+$/, ""),
    companyId: env.SIMPRO_COMPANY_ID || "0",
    bearerToken: env.SIMPRO_BEARER_TOKEN || "",
    requestsPerSecond: boundedInt(env.SIMPRO_REQUESTS_PER_SECOND, 5, 1, 5),
    requestTimeoutMs: boundedInt(env.SIMPRO_REQUEST_TIMEOUT_MS, 60000, 1000, 300000),
    maxPageSize: boundedInt(env.SIMPRO_MAX_PAGE_SIZE, 250, 1, 250),
  };
}

export function publicSimproConfigStatus(config: SimproConfig) {
  return {
    baseUrl: config.baseUrl,
    companyId: config.companyId,
    tokenConfigured: Boolean(config.bearerToken),
    requestsPerSecond: config.requestsPerSecond,
    requestTimeoutMs: config.requestTimeoutMs,
    maxPageSize: config.maxPageSize,
  };
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}
