/**
 * Apply schema.sql.
 *
 * In JavaScript rather than `psql` because the places that need to run it —
 * a Render container, a CI step, your laptop — all have Node and the `pg`
 * driver already, and most of them do not have the Postgres client installed.
 * Needing a second tool to create four tables is a bad reason for a deploy to
 * fail.
 *
 * Every statement in schema.sql is CREATE ... IF NOT EXISTS, so running this
 * repeatedly is a no-op. That is what makes it safe to run on every boot.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export async function runMigrations({ connectionString, pool, log = console.log } = {}) {
  const sql = await readFile(join(here, "schema.sql"), "utf8");

  let db = pool, ownPool = false;
  if (!db) {
    const pg = await import("pg");
    const Pool = pg.default?.Pool ?? pg.Pool;
    db = new Pool({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString || "") ? false : { rejectUnauthorized: false },
      max: 1,
    });
    ownPool = true;
  }

  try {
    // One statement, one transaction: a half-applied schema is worse than none.
    await db.query("BEGIN");
    await db.query(sql);
    await db.query("COMMIT");
    const r = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('subscriptions','processed_webhook_events',
                             'competition_matches','competition_entrants')`
    );
    log(`[keyvoria] schema applied — ${r.rows[0].n}/4 tables present`);
    return r.rows[0].n;
  } catch (err) {
    try { await db.query("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  } finally {
    if (ownPool && db.end) await db.end();
  }
}

/* Run directly: `node src/store/migrate.js` */
if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  runMigrations({ connectionString: url })
    .then(() => process.exit(0))
    .catch((e) => { console.error("[keyvoria] migration failed:", e.message); process.exit(1); });
}
