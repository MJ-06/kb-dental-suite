// One-off move of a clinic's existing attachments to its chosen storage, with a
// checksum check on every file (see src/storage/copy.ts). Nothing is deleted
// from the old place. Safe to run again: it only touches files not yet on the target.
//
// Usage (from api/):
//   npx tsx scripts/copy-documents.ts --clinic=kb --to=drive            counts what would move
//   npx tsx scripts/copy-documents.ts --clinic=kb --to=drive --apply    moves it
// The storage must be set up and tested first (the admin page, or PUT /api/v1/storage/:kind).
// Failures are listed here and in the clinic's system log.
import { sql } from "kysely";
import { createDb, setTenant } from "../src/db/index.js";
import { required } from "../src/env.js";
import { copyDocuments } from "../src/storage/copy.js";
import type { Kind } from "../src/storage/index.js";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const clinicCode = arg("clinic");
const to = arg("to") as Kind | undefined;
const apply = process.argv.includes("--apply");
if (!clinicCode || !to || !["local", "s3", "drive"].includes(to)) {
  console.error("Usage: copy-documents.ts --clinic=<code> --to=local|s3|drive [--apply]");
  process.exit(2);
}

const db = createDb(required(arg("db") ?? "OWNER_DATABASE_URL"), 2);
try {
  const clinic = (await sql<{ id: string }>`SELECT id FROM clinics WHERE code = ${clinicCode}`.execute(db)).rows[0]?.id;
  if (!clinic) throw new Error(`No clinic with code '${clinicCode}'`);

  if (!apply) {
    await db.transaction().execute(async (tx) => {
      await setTenant(tx, clinic);
      const r = await sql<{ storage_backend: string; n: string; mb: string }>`
        SELECT storage_backend, count(*) AS n, round(sum(size_bytes) / 1048576.0, 1) AS mb FROM patient_documents
         WHERE storage_backend <> ${to} GROUP BY 1`.execute(tx);
      for (const x of r.rows) console.log(`${x.n} files (${x.mb} MB) on ${x.storage_backend} would move to ${to}`);
      if (!r.rows.length) console.log(`Everything is already on ${to}.`);
      console.log("Run again with --apply to move them.");
    });
  } else {
    let after: string | null = null;
    let moved = 0;
    let failed = 0;
    do {
      const r = await db.transaction().execute(async (tx) => {
        await setTenant(tx, clinic);
        return copyDocuments(tx, to, { after, limit: 25 });
      });
      moved += r.moved;
      failed += r.failed;
      for (const f of r.failures) console.error(`FAILED ${f.id} (log reference ${f.ref})`);
      console.log(`moved ${moved}, failed ${failed}, ${r.remaining} not yet on ${to}`);
      after = r.lastId;
    } while (after);
    console.log(failed ? `Done with ${failed} failures: see the system log.` : "Done. Every moved file was read back and matched its checksum.");
  }
} finally {
  await db.destroy();
}
