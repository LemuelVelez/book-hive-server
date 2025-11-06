import { Pool, QueryResult, QueryResultRow } from "pg";

/**
 * Connect to Postgres with smart SSL defaults:
 * - Local (localhost/127.0.0.1)  -> SSL OFF
 * - Cloud (Render/Neon/Supabase) -> SSL ON (no-verify)
 * - Can be overridden with env DATABASE_SSL=true/false
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Decide SSL behavior
function computeSSLFlag(url: string): false | { rejectUnauthorized: false } {
  // Explicit override wins
  const explicit = process.env.DATABASE_SSL?.toLowerCase();
  if (explicit === "true") return { rejectUnauthorized: false };
  if (explicit === "false") return false;

  // Heuristic: local hosts -> no SSL
  const isLocal =
    url.includes("localhost") ||
    url.includes("127.0.0.1") ||
    url.includes("::1");

  if (isLocal) return false;

  // Common managed hosts typically require SSL
  const looksCloud = /render\.com|neon\.tech|supabase\.co|amazonaws\.com|azure\.com|googleapis\.com/i.test(
    url
  );

  return looksCloud ? { rejectUnauthorized: false } : false;
}

export const pool = new Pool({
  connectionString,
  ssl: computeSSLFlag(connectionString),
});

// Typed query helper: T must extend QueryResultRow (per pg's typings)
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const client = await pool.connect();
  try {
    const res = await client.query<T>(text, params);
    return res;
  } finally {
    client.release();
  }
}

// Optional: convenience helper to fetch a single row
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}
