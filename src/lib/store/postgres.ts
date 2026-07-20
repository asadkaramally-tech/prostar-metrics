export type QueryResult<T> = {
  rows: T[];
  rowCount: number | null;
};

export type PostgresQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<T>>;

type PgClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  release(): void;
};

type PgPool = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
};

type PgModule = {
  Pool: new (config: {
    connectionString: string;
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    ssl?: {
      rejectUnauthorized: boolean;
      ca?: string;
    };
  }) => PgPool;
};

type PgSslConfig = {
  rejectUnauthorized: boolean;
  ca?: string;
};

type Environment = Readonly<Record<string, string | undefined>>;

export type PgPoolLimits = {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
};

let poolPromise: Promise<PgPool> | null = null;

export function getDatabaseConfigStatus() {
  return {
    configured: Boolean(process.env.AZURE_POSTGRES_CONNECTION_STRING),
    sslConfigured: Boolean(process.env.POSTGRES_SSL_CA_CERT || process.env.POSTGRES_SSL_CA_CERT_BASE64),
  };
}

export async function getDatabaseHealthStatus(
  probe: () => Promise<unknown> = () => queryPostgres("select 1 as ready"),
) {
  const config = getDatabaseConfigStatus();
  if (!config.configured) {
    return { ...config, connected: false, latencyMs: null };
  }

  const startedAt = performance.now();
  try {
    await probe();
    return {
      ...config,
      connected: true,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch {
    return {
      ...config,
      connected: false,
      latencyMs: null,
    };
  }
}

export function buildPostgresSslConfig(env: Environment = process.env): PgSslConfig {
  const rejectUnauthorized = env.POSTGRES_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase() === "false" ? false : true;
  const ca = readPostgresCaCert(env);

  return ca ? { rejectUnauthorized, ca } : { rejectUnauthorized };
}

export function buildPostgresPoolLimits(env: Environment = process.env): PgPoolLimits {
  return {
    max: boundedInteger(env.POSTGRES_POOL_MAX, 1, 10, env.POSTGRES_POOL_MAX === undefined ? 1 : 10),
    idleTimeoutMillis: boundedInteger(env.POSTGRES_POOL_IDLE_TIMEOUT_MS, 1_000, 300_000, 30_000),
    connectionTimeoutMillis: boundedInteger(env.POSTGRES_CONNECTION_TIMEOUT_MS, 1_000, 60_000, 10_000),
  };
}

export async function queryPostgres<T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  const pool = await getPool();
  return pool.query<T>(text, values);
}

export async function withPostgresTransaction<T>(
  callback: (query: PostgresQuery) => Promise<T>,
): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  const query: PostgresQuery = (text, values) => client.query(text, values);
  let transactionStarted = false;
  try {
    await query("begin");
    transactionStarted = true;
    const result = await callback(query);
    await query("commit");
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await query("rollback");
      } catch {
        // Preserve the callback or commit error that triggered the rollback.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closePostgresPool(): Promise<void> {
  const current = poolPromise;
  poolPromise = null;
  if (current) await (await current).end();
}

async function getPool(): Promise<PgPool> {
  if (!poolPromise) {
    poolPromise = (async () => {
      const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error("AZURE_POSTGRES_CONNECTION_STRING is required for the app-owned metrics store.");
      }

      const { Pool } = await loadPg();
      return new Pool({
        connectionString,
        ...buildPostgresPoolLimits(),
        ssl: buildPostgresSslConfig(),
      });
    })();
  }

  return poolPromise;
}

function boundedInteger(
  raw: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

async function loadPg(): Promise<PgModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<PgModule>;

  return dynamicImport("pg");
}

function readPostgresCaCert(env: Environment): string | undefined {
  const rawCert = env.POSTGRES_SSL_CA_CERT?.trim();
  if (rawCert) {
    return rawCert.replace(/\\n/g, "\n");
  }

  const encodedCert = env.POSTGRES_SSL_CA_CERT_BASE64?.trim();
  if (!encodedCert) {
    return undefined;
  }

  const decoded = Buffer.from(encodedCert, "base64").toString("utf8").trim();
  return decoded ? decoded.replace(/\\n/g, "\n") : undefined;
}
