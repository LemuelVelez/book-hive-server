import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * Connect to Postgres with smart SSL defaults:
 * - Local (localhost/127.0.0.1)  -> SSL OFF
 * - Cloud (Render/Neon/Supabase) -> SSL ON (no-verify)
 * - Can be overridden with env DATABASE_SSL=true/false
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

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function computeSSLFlag(url: string): SSLConfig {
  const explicit = process.env.DATABASE_SSL?.toLowerCase();
  if (explicit === "true") return { rejectUnauthorized: false };
  if (explicit === "false") return false;

  const hostname = getHostname(url);
  const isLocal =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";

  if (isLocal) return false;

  const looksCloud =
    /render\.com|neon\.tech|supabase\.co|amazonaws\.com|azure\.com|googleapis\.com/i.test(
      hostname
    );

  return looksCloud ? { rejectUnauthorized: false } : false;
}

const DB_POOL_MAX = parseEnvInt("DB_POOL_MAX", 10, 1);
const DB_IDLE_TIMEOUT_MS = parseEnvInt("DB_IDLE_TIMEOUT_MS", 30_000, 1);
const DB_CONNECTION_TIMEOUT_MS = parseEnvInt(
  "DB_CONNECTION_TIMEOUT_MS",
  10_000,
  1
);
const DB_QUERY_RETRIES = parseEnvInt("DB_QUERY_RETRIES", 1, 0);
const DB_RETRY_DELAY_MS = parseEnvInt("DB_RETRY_DELAY_MS", 250, 0);

export const pool = new Pool({
  connectionString,
  ssl: computeSSLFlag(connectionString),
  max: DB_POOL_MAX,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
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
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableDbError(error: unknown): boolean {
  const code = getErrorCode(error);

  if (code && RETRYABLE_DB_ERROR_CODES.has(code)) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("connection terminated unexpectedly") ||
    message.includes("server closed the connection unexpectedly") ||
    message.includes("terminating connection due to administrator command") ||
    message.includes("socket hang up") ||
    message.includes("read econnreset")
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