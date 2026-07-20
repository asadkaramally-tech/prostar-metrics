import { createHash } from "node:crypto";
import { loadSimproConfig, type SimproConfig } from "@/lib/simpro/config";
import { DistributedSimproRateLimiter } from "@/lib/simpro/distributed-rate-limiter";
import { RateLimiter } from "@/lib/simpro/rate-limiter";

export class SimproError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SimproError";
  }
}

export function isSimproNotFound(error: unknown): error is SimproError {
  return error instanceof SimproError && Number(error.details.status) === 404;
}

export type RequestBudget = {
  limit: number;
  used: number;
};

export type SimproListOptions = {
  pageSize?: number;
  startPage?: number;
  requestBudget?: RequestBudget;
  query?: Record<string, unknown>;
};

export type SimproPage<T> = {
  rows: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  continuationToken: { page: number } | null;
};

type RequestGate = { wait(): Promise<void> };

export type SimproClientDependencies = {
  localLimiter?: RequestGate;
  distributedLimiter?: RequestGate;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

export class SimproClient {
  private readonly limiter: RequestGate;
  private readonly distributedLimiter: RequestGate;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(
    private readonly config: SimproConfig = loadSimproConfig(),
    dependencies: SimproClientDependencies = {},
  ) {
    this.limiter = dependencies.localLimiter ?? new RateLimiter(config.requestsPerSecond);
    this.distributedLimiter = dependencies.distributedLimiter ?? new DistributedSimproRateLimiter(config.requestsPerSecond);
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.sleepImpl = dependencies.sleepImpl ?? sleep;
  }

  async getJson<T>(path: string, query?: Record<string, unknown>, budget?: RequestBudget): Promise<T> {
    const response = await this.requestWithRetry("GET", this.companyPath(path), query, budget);
    const text = await response.text();
    if (!text.trim()) {
      return {} as T;
    }

    return JSON.parse(text) as T;
  }

  async getPage<T extends Record<string, unknown>>(path: string, options: SimproListOptions = {}): Promise<SimproPage<T>> {
    const pageSize = Math.min(this.config.maxPageSize, Math.max(1, options.pageSize ?? this.config.maxPageSize));
    const page = Math.max(1, options.startPage ?? 1);
    const rows = coerceRows<T>(
      await this.getJson<unknown>(
        path,
        {
          ...(options.query ?? {}),
          page,
          pageSize,
        },
        options.requestBudget,
      ),
    );

    const hasMore = rows.length >= pageSize;
    return {
      rows,
      page,
      pageSize,
      hasMore,
      continuationToken: hasMore ? { page: page + 1 } : null,
    };
  }

  private async requestWithRetry(
    method: string,
    path: string,
    query?: Record<string, unknown>,
    budget?: RequestBudget,
  ): Promise<Response> {
    this.requireToken();
    let attempt = 0;
    let lastError: unknown;

    while (attempt < 4) {
      attempt += 1;
      this.requireBudgetAvailable(budget);
      await this.distributedLimiter.wait();
      await this.limiter.wait();
      this.consumeBudget(budget);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      let retryAfterMs = 0;

      try {
        const response = await this.fetchImpl(this.url(path, query), {
          method,
          headers: {
            Authorization: `Bearer ${this.config.bearerToken}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (response.ok) {
          return response;
        }

        if (![429, 500, 502, 503, 504].includes(response.status)) {
          const body = await response.text().catch(() => "");
          throw new SimproError(`Simpro ${method} ${path} failed: ${response.status} ${response.statusText}`, {
            path,
            method,
            status: response.status,
            body: body.slice(0, 1000),
            retryable: false,
          });
        }

        lastError = new SimproError(`Retryable Simpro ${method} ${path} failure: ${response.status}`, {
          path,
          method,
          status: response.status,
          retryable: true,
        });
        retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      } catch (error) {
        if (error instanceof SimproError && error.details.retryable === false) {
          throw error;
        }
        lastError = error;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < 4) {
        await this.sleepImpl(Math.max(backoffMs(attempt), retryAfterMs));
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new SimproError(`Simpro ${method} ${path} failed after retries`, { path, method });
  }

  private url(path: string, query?: Record<string, unknown>): URL {
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private companyPath(path: string): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    if (cleanPath.startsWith("/companies/")) {
      return cleanPath;
    }

    return `/companies/${encodeURIComponent(this.config.companyId)}${cleanPath}`;
  }

  private requireToken(): void {
    if (!this.config.bearerToken) {
      throw new SimproError("SIMPRO_BEARER_TOKEN is not configured");
    }
  }

  private consumeBudget(budget: RequestBudget | undefined): void {
    if (!budget) {
      return;
    }

    this.requireBudgetAvailable(budget);
    budget.used += 1;
  }

  private requireBudgetAvailable(budget: RequestBudget | undefined): void {
    if (!budget) {
      return;
    }

    if (budget.used >= budget.limit) {
      throw new SimproError("Simpro request budget exhausted", { limit: budget.limit, used: budget.used });
    }
  }
}

export function coerceRows<T extends Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord) as T[];
  }

  if (isRecord(value)) {
    for (const key of ["items", "Items", "data", "Data", "results", "Results", "jobs", "Jobs"]) {
      if (Array.isArray(value[key])) {
        return value[key].filter(isRecord) as T[];
      }
    }

    return [value as T];
  }

  return [];
}

export function sourceHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * Math.max(50, base * 0.25));
}

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number {
  if (!value?.trim()) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt) ? 0 : Math.max(0, retryAt - nowMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
