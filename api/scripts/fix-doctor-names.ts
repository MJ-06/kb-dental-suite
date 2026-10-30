// One-off clean-up of the doctor's name typed in the daily register of the
// data imported from the sheets ("Dr. Viveyk", "Dr. Vivyek Mittel", stray
// spaces and capitals).
//
// It is an explicit list, not a matching rule: each typed spelling below is
// rewritten to the name it was meant to be, and nothing else is touched. Names
// that match the doctor list apart from spaces and capitals are tidied too.
// A visit with two doctors keeps its " | " separator, each part tidied, and a
// doctor named twice in one entry is named once.
//
// Usage (from api/):  npx tsx scripts/fix-doctor-names.ts            shows what would change
//                     npx tsx scripts/fix-doctor-names.ts --apply    makes the change
// Database: REHEARSAL_OWNER_DATABASE_URL by default, or --db=<env var name> to use another.
import pg from "pg";
import { required } from "../src/env.js";

// Spelling as typed (lower case, spaces squeezed) -> the name it means.
export const SPELLINGS: Record<string, string> = {
  "dr. viveyk": "Dr. Viveyk Mittel",
  "dr. vivyek mittel": "Dr. Viveyk Mittel",
  "dr. manika": "Dr. Manika Mittel",
  "dr. manika mittal": "Dr. Manika Mittel",
  "dr apoorva bajaj": "Dr. Apoorva",
  "dr. deeksha": "Dr. Deeksha Bhanotia" // not on the doctor list; the two spellings are one person
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function tidy(entry: string, listed: Map<string, string>): string {
  const out: string[] = [];
  for (const part of entry.split("|")) {
    const key = squash(part).toLowerCase();
    if (!key) continue;
    const name = SPELLINGS[key] ?? listed.get(key) ?? squash(part);
    if (!out.includes(name)) out.push(name);
  }
  return out.join(" | ");
}

if (process.argv[1]?.endsWith("fix-doctor-names.ts")) {
  const apply = process.argv.includes("--apply");
  const envName = process.argv.find((a) => a.startsWith("--db="))?.slice(5) ?? "REHEARSAL_OWNER_DATABASE_URL";
  const c = new pg.Client({ connectionString: required(envName) });
  await c.connect();
  try {
    const clinic = (await c.query("SELECT id FROM clinics WHERE code = 'kb'")).rows[0]?.id as string | undefined;
    if (!clinic) throw new Error("No clinic with code 'kb' in this database");
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [clinic]);
    const listed = new Map<string, string>(
      (await c.query("SELECT name FROM doctors")).rows.map((r: { name: string }) => [squash(r.name).toLowerCase(), r.name])
    );
    const rows = (await c.query(
      "SELECT operating_doctor AS v, count(*)::int AS n FROM daily_register WHERE operating_doctor IS NOT NULL GROUP BY 1")).rows as { v: string; n: number }[];
    let changed = 0;
    for (const { v, n } of rows) {
      const to = tidy(v, listed);
      if (to === v) continue;
      console.log(`${String(n).padStart(5)}  ${JSON.stringify(v)} -> ${JSON.stringify(to)}`);
      changed += n;
      if (apply) await c.query("UPDATE daily_register SET operating_doctor = $2 WHERE operating_doctor = $1", [v, to]);
    }
    if (apply) { await c.query("COMMIT"); console.log(`${changed} register rows updated.`); }
    else { await c.query("ROLLBACK"); console.log(`${changed} register rows would change. Run again with --apply.`); }
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { await c.end(); }
}
