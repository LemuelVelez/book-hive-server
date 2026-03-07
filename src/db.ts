import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * Connect to Postgres with smart SSL defaults:
 * - Local (localhost/127.0.0.1/private hosts) -> SSL OFF
 * - Cloud (Render/Neon/Supabase/etc.)         -> SSL ON (no-verify)
 * - Can be overridden with env DATABASE_SSL=true/false
 * - Respects sslmode in DATABASE_URL when present
 */

type SSLConfig = false | { rejectUnauthorized: false };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

function parseEnvInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;

  return parsed;
}

function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;

  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;

  return fallback;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function getSSLMode(url: string): string | undefined {
  try {
    const value = new URL(url).searchParams.get("sslmode");
    return value?.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLocalOrPrivateHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  ) {
    return true;
  }

  if (
    hostname.endsWith(".local") ||
    hostname === "postgres" ||
    hostname === "db" ||
    hostname === "database"
  ) {
    return true;
  }

  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname))
    return true;

  return false;
}

function computeSSLFlag(url: string): SSLConfig {
  const explicit = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (explicit === "true") return { rejectUnauthorized: false };
  if (explicit === "false") return false;

  const sslMode = getSSLMode(url);
  if (sslMode === "disable") return false;
  if (
    sslMode === "require" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full" ||
    sslMode === "prefer" ||
    sslMode === "allow" ||
    sslMode === "no-verify"
  ) {
    return { rejectUnauthorized: false };
  }

  const hostname = getHostname(url);
  if (isLocalOrPrivateHost(hostname)) return false;

  const looksCloud =
    /render\.com|neon\.tech|supabase\.co|amazonaws\.com|azure\.com|googleapis\.com|railway\.app|aivencloud\.com/i.test(
      hostname
    );

  return looksCloud ? { rejectUnauthorized: false } : false;
}

const DB_POOL_MAX = parseEnvInt("DB_POOL_MAX", 10, 1);
const DB_IDLE_TIMEOUT_MS = parseEnvInt("DB_IDLE_TIMEOUT_MS", 30_000, 1);
const DB_CONNECTION_TIMEOUT_MS = parseEnvInt(
  "DB_CONNECTION_TIMEOUT_MS",
  15_000,
  1
);
const DB_QUERY_RETRIES = parseEnvInt("DB_QUERY_RETRIES", 2, 0);
const DB_RETRY_DELAY_MS = parseEnvInt("DB_RETRY_DELAY_MS", 500, 0);
const DB_KEEP_ALIVE = parseEnvBool("DB_KEEP_ALIVE", true);
const DB_KEEP_ALIVE_INITIAL_DELAY_MS = parseEnvInt(
  "DB_KEEP_ALIVE_INITIAL_DELAY_MS",
  10_000,
  0
);

export const pool = new Pool({
  connectionString,
  ssl: computeSSLFlag(connectionString),
  max: DB_POOL_MAX,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  keepAlive: DB_KEEP_ALIVE,
  keepAliveInitialDelayMillis: DB_KEEP_ALIVE_INITIAL_DELAY_MS,
});

pool.on("error", (error: Error) => {
  const err = error as NodeJS.ErrnoException;

  console.error("Postgres idle client error:", {
    message: error.message,
    code: err.code,
    errno: err.errno,
    syscall: err.syscall,
  });
});

const RETRYABLE_DB_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNABORTED",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

type ErrorDetails = {
  code?: string;
  message: string;
};

function getErrorChain(error: unknown): ErrorDetails[] {
  const chain: ErrorDetails[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);

    const maybeError = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };

    chain.push({
      code:
        typeof maybeError.code === "string"
          ? maybeError.code.toUpperCase()
          : undefined,
      message:
        typeof maybeError.message === "string"
          ? maybeError.message
          : String(current),
    });

    current = maybeError.cause;
  }

  if (chain.length === 0) {
    chain.push({
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return chain;
}

function getErrorCode(error: unknown): string | undefined {
  return getErrorChain(error).find((entry) => entry.code)?.code;
}

function getErrorMessage(error: unknown): string {
  return getErrorChain(error)
    .map((entry) => entry.message)
    .filter(Boolean)
    .join(" | ");
}

function isRetryableDbError(error: unknown): boolean {
  const chain = getErrorChain(error);

  if (chain.some((entry) => entry.code && RETRYABLE_DB_ERROR_CODES.has(entry.code))) {
    return true;
  }

  const combinedMessage = chain
    .map((entry) => entry.message.toLowerCase())
    .join(" | ");

  return (
    combinedMessage.includes("connection terminated due to connection timeout") ||
    combinedMessage.includes("connection terminated unexpectedly") ||
    combinedMessage.includes("server closed the connection unexpectedly") ||
    combinedMessage.includes("terminating connection due to administrator command") ||
    combinedMessage.includes("socket hang up") ||
    combinedMessage.includes("read econnreset") ||
    combinedMessage.includes("connect etimedout") ||
    combinedMessage.includes("timeout expired") ||
    combinedMessage.includes("connection timeout") ||
    combinedMessage.includes("the database system is starting up") ||
    combinedMessage.includes("could not connect to server")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[],
  attempt = 0
): Promise<QueryResult<T>> {
  let client: PoolClient | undefined;
  let released = false;

  try {
    client = await pool.connect();
    return await client.query<T>(text, params);
  } catch (error: unknown) {
    const shouldRetry =
      isRetryableDbError(error) && attempt < DB_QUERY_RETRIES;

    if (client && !released) {
      client.release(shouldRetry);
      released = true;
    }

    if (shouldRetry) {
      const nextAttempt = attempt + 1;

      console.warn(
        `Postgres query retry ${nextAttempt}/${DB_QUERY_RETRIES} after transient error`,
        {
          code: getErrorCode(error),
          message: getErrorMessage(error),
        }
      );

      await delay(DB_RETRY_DELAY_MS * nextAttempt);
      return runQuery<T>(text, params, nextAttempt);
    }

    throw error;
  } finally {
    if (client && !released) {
      client.release();
    }
  }
}

// Typed query helper: T must extend QueryResultRow (per pg's typings)
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return runQuery<T>(text, params);
}

// Optional: convenience helper to fetch a single row
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}