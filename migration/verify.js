// Phase 3, step three: prove it.
//
//   node migration/verify.js /path/to/"KB Dental export ..."
//
// Counts the export, counts the database, and puts the two side by side.
// This is the step that decides whether the clinic switches over. It does
// not write anything and it does not take the importer's word for anything
// — it reads the export files again from scratch.
//
// Exit code 0 means every check matched; 1 means at least one did not.
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const EXPORT_DIR = process.argv[2];
if (!EXPORT_DIR) {
  console.error("Usage: node migration/verify.js <export folder>");
  process.exit(2);
}

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "kbdental",
  user: process.env.PGUSER || "kb",
  password: process.env.PGPASSWORD || ""
});

const norm = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (n) => `₹${Number(n).toLocaleString("en-IN")}`;

function loadTabs(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !["manifest.json", "import-report.json"].includes(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function pick(tabs, name) {
  return tabs.filter((t) => norm(t.tab) === norm(name));
}

function colOf(headers, candidates) {
  const normed = headers.map(norm);
  for (const c of candidates) { const i = normed.indexOf(norm(c)); if (i >= 0) return i; }
  for (const c of candidates) { const i = normed.findIndex((h) => h.includes(norm(c))); if (i >= 0) return i; }
  return -1;
}

function dataRows(tab) {
  return (tab.rows || []).slice(1).filter((r) => r.some((c) => String(c).trim() !== ""));
}

const checks = [];
function check(what, expected, got, note) {
  checks.push({ what, expected, got, ok: String(expected) === String(got), note });
}

async function main() {
  const tabs = loadTabs(EXPORT_DIR);
  const q = async (sql, params) => (await pool.query(sql, params)).rows[0];

  // ── patients: distinct UHIDs across every register tab ─────────────────
  const uhids = new Set();
  let registrationRows = 0;
  for (const t of [...pick(tabs, "Registrations"), ...pick(tabs, "Sheet1")]) {
    const col = colOf(t.rows[0] || [], ["UHID", "Registration ID"]);
    if (col < 0) continue;
    for (const row of dataRows(t)) {
      const u = String(row[col] || "").trim().toUpperCase();
      if (u) { uhids.add(u); registrationRows++; }
    }
  }
  const dbPatients = await q("SELECT count(*)::int n FROM patients");
  check("patients (distinct UHIDs in, rows in patients)", uhids.size, dbPatients.n);

  const dbCollections = await q("SELECT count(*)::int n FROM patient_registrations");
  check("register rows (every row is a collection)", registrationRows, dbCollections.n,
        `${registrationRows - uhids.size} patient(s) were asked more than once`);

  // Not a count but the thing counts are for: is anybody missing?
  const dbUhids = (await pool.query("SELECT uhid FROM patients")).rows.map((r) => r.uhid);
  const missing = [...uhids].filter((u) => !dbUhids.includes(u));
  check("no patient went missing", 0, missing.length,
        missing.length ? `missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}` : "");

  // ── money: every rupee ─────────────────────────────────────────────────
  let sheetTotal = 0, sheetCount = 0;
  for (const t of [...pick(tabs, "Patient Fee Receipt"), ...pick(tabs, "Receipts")]) {
    const headers = t.rows[0] || [];
    const feeCol = colOf(headers, ["Fee", "Amount", "Amount Received", "Total"]);
    const uhidCol = colOf(headers, ["UHID"]);
    const dateCol = colOf(headers, ["Date"]);
    if (feeCol < 0) continue;
    for (const row of dataRows(t)) {
      const amount = Number(String(row[feeCol] || "").replace(/[^0-9.\-]/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) continue;
      if (uhidCol >= 0 && !String(row[uhidCol] || "").trim()) continue;
      if (dateCol >= 0 && !String(row[dateCol] || "").trim()) continue;
      sheetTotal += amount; sheetCount++;
    }
  }
  const dbPay = await q("SELECT count(*)::int n, COALESCE(sum(amount),0)::numeric t FROM payments");
  check("receipts", sheetCount, dbPay.n);
  check("total collected", money(sheetTotal), money(dbPay.t),
        "this is the number that has to match to the rupee");

  // ── the rest, by count ─────────────────────────────────────────────────
  const simple = [
    ["Daily Register", "visits", ["UHID / Registration ID", "UHID"], ["Timestamp", "Date"]],
    ["Appointments", "appointments", ["Date"], ["Time"]],
    ["Expenses", "expenses", ["Amount"], ["Date"]],
    ["Treatment Cases", "treatment_cases", ["UHID"], ["ProcedureCode", "Procedure Code"]]
  ];
  for (const [tabName, table, needA, needB] of simple) {
    let n = 0;
    for (const t of pick(tabs, tabName)) {
      const headers = t.rows[0] || [];
      const a = colOf(headers, needA), b = colOf(headers, needB);
      for (const row of dataRows(t)) {
        if (a >= 0 && !String(row[a] || "").trim()) continue;
        if (b >= 0 && !String(row[b] || "").trim()) continue;
        n++;
      }
    }
    if (!pick(tabs, tabName).length) continue;
    const got = await q(`SELECT count(*)::int n FROM ${table}`);
    check(`${tabName} → ${table}`, n, got.n,
          "rows the importer refused are listed in import-report.json");
  }

  // ── panel patients, which is what went wrong before ────────────────────
  let sheetPanel = 0;
  const panelSeen = new Set();
  for (const t of [...pick(tabs, "Registrations"), ...pick(tabs, "Sheet1")]) {
    const headers = t.rows[0] || [];
    const uhidCol = colOf(headers, ["UHID", "Registration ID"]);
    const panelCol = colOf(headers, ["Panel"]);
    if (uhidCol < 0 || panelCol < 0) continue;
    for (const row of dataRows(t)) {
      const u = String(row[uhidCol] || "").trim().toUpperCase();
      if (!u || panelSeen.has(u)) continue;
      if (String(row[panelCol] || "").trim()) { panelSeen.add(u); sheetPanel++; }
    }
  }
  const dbPanel = await q("SELECT count(*)::int n FROM patients WHERE patient_type = 'Panel'");
  check("panel patients", sheetPanel, dbPanel.n,
        "a panel named on ANY of a patient's rows counts — that is how it broke before");

  // ── nothing is dangling ────────────────────────────────────────────────
  const orphanPay = await q("SELECT count(*)::int n FROM payments p LEFT JOIN patients q ON q.uhid = p.uhid WHERE q.uhid IS NULL");
  check("payments with no patient", 0, orphanPay.n, "the database cannot hold one — this proves it");
  const noPanel = await q("SELECT count(*)::int n FROM patients WHERE patient_type = 'Panel' AND panel_id IS NULL");
  check("panel patients with no panel", 0, noPanel.n);
  const badStamps = await q(
    `SELECT count(*)::int n FROM appointments
      WHERE (engaged_at IS NOT NULL AND checkin_at IS NULL)
         OR (checkout_at IS NOT NULL AND engaged_at IS NULL)`
  );
  check("appointments stamped out of order", 0, badStamps.n);

  // ── print ──────────────────────────────────────────────────────────────
  console.log("");
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? " ok " : "FAIL"}  ${c.what.padEnd(46)} sheets: ${String(c.expected).padStart(12)}   database: ${String(c.got).padStart(12)}`);
    if (c.note) console.log(`        ${c.note}`);
  }
  console.log(`\n${checks.length - failed} of ${checks.length} checks matched.`);
  if (failed) {
    console.log("\nDo not switch over yet. Each mismatch above is either a row the");
    console.log("importer refused (see import-report.json) or a mapping that needs");
    console.log("fixing — both are findable, neither is a reason to guess.");
  } else {
    console.log("\nEverything matched. The database holds what the sheets held.");
  }
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
