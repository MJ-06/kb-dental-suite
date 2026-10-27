// The migration, run end to end against a real database.
//
// It builds an export folder shaped like the clinic's own — the same
// headings, and the same awkward rows the sheets actually contain: a
// patient in both books, a patient asked for their details twice, a receipt
// on a day with no visit, two receipts sharing a number, two bookings in one
// chair, an appointment checked out that was never checked in. Then it runs
// the importer and the verifier over them.
//
//   PGHOST=... PGDATABASE=... node migration/test/migration.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Pool } = require("pg");

const HERE = path.join(__dirname, "..");
const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "kbdental",
  user: process.env.PGUSER || "kb",
  password: process.env.PGPASSWORD || ""
});

let passed = 0, failed = 0;
const failures = [];
function eq(label, got, want) {
  if (String(got) === String(want)) { passed++; return; }
  failed++;
  failures.push(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function ok(label, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

// ── an export folder shaped like the clinic's ────────────────────────────
function writeExport(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const put = (book, tab, rows) =>
    fs.writeFileSync(
      path.join(dir, `${book}__${tab.replace(/[^A-Za-z0-9 _-]/g, "_")}.json`),
      JSON.stringify({ book, tab, rows })
    );

  // Headings as the register really has them: legacy Google Form questions.
  const regHeaders = [
    "Timestamp", "UHID", "Full Name", "Gender", "Date of Birth", "Mobile No.",
    "Complete Address", "Panel", "Panel Category", "Card ID",
    "Referred By", "Referred By Type",
    "Have you ever suffered/suffering from any of the following?",
    "Are you allergic to any of the following?",
    "What is your chief complaint?",
    "What is your level of pain on a scale of 0-10?"
  ];

  put("pms", "Registrations", [
    regHeaders,
    ["15/09/2026", "AL0901", "Neena Arora", "Female", "12/04/1961", "9810123456",
     "Dwarka", "", "", "", "Anil Kumar", "PR / Marketing",
     "Diabetes, Hypertension", "Penicillin", "Pain upper left", "7"],
    // The same patient, asked again for NABH. One patient, two collections.
    ["02/10/2026", "AL0901", "Neena Arora", "Female", "12/04/1961", "9810123456",
     "Dwarka, New Delhi", "", "", "", "", "", "Diabetes", "", "Review", "2"],
    ["20/09/2026", "AL0902", "R K Gupta", "Male", "03/08/1955", "9811222333",
     "Rohini", "", "", "", "Dr. Mehta", "Doctor", "", "", "Broken tooth", "5"],
    // A referrer kind the register spells its own way.
    ["21/09/2026", "AL0903", "S Verma", "Male", "11/11/1988", "9812333444",
     "Janakpuri", "", "", "", "Website", "Internet", "", "", "Cleaning", "0"]
  ]);

  // The panel book. R K Gupta is in BOTH — one patient, with a panel.
  put("empanelled", "Registrations", [
    regHeaders,
    ["20/09/2026", "AL0902", "R K Gupta", "Male", "03/08/1955", "9811222333",
     "Rohini", "CGHS", "Pensioner", "CG-4471", "", "", "", "", "", ""],
    // A row in the panel book with no panel named: reported, not guessed at.
    ["22/09/2026", "AL0904", "M Khan", "Male", "01/01/1970", "9813444555",
     "Saket", "", "", "", "", "", "", "", "", ""]
  ]);

  put("pms", "Daily Register", [
    ["Month", "Timestamp", "UHID / Registration ID", "Full Name", "Phone No.", "Age",
     "Time of Walk-in", "Consultation Time", "TAT (HR/MIN)",
     "Initial Assessment Done", "Care Plan Documented", "Procedure Done",
     "Tooth No. (If any)", "Work Done", "Operating Doctor",
     "If Delay Reason for Delay", "Mode of payment & payment"],
    ["September", "15/09/2026", "AL0901", "Neena Arora", "9810123456", "65",
     "10:05", "11:10", "1:05", "Yes", "Yes", "RCT", "21", "Access opening",
     "Dr. Neha Sharma", "", "Card 65000"],
    ["September", "20/09/2026", "AL0902", "R K Gupta", "9811222333", "71",
     "09:30", "09:45", "0:15", "Yes", "No", "Extraction", "46", "Extracted",
     "Dr. Viveyk Mittel", "", "Cash"],
    // A register row for somebody who is in no book at all.
    ["September", "25/09/2026", "AL9999", "Ghost Patient", "", "", "", "", "",
     "", "", "Consultation", "", "", "", "", ""]
  ]);

  put("finance", "Patient Fee Receipt", [
    ["Date", "UHID", "Patient's Name", "Nature of Professional Services",
     "Mode", "Fee", "E. Receipt No", "Remarks"],
    ["15/09/2026", "AL0901", "Neena Arora", "RCT", "Card", "65,000", "R-001", ""],
    // No register row on this day. This is the ₹65,000 that used to vanish.
    ["20/09/2026", "AL0901", "Neena Arora", "Crown", "UPI", "40000", "R-002", ""],
    ["02/10/2026", "AL0901", "Neena Arora", "Implant", "Cash", "65000", "R-003", ""],
    // The same receipt number twice, which the sheet allowed.
    ["20/09/2026", "AL0902", "R K Gupta", "Extraction", "Cash", "1500", "R-001", "duplicate no."]
  ]);

  put("pms", "Appointments", [
    ["ID", "Date", "UHID", "Patient Name", "Time", "Type", "SubType", "Doctor",
     "Chair", "Mobile", "Notes", "Status", "CheckinTime", "EngagedTime",
     "CheckoutTime", "CancelReason", "CaseId", "ProcedureCode", "Saved At"],
    ["APT-1", "2026-11-10", "AL0901", "Neena Arora", "10:30", "RCT", "Access Opening",
     "Dr. Neha Sharma", "Chair 1", "9810123456", "", "Completed", "10:28", "10:35", "11:10", "", "CASE-1", "RCT_ANTERIOR", ""],
    // Two patients, one chair, one time: the sheet allowed it.
    ["APT-2", "2026-11-10", "AL0902", "R K Gupta", "10:30", "Extraction", "",
     "Dr. Viveyk Mittel", "Chair 1", "9811222333", "", "Scheduled", "", "", "", "", "", "", ""],
    // Checked out without ever being checked in.
    ["APT-3", "2026-11-11", "AL0903", "S Verma", "12:00", "Scaling", "",
     "Dr. Neha Sharma", "Chair 2", "9812333444", "", "Completed", "", "", "12:40", "", "", "", ""],
    // Cancelled, with nobody having recorded why.
    ["APT-4", "2026-11-12", "AL0903", "S Verma", "15:00", "Consultation", "",
     "Dr. Neha Sharma", "Chair 2", "9812333444", "", "Cancelled", "", "", "", "", "", "", ""]
  ]);

  put("pms", "Treatment Cases", [
    ["CaseId", "UHID", "PatientName", "ProcedureCode", "ProcedureName", "FamilyCode",
     "ToothRef", "CaseStatus", "OpenedDate", "ClosedDate", "VisitCounter", "StagesJson", "UpdatedAt"],
    ["CASE-1", "AL0901", "Neena Arora", "RCT_ANTERIOR", "RCT (Anterior)", "ENDODONTIC",
     "21", "in_progress", "2026-09-15", "", "1",
     JSON.stringify([
       { sequenceNo: 1, stageCode: "ACCESS", stageName: "Access Opening", status: "completed", completedDate: "2026-09-15" },
       { sequenceNo: 2, stageCode: "BMP", stageName: "BMP", status: "pending" },
       { sequenceNo: 3, stageCode: "OBT", stageName: "Obturation", status: "pending", completesTreatment: true }
     ]), ""]
  ]);

  put("pms", "Procedure Library", [
    ["Procedure Code", "Procedure Name", "Family Code", "Visits Min", "Visits Max",
     "Sequence No", "Stage Code", "Stage Name", "Stage Type", "Completes Treatment"],
    ["RCT_ANTERIOR", "RCT (Anterior)", "ENDODONTIC", "2", "3", "1", "ACCESS", "Access Opening", "P", "No"],
    ["RCT_ANTERIOR", "RCT (Anterior)", "ENDODONTIC", "2", "3", "2", "BMP", "BMP", "P", "No"],
    ["RCT_ANTERIOR", "RCT (Anterior)", "ENDODONTIC", "2", "3", "3", "OBT", "Obturation", "T", "Yes"]
  ]);

  put("pms", "Doctor Details", [
    ["Name", "Phone", "Email", "Role", "Updated At"],
    ["Dr. Viveyk Mittel", "9810000000", "", "Prosthodontist", ""],
    ["Dr. Neha Sharma", "9811111111", "", "Endodontist", ""]
  ]);
  put("pms", "Chairs", [["Chair", "Updated At"], ["Chair 1", ""], ["Chair 2", ""]]);
  put("pms", "Panels", [["Panel", "Updated At"], ["CGHS", ""], ["DGEHS", ""]]);
  put("pms", "Payment Modes", [["Mode", "Updated At"], ["Cash", ""], ["Card", ""], ["UPI", ""]]);
  put("pms", "Treatments Master", [
    ["Treatment Name", "Fee", "Department", "Updated At"],
    ["RCT (Anterior)", "6500", "Endodontics", ""],
    ["Extraction", "1500", "Oral Surgery", ""]
  ]);
  put("finance", "Expenses", [
    ["Date", "Category", "Amount", "Mode", "Payee", "Remarks"],
    ["01/09/2026", "Lab", "12,500", "UPI", "Sharma Dental Lab", ""],
    ["", "Rent", "45000", "", "", "no date — refused"]
  ]);
  put("pms", "CRM Contacts", [
    ["id", "firstName", "lastName", "phone", "company", "customFields"],
    ["c1", "Neena", "Arora", "9810123456", "", "{\"source\":\"walk-in\"}"],
    ["c2", "R K", "Gupta", "9811222333", "CGHS", "{}"]
  ]);
  put("pms", "CRM Lead Inbox", [
    ["id", "UHID", "Name", "Mobile", "Panel", "Referred By", "Referred By Type", "Queued At", "Taken At"],
    ["1", "AL0903", "S Verma", "9812333444", "", "Website", "Other", "2026-09-21", ""]
  ]);
  // A tab nothing is done with, so the run says so rather than hiding it.
  put("pms", "Scratch Notes", [["Note"], ["remember to order gloves"]]);
}

async function reset() {
  await pool.query(`
    TRUNCATE crm_lead_inbox, crm_documents, audit_log, sessions,
             payments, expenses, prescriptions, consents, care_plans,
             treatment_plans, clinical_records, patient_documents,
             case_stages, treatment_cases, visits, blocked_slots, appointments,
             patient_registrations, patients, panel_rates, panels,
             doctors, staff, chairs, appointment_reasons,
             procedure_stages, procedures, medicines, implant_brands,
             treatments, pick_lists, clinic_settings, holidays, signatures
      RESTART IDENTITY CASCADE`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-export-"));
  writeExport(dir);
  await reset();

  const env = { ...process.env };
  const importOut = execFileSync("node", [path.join(HERE, "import.js"), dir], { env, encoding: "utf8" });
  console.log(importOut);

  const q = async (sql, params) => (await pool.query(sql, params)).rows[0];

  // ── one patient, however many rows ─────────────────────────────────────
  eq("four patients, not six rows", (await q("SELECT count(*)::int n FROM patients")).n, 4);
  eq("six collections on file", (await q("SELECT count(*)::int n FROM patient_registrations")).n, 6);
  eq("Neena was asked twice",
     (await q("SELECT count(*)::int n FROM patient_registrations WHERE uhid='AL0901'")).n, 2);

  // The later collection's address wins — that is what re-collection is
  // for. The earlier one is not lost: it is still on its own registration
  // row, which is the whole reason those rows exist.
  const neena = await q("SELECT address, referred_by_type FROM patients WHERE uhid='AL0901'");
  eq("the newer address is the current one", neena.address, "Dwarka, New Delhi");
  const firstSnapshot = await q(
    `SELECT snapshot->>'Complete Address' AS a FROM patient_registrations
      WHERE uhid='AL0901' ORDER BY collected_at LIMIT 1`
  );
  eq("and the first one is still on the record", firstSnapshot.a, "Dwarka");
  // The second row left the referrer blank; blank does not erase.
  eq("her referrer kind survived a collection that did not repeat it",
     neena.referred_by_type, "PR / Marketing");

  // ── a patient in both books is one patient, with a panel ───────────────
  const gupta = await q(
    `SELECT p.patient_type, pn.name AS panel, p.card_id, p.panel_category, p.address
       FROM patients p LEFT JOIN panels pn ON pn.id = p.panel_id WHERE p.uhid='AL0902'`
  );
  eq("R K Gupta is one patient on a panel", gupta.patient_type, "Panel");
  eq("under CGHS", gupta.panel, "CGHS");
  eq("with his card", gupta.card_id, "CG-4471");
  eq("and the main book's address", gupta.address, "Rohini");

  // ── an unexpected referrer kind is kept, not refused ───────────────────
  eq("'Internet' became Other rather than being dropped",
     (await q("SELECT referred_by_type t FROM patients WHERE uhid='AL0903'")).t, "Other");

  // ── money ──────────────────────────────────────────────────────────────
  const pay = await q("SELECT count(*)::int n, sum(amount)::numeric t FROM payments");
  eq("four receipts", pay.n, 4);
  eq("every rupee", Number(pay.t), 171500);
  eq("Neena's own total",
     Number((await q("SELECT sum(amount)::numeric t FROM payments WHERE uhid='AL0901'")).t), 170000);

  // The ₹65,000 that used to vanish: a payment on a day with no visit.
  const loose = await q(
    "SELECT count(*)::int n FROM payments WHERE uhid='AL0901' AND visit_id IS NULL"
  );
  eq("two of her payments have no visit, and are still hers", loose.n, 2);

  // Both receipts numbered R-001 survived, under distinguishable numbers.
  const nums = (await pool.query(
    "SELECT receipt_no FROM payments WHERE receipt_no LIKE 'R-001%' ORDER BY receipt_no"
  )).rows.map((r) => r.receipt_no);
  eq("neither duplicate receipt was lost", nums.join(","), "R-001,R-001-2");

  // ── appointments ───────────────────────────────────────────────────────
  eq("all four bookings kept", (await q("SELECT count(*)::int n FROM appointments")).n, 4);
  const doubled = await q(
    "SELECT chair_id FROM appointments WHERE patient_name = 'R K Gupta' AND appt_date = '2026-11-10'"
  );
  eq("the double-booked one kept its slot and lost its chair", doubled.chair_id, null);
  const verma = await q(
    "SELECT checkin_at, engaged_at, checkout_at FROM appointments WHERE appt_date = '2026-11-11'"
  );
  ok("the checkout with no check-in was filled in rather than refused",
     verma.checkin_at !== null && verma.engaged_at !== null && verma.checkout_at !== null);
  const cancelled = await q("SELECT cancel_reason FROM appointments WHERE appt_date = '2026-11-12'");
  ok("the cancellation got a reason, since the table insists on one",
     !!cancelled.cancel_reason, String(cancelled.cancel_reason));

  // ── the case, and the appointment that points at it ────────────────────
  const linked = await q(
    `SELECT a.case_id, tc.procedure_code FROM appointments a
       JOIN treatment_cases tc ON tc.id = a.case_id WHERE a.patient_name = 'Neena Arora'`
  );
  eq("the booking found its case", linked.procedure_code, "RCT_ANTERIOR");
  eq("with its three stages", (await q("SELECT count(*)::int n FROM case_stages")).n, 3);
  eq("one of them already done",
     (await q("SELECT count(*)::int n FROM case_stages WHERE status='completed'")).n, 1);

  // ── the register ───────────────────────────────────────────────────────
  eq("two register rows; the third names nobody", (await q("SELECT count(*)::int n FROM visits")).n, 2);

  // ── what was refused, and said so ──────────────────────────────────────
  const report = JSON.parse(fs.readFileSync(path.join(dir, "import-report.json"), "utf8"));
  const reasons = report.rejected.map((r) => `${r.what}: ${r.why}`).join(" | ");
  ok("the ghost register row was reported", /AL9999/.test(reasons), reasons);
  ok("the panel-book row with no panel was reported", /AL0904 is in the panel book/.test(reasons), reasons);
  ok("the expense with no date was reported", /Expenses/.test(reasons), reasons);
  ok("the double-booking was reported", /double-booked/.test(reasons), reasons);
  ok("the duplicate receipt number was reported", /used more than once/.test(reasons), reasons);
  ok("the tab nothing was done with was listed",
     report.skippedTabs.some((s) => /Scratch Notes/.test(s)), report.skippedTabs.join(", "));

  // ── running it twice does not double anything ──────────────────────────
  // Rows that are keyed (patients, masters, the register) upsert; rows that
  // are not (receipts, bookings) would repeat, so the runbook says to start
  // from an empty database. This proves the keyed ones hold.
  execFileSync("node", [path.join(HERE, "import.js"), dir], { env, encoding: "utf8" });
  eq("still four patients after a second run", (await q("SELECT count(*)::int n FROM patients")).n, 4);
  eq("still two register rows", (await q("SELECT count(*)::int n FROM visits")).n, 2);

  // ── and now the verifier, on a clean import ────────────────────────────
  await reset();
  execFileSync("node", [path.join(HERE, "import.js"), dir], { env, encoding: "utf8" });
  let verifyOut = "", verifyFailed = false;
  try {
    verifyOut = execFileSync("node", [path.join(HERE, "verify.js"), dir], { env, encoding: "utf8" });
  } catch (e) {
    verifyOut = String(e.stdout || "");
    verifyFailed = true;
  }
  console.log(verifyOut);

  ok("the verifier counts the patients", /patients .*sheets:\s+4\s+database:\s+4/.test(verifyOut), "");
  ok("and the money, to the rupee", /total collected.*₹1,71,500.*₹1,71,500/.test(verifyOut), "");
  ok("and the panel patients", /panel patients\b.*sheets:\s+1\s+database:\s+1/.test(verifyOut), "");
  ok("and proves no payment is dangling", /payments with no patient\s+sheets:\s+0\s+database:\s+0/.test(verifyOut), "");
  // The register check is EXPECTED to differ: one row names a patient who
  // is in no book, and the importer refused it. The verifier must say so
  // rather than quietly agreeing.
  ok("it flags the register row that could not be placed",
     /FAIL.*Daily Register/.test(verifyOut), "");
  ok("and exits non-zero while anything is unmatched", verifyFailed, "it exited 0");

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
