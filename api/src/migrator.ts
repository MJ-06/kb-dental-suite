// Applies migrations/NNNN_*.sql in order, each in its own transaction, and
// records them. Then re-applies grants.sql. A file already applied is never
// run again, and a changed file is refused rather than silently skipped.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function migrate(ownerUrl: string, log: (s: string) => void = console.log): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations"))
        .rows.map((r) => [r.name, r.checksum])
    );

    const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const name of files) {
      const sql = readFileSync(dir + name, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = done.get(name);
      if (prior === checksum) continue;
      if (prior) throw new Error(`${name} was changed after it was applied. Add a new migration instead.`);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
        log(`applied ${name}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`${name} failed: ${(e as Error).message}`);
      }
    }
    await client.query(readFileSync(dir + "grants.sql", "utf8"));
  } finally {
    await client.end();
  }
}
