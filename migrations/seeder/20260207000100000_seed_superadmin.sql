/* eslint-disable no-console */
require("dotenv").config();

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

// Hardcoded by request (local rush setup)
const ADMIN_EMAIL = "velezlem12@gmail.com";
const ADMIN_PASSWORD = "87654321";

function getPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
    });
  }

  return new Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "bookhive",
  });
}

async function getUserColumns(client) {
  const { rows } = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `
  );
  return new Set(rows.map((r) => r.column_name));
}

async function seedSuperAdmin() {
  // Safety guard so this doesn't run accidentally in prod
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SUPERADMIN_SEED !== "yes") {
    throw new Error(
      "Refusing to run in production. Set ALLOW_SUPERADMIN_SEED=yes only if intentional."
    );
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const cols = await getUserColumns(client);
    if (!cols.has("email") || !cols.has("password_hash")) {
      throw new Error("users table is missing required columns (email/password_hash).");
    }

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const now = new Date();

    // Candidate values (insert only if column exists in your current schema)
    const candidate = {
      email: ADMIN_EMAIL,
      password_hash: passwordHash,
      full_name: "System Super Admin",
      role: "superadmin",
      account_type: "admin",
      is_email_verified: true,
      email_verified_at: now,
      is_approved: true,
      approved_at: now,
      updated_at: now,
    };

    const keys = Object.keys(candidate).filter((k) => cols.has(k));
    const values = keys.map((k) => candidate[k]);

    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const updatable = keys.filter((k) => k !== "email");
    const updates = updatable.map((k) => `${k} = EXCLUDED.${k}`).join(", ");

    const sql = `
      INSERT INTO users (${keys.join(", ")})
      VALUES (${placeholders})
      ON CONFLICT (email) DO UPDATE
      SET ${updates}
      RETURNING id, email, role
    `;

    const result = await client.query(sql, values);
    const user = result.rows[0];

    // If approved_by exists, self-reference the created/updated superadmin user
    if (cols.has("approved_by")) {
      await client.query(
        `
          UPDATE users
          SET approved_by = $1
          WHERE id = $1 AND approved_by IS NULL
        `,
        [user.id]
      );
    }

    await client.query("COMMIT");
    console.log(`✅ Superadmin seeded/updated: ${user.email} (id=${user.id}, role=${user.role})`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seedSuperAdmin().catch((err) => {
  console.error("❌ Seeder failed:", err.message);
  process.exit(1);
});
