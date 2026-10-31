// Optional, read-only reference profiling. Never imports the app's implicit env loader.
// Select the source through an explicit Node --env-file and --source option.
import pg from "pg";

const allowedTables = [
  "patients", "patient_registrations", "appointments", "doctors", "chairs",
  "receipts", "expenses", "clinical_records", "clinical_sheets", "patient_documents",
  "form_definitions", "form_submissions", "treatments", "medicines", "panels"
] as const;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node --import tsx --env-file=<explicit-source-env> scripts/profile-demo-source.ts --source=database|rehearsal");
    return;
  }
  if (args.some((a) => a !== "--source=database" && a !== "--source=rehearsal") || args.length !== 1) {
    throw new Error("Select exactly --source=database or --source=rehearsal.");
  }
  const variable = args[0] === "--source=rehearsal" ? "REHEARSAL_OWNER_DATABASE_URL" : "DATABASE_URL";
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error("The explicitly selected source environment variable is missing.");
  const client = new pg.Client({ connectionString, application_name: "kb_demo_readonly_profile" });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL row_security = on");
    // Owner may enumerate the registry; identifiers stay inside this process.
    // Set each clinic context before aggregate reads so forced RLS remains active.
    const clinics = (await client.query<{ id: string }>("SELECT id FROM public.clinics ORDER BY id")).rows;
    if (!clinics.length) throw new Error("No clinic contexts available for complete profiling.");
    const summary: Record<string, unknown> = { source: args[0]!.slice(9), readOnly: true, clinicCount: clinics.length, tables: {} };
    const tables = summary.tables as Record<string, unknown>;
    for (const table of allowedTables) {
      const exists = (await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`])).rows[0]?.present;
      if (!exists) continue;
      // Only aggregate numbers and schema shape leave this process. No table data
      // values, patient identifiers, clinic labels or source filenames are selected.
      const columns = (await client.query<{ column_name: string; data_type: string }>(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [table]
      )).rows;
      const scoped = columns.some((c) => c.column_name === "clinic_id");
      let total = 0n;
      const contexts = scoped ? clinics : [null];
      for (const clinic of contexts) {
        await client.query("SELECT set_config('app.clinic_id', $1, true)", [clinic?.id ?? ""]);
        const count = await client.query(`SELECT count(*)::text AS count FROM public.${quote(table)}${scoped ? " WHERE clinic_id=$1" : ""}`, scoped ? [clinic!.id] : []);
        total += BigInt(count.rows[0].count);
      }
      tables[table] = { count: total.toString(), columns: columns.map((c) => ({ name: c.column_name, type: c.data_type })) };
    }
    if (tables.patient_documents) {
      const hasSize = (tables.patient_documents as { columns: { name: string }[] }).columns.some((c) => c.name === "size_bytes");
      if (hasSize) {
        const totals = new Map<string, bigint>();
        for (const clinic of clinics) {
          await client.query("SELECT set_config('app.clinic_id', $1, true)", [clinic.id]);
          const buckets = (await client.query<{ bucket: string; count: string }>(`
          SELECT CASE WHEN size_bytes < 102400 THEN 'under_100KiB'
                      WHEN size_bytes < 1048576 THEN '100KiB_to_1MiB'
                      WHEN size_bytes < 5242880 THEN '1_to_5MiB' ELSE '5MiB_or_more' END AS bucket,
                 count(*)::text AS count
          FROM public.patient_documents WHERE clinic_id=$1 GROUP BY 1 ORDER BY 1`, [clinic.id])).rows;
          for (const bucket of buckets) totals.set(bucket.bucket, (totals.get(bucket.bucket) ?? 0n) + BigInt(bucket.count));
        }
        summary.documentSizeBuckets = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, count]) => ({ bucket, count: count.toString() }));
      }
    }
    // Emit only after every aggregate succeeds: no partial output that could be
    // mistaken for a complete profile if source grants/RLS deny a later table.
    await client.query("ROLLBACK");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.end();
  }
}

main().catch(() => {
  // Driver errors may contain patient values, usernames, paths or URLs.
  console.error("Read-only source profile failed; no source rows or connection details were printed. Check source access, schema and RLS permissions privately.");
  process.exitCode = 1;
});
