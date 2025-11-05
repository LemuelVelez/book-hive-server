import { Pool, QueryResult, QueryResultRow } from "pg";

const connectionString = process.env.DATABASE_URL!;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString,
  // Render Postgres typically requires SSL. Set to `false` locally if needed.
  ssl: { rejectUnauthorized: false },
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
