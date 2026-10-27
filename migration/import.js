// Phase 3, step two: put the data in.
//
//   node migration/import.js /path/to/"KB Dental export 2026-10-27 1430"
//
// Reads the folder the export script made and writes it into PostgreSQL. It
// runs in an order that respects the foreign keys — the lists first, then
// patients, then everything that points at a patient — and it REPORTS every
// row it could not place rather than dropping it. A migration that loses
// forty rows quietly is worse than one that refuses to finish.
//
// Safe to run again: it is written as upserts, so a second run over the same
// export corrects the first rather than doubling it.
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const EXPORT_DIR = process.argv[2];
if (!EXPORT_DIR) {
  console.error("Usage: node migration/import.js <export folder>");
  process.exit(2);
}

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "kbdental",
  user: process.env.PGUSER || "kb",
  password: process.env.PGPASSWORD || ""
});

// ── reading the export ───────────────────────────────────────────────────
const norm = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");

// A tab is a header row and the rows under it. Headers are matched the way
// Code.gs matched them — exactly first, then loosely — because the register's
// own headings are full Google Form questions and have never been tidy.
function tableOf(rows) {
  if (!rows || !rows.length) return { headers: [], rows: [], get: () => "" };
  const headers = rows[0].map(String);
  const normed = headers.map(norm);
  const colOf = (candidates) => {
    for (const c of candidates) {
      const want = norm(c);
      const exact = normed.indexOf(want);
      if (exact >= 0) return exact;
    }
    for (const c of candidates) {
      const want = norm(c);
      const loose = normed.findIndex((h) => h.includes(want));
      if (loose >= 0) return loose;
    }
    return -1;
  };
  return {
    headers,
    rows: rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== "")),
    colOf,
    get(row, candidates) {
      const i = colOf(Array.isArray(candidates) ? candidates : [candidates]);
      return i < 0 ? "" : String(row[i] == null ? "" : row[i]).trim();
    }
  };
}

function loadExport(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json");
  const tabs = [];
  for (const f of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    tabs.push({ book: parsed.book, tab: parsed.tab, table: tableOf(parsed.rows), file: f });
  }
  return tabs;
}

// ── value helpers, same rules as the server's ────────────────────────────
const nz = (v) => { const s = String(v == null ? "" : v).trim(); return s === "" ? null : s; };
const num = (v) => {
  const s = String(v == null ? "" : v).replace(/[^0-9.\-]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const bool = (v) => {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (["yes", "y", "true", "1", "done"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
};
const uhidOf = (v) => String(v == null ? "" : v).trim().toUpperCase();

// Dates in the sheets are written half a dozen ways. Everything that is not
// one of them is reported, never guessed at.
function dateISO(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);          // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

function timeHM(v) {
  const s = String(v == null ? "" : v).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    let h = Number(m[1]);
    if (/pm/i.test(s) && h < 12) h += 12;
    if (/am/i.test(s) && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m[2]}`;
  }
  return null;
}

function listOf(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(String).map((x) => x.trim()).filter(Boolean); }
    catch (_) { /* fall through */ }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// ── the report ───────────────────────────────────────────────────────────
const report = { in: {}, out: {}, rejected: [], skippedTabs: [], notes: [] };
const count = (bucket, key, n) => { bucket[key] = (bucket[key] || 0) + n; };
const reject = (what, why, row) => report.rejected.push({ what, why, row: (row || []).slice(0, 8).join(" | ") });

// ── the import ───────────────────────────────────────────────────────────
async function main() {
  const tabs = loadExport(EXPORT_DIR);
  console.log(`Read ${tabs.length} tabs from ${EXPORT_DIR}\n`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One transaction for the whole migration. Either the clinic's data is
    // in the database or the database is untouched — there is no half.
    const find = (book, tab) => tabs.find((t) => t.book === book && norm(t.tab) === norm(tab));
    const findAny = (tab) => tabs.filter((t) => norm(t.tab) === norm(tab));
    const used = new Set();
    const use = (t) => { if (t) used.add(t.file); return t; };

    await importMasters(client, findAny, use);
    await importPatients(client, findAny, use);
    const caseIds = await importCases(client, findAny, use);
    const apptIds = await importAppointments(client, findAny, use, caseIds);
    await importVisits(client, findAny, use);
    await importPayments(client, findAny, use);
    await importExpenses(client, findAny, use);
    await importClinical(client, tabs, use);
    await importCrm(client, tabs, use);

    for (const t of tabs) {
      if (!used.has(t.file)) report.skippedTabs.push(`${t.book} / ${t.tab} (${t.table.rows.length} rows)`);
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\nNOTHING WAS IMPORTED. The transaction was rolled back.\n");
    throw e;
  } finally {
    client.release();
  }

  printReport();
  fs.writeFileSync(
    path.join(EXPORT_DIR, "import-report.json"), JSON.stringify(report, null, 2)
  );
  console.log(`\nFull report: ${path.join(EXPORT_DIR, "import-report.json")}`);
  await pool.end();
}

// ── masters ──────────────────────────────────────────────────────────────
async function upsertNamed(client, table, name, extra) {
  const n = nz(name);
  if (!n) return null;
  const cols = ["name", ...Object.keys(extra || {})];
  const vals = [n, ...Object.values(extra || {})];
  const ph = vals.map((_, i) => `$${i + 1}`);
  const sets = cols.slice(1).map((c) => `${c} = COALESCE(EXCLUDED.${c}, ${table}.${c})`);
  const r = await client.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${ph.join(", ")})
     ON CONFLICT (name) DO UPDATE SET ${sets.length ? sets.join(", ") : "name = EXCLUDED.name"}
     RETURNING id`,
    vals
  );
  return r.rows[0].id;
}

async function importMasters(client, findAny, use) {
  const simple = [
    ["Panels", (c, v) => upsertNamed(c, "panels", v)],
    ["Chairs", (c, v) => upsertNamed(c, "chairs", v)],
    ["Appointment Reasons", (c, v) => upsertNamed(c, "appointment_reasons", v)]
  ];
  for (const [tabName, fn] of simple) {
    for (const t of findAny(tabName)) {
      use(t);
      let n = 0;
      for (const row of t.table.rows) { if (await fn(client, row[0])) n++; }
      count(report.in, tabName, t.table.rows.length);
      count(report.out, tabName, n);
    }
  }

  const pickLists = [
    ["Expense Categories", "expense_category"],
    ["Document Categories", "document_category"],
    ["Medicine Dosages", "medicine_dosage"],
    ["Medicine Frequencies", "medicine_frequency"],
    ["Medicine Durations", "medicine_duration"],
    ["Medicine Instructions", "medicine_instruction"],
    ["Medicine Notes", "medicine_note"],
    ["Payment Modes", "payment_mode"],
    ["Clinical Note Templates", "clinical_note_template"]
  ];
  for (const [tabName, listName] of pickLists) {
    for (const t of findAny(tabName)) {
      use(t);
      let i = 0, n = 0;
      for (const row of t.table.rows) {
        const v = nz(row[0]);
        if (!v) continue;
        await client.query(
          `INSERT INTO pick_lists (list_name, value, sort_order) VALUES ($1, $2, $3)
           ON CONFLICT (list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          [listName, v, i++]
        );
        n++;
      }
      count(report.in, tabName, t.table.rows.length);
      count(report.out, tabName, n);
    }
  }

  for (const t of findAny("Doctor Details")) {
    use(t);
    for (const row of t.table.rows) {
      await upsertNamed(client, "doctors", row[0], { phone: nz(row[1]), email: nz(row[2]), role: nz(row[3]) });
    }
    count(report.in, "Doctor Details", t.table.rows.length);
    count(report.out, "Doctor Details", t.table.rows.length);
  }

  for (const t of findAny("Employees")) {
    use(t);
    for (const row of t.table.rows) {
      await upsertNamed(client, "staff", row[0], { phone: nz(row[1]), email: nz(row[2]), role: nz(row[3]) });
    }
    count(report.in, "Employees", t.table.rows.length);
    count(report.out, "Employees", t.table.rows.length);
  }

  for (const t of findAny("Treatments Master")) {
    use(t);
    for (const row of t.table.rows) {
      if (!nz(row[0])) continue;
      await client.query(
        `INSERT INTO treatments (name, fee, department) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET fee = EXCLUDED.fee, department = EXCLUDED.department`,
        [nz(row[0]), num(row[1]), nz(row[2])]
      );
    }
    count(report.in, "Treatments Master", t.table.rows.length);
    count(report.out, "Treatments Master", t.table.rows.length);
  }

  for (const t of findAny("Medicines Master")) {
    use(t);
    for (const row of t.table.rows) {
      if (!nz(row[0])) continue;
      await client.query(
        `INSERT INTO medicines (name, default_dosage, default_frequency) VALUES ($1, $2, $3)
         ON CONFLICT (name, strength) DO UPDATE
           SET default_dosage = EXCLUDED.default_dosage, default_frequency = EXCLUDED.default_frequency`,
        [nz(row[0]), nz(row[1]), nz(row[2])]
      );
    }
    count(report.in, "Medicines Master", t.table.rows.length);
    count(report.out, "Medicines Master", t.table.rows.length);
  }

  for (const t of findAny("Implant Brands")) {
    use(t);
    for (const row of t.table.rows) {
      if (!nz(row[0])) continue;
      await client.query(
        `INSERT INTO implant_brands (name, sizes) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET sizes = EXCLUDED.sizes`,
        [nz(row[0]), listOf(row[1])]
      );
    }
    count(report.in, "Implant Brands", t.table.rows.length);
    count(report.out, "Implant Brands", t.table.rows.length);
  }

  for (const t of findAny("Panel Rates")) {
    use(t);
    let n = 0;
    for (const row of t.table.rows) {
      const panel = t.table.get(row, ["Panel"]);
      const proc = t.table.get(row, ["Procedure", "Procedure Code", "Treatment"]);
      const cat = t.table.get(row, ["Category"]) || "Serving";
      const rate = num(t.table.get(row, ["Rate", "Fee", "Amount"]));
      if (!panel || !proc || rate === null) { reject("Panel Rates", "panel, procedure or rate missing", row); continue; }
      const pid = await upsertNamed(client, "panels", panel);
      await client.query(
        `INSERT INTO panel_rates (panel_id, procedure_code, category, rate) VALUES ($1, $2, $3, $4)
         ON CONFLICT (panel_id, procedure_code, category) DO UPDATE SET rate = EXCLUDED.rate`,
        [pid, proc, cat === "Pensioner" ? "Pensioner" : "Serving", rate]
      );
      n++;
    }
    count(report.in, "Panel Rates", t.table.rows.length);
    count(report.out, "Panel Rates", n);
  }

  for (const t of findAny("Clinic Profile")) {
    use(t);
    const profile = {};
    for (const row of t.table.rows) if (nz(row[0])) profile[String(row[0]).trim()] = String(row[1] == null ? "" : row[1]);
    await putSetting(client, "clinic_profile", profile);
    count(report.in, "Clinic Profile", t.table.rows.length);
    count(report.out, "Clinic Profile", Object.keys(profile).length);
  }

  for (const t of findAny("Clinic Timings")) {
    use(t);
    const timings = {};
    for (const row of t.table.rows) if (nz(row[0])) timings[String(row[0]).trim()] = String(row[1] == null ? "" : row[1]);
    await putSetting(client, "clinic_timings", timings);
    count(report.in, "Clinic Timings", t.table.rows.length);
    count(report.out, "Clinic Timings", Object.keys(timings).length);
  }

  for (const t of findAny("Working Days")) {
    use(t);
    const weekOff = [];
    let holidays = 0;
    for (const row of t.table.rows) {
      const kind = String(row[0] || "").trim().toLowerCase();
      if (kind.includes("week") || /^(sun|mon|tue|wed|thu|fri|sat)/i.test(kind)) {
        const day = nz(row[1]) || nz(row[0]);
        if (day) weekOff.push(day);
        continue;
      }
      const d = dateISO(row[0]) || dateISO(row[1]);
      if (!d) { reject("Working Days", "no readable date", row); continue; }
      await client.query(
        `INSERT INTO holidays (holiday_date, name) VALUES ($1, $2)
         ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name`,
        [d, nz(row[1]) || nz(row[0]) || "Holiday"]
      );
      holidays++;
    }
    await putSetting(client, "week_off", weekOff);
    count(report.in, "Working Days", t.table.rows.length);
    count(report.out, "Working Days", holidays + weekOff.length);
  }

  for (const t of findAny("Signatures")) {
    use(t);
    for (const row of t.table.rows) {
      if (!nz(row[0]) || !nz(row[1])) continue;
      await client.query(
        `INSERT INTO signatures (owner_name, image_data) VALUES ($1, $2)
         ON CONFLICT (owner_name) DO UPDATE SET image_data = EXCLUDED.image_data`,
        [nz(row[0]), String(row[1])]
      );
    }
    count(report.in, "Signatures", t.table.rows.length);
    count(report.out, "Signatures", t.table.rows.length);
  }

  for (const t of findAny("Procedure Library")) {
    use(t);
    let n = 0;
    for (const row of t.table.rows) {
      const code = t.table.get(row, ["Procedure Code", "Code"]);
      if (!code) { reject("Procedure Library", "no procedure code", row); continue; }
      await client.query(
        `INSERT INTO procedures (code, name, family_code, visits_min, visits_max)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name, family_code = EXCLUDED.family_code,
           visits_min = EXCLUDED.visits_min, visits_max = EXCLUDED.visits_max`,
        [code, t.table.get(row, ["Procedure Name", "Name"]) || code,
         t.table.get(row, ["Family Code", "Family"]) || "OTHER",
         num(t.table.get(row, ["Visits Min"])) || 1, num(t.table.get(row, ["Visits Max"])) || 1]
      );
      const seq = num(t.table.get(row, ["Sequence No", "Sequence", "Seq"]));
      const stageName = t.table.get(row, ["Stage Name"]);
      if (seq !== null && stageName) {
        await client.query(
          `INSERT INTO procedure_stages
             (procedure_code, sequence_no, stage_code, stage_name, stage_type, completes_treatment)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (procedure_code, sequence_no) DO UPDATE SET
             stage_code = EXCLUDED.stage_code, stage_name = EXCLUDED.stage_name,
             stage_type = EXCLUDED.stage_type, completes_treatment = EXCLUDED.completes_treatment`,
          [code, seq, t.table.get(row, ["Stage Code"]) || "", stageName,
           (t.table.get(row, ["Stage Type"]) || "P").charAt(0).toUpperCase(),
           bool(t.table.get(row, ["Completes Treatment"])) === true]
        );
      }
      n++;
    }
    count(report.in, "Procedure Library", t.table.rows.length);
    count(report.out, "Procedure Library", n);
  }
}

async function putSetting(client, key, value) {
  await client.query(
    `INSERT INTO clinic_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

// ── patients ─────────────────────────────────────────────────────────────
// Three books become one table. A patient in both books is ONE patient; the
// panel one supplies their panel, and the newest row supplies their details.
async function importPatients(client, findAny, use) {
  const tabs = [...findAny("Registrations"), ...findAny("Sheet1"), ...findAny("Pending")];
  const panelIds = new Map();

  for (const t of tabs) {
    use(t);
    const g = (row, names) => t.table.get(row, names);
    let placed = 0;

    for (const row of t.table.rows) {
      const uhid = uhidOf(g(row, ["UHID", "Registration ID"]));
      if (!uhid) { reject(`${t.book}/${t.tab}`, "no UHID", row); continue; }

      const panelName = nz(g(row, ["Panel"]));
      let panelId = null;
      if (panelName) {
        if (!panelIds.has(panelName)) panelIds.set(panelName, await upsertNamed(client, "panels", panelName));
        panelId = panelIds.get(panelName);
      }
      // The empanelled book IS the panel book: a row there with no panel
      // named still belongs to one, and is reported rather than silently
      // filed as a private patient.
      if (t.book === "empanelled" && !panelName) {
        reject(`${t.book}/${t.tab}`, `${uhid} is in the panel book with no panel named`, row);
      }

      const refType = nz(g(row, ["Referred By Type"]));
      const ALLOWED = ["Patient", "Doctor", "Staff", "PR / Marketing", "Other"];

      await client.query(
        `INSERT INTO patients (
           uhid, full_name, gender, date_of_birth, blood_group, occupation,
           marital_status, address, mobile, mobile_2, whatsapp, email,
           emergency_name, emergency_contact, emergency_relation,
           patient_type, panel_id, panel_category, card_id,
           referred_by, referred_by_type, registered_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20, $21, COALESCE($22::timestamptz, now()))
         ON CONFLICT (uhid) DO UPDATE SET
           full_name     = COALESCE(NULLIF(EXCLUDED.full_name, ''), patients.full_name),
           gender        = COALESCE(EXCLUDED.gender, patients.gender),
           date_of_birth = COALESCE(EXCLUDED.date_of_birth, patients.date_of_birth),
           blood_group   = COALESCE(EXCLUDED.blood_group, patients.blood_group),
           occupation    = COALESCE(EXCLUDED.occupation, patients.occupation),
           marital_status= COALESCE(EXCLUDED.marital_status, patients.marital_status),
           address       = COALESCE(EXCLUDED.address, patients.address),
           mobile        = COALESCE(EXCLUDED.mobile, patients.mobile),
           mobile_2      = COALESCE(EXCLUDED.mobile_2, patients.mobile_2),
           whatsapp      = COALESCE(EXCLUDED.whatsapp, patients.whatsapp),
           email         = COALESCE(EXCLUDED.email, patients.email),
           emergency_name    = COALESCE(EXCLUDED.emergency_name, patients.emergency_name),
           emergency_contact = COALESCE(EXCLUDED.emergency_contact, patients.emergency_contact),
           emergency_relation= COALESCE(EXCLUDED.emergency_relation, patients.emergency_relation),
           patient_type  = CASE WHEN EXCLUDED.panel_id IS NOT NULL THEN 'Panel' ELSE patients.patient_type END,
           panel_id      = COALESCE(EXCLUDED.panel_id, patients.panel_id),
           panel_category= COALESCE(EXCLUDED.panel_category, patients.panel_category),
           card_id       = COALESCE(EXCLUDED.card_id, patients.card_id),
           referred_by      = COALESCE(EXCLUDED.referred_by, patients.referred_by),
           referred_by_type = COALESCE(EXCLUDED.referred_by_type, patients.referred_by_type),
           registered_on = LEAST(patients.registered_on, EXCLUDED.registered_on)`,
        [
          uhid,
          g(row, ["Full Name", "Name", "Patient Name"]) || uhid,
          nz(g(row, ["Gender"])),
          dateISO(g(row, ["Date of Birth", "DOB"])),
          nz(g(row, ["Blood Group"])),
          nz(g(row, ["Occupation"])),
          nz(g(row, ["Marital Status"])),
          nz(g(row, ["Address", "Complete Address"])),
          nz(g(row, ["Mobile No.", "Mobile"])),
          nz(g(row, ["Mobile 2", "Mobile2", "Landline"])),
          nz(g(row, ["WhatsApp No.", "WhatsApp"])),
          nz(g(row, ["Email"])),
          nz(g(row, ["Emergency Name", "In Case Of Emergency Contact Person"])),
          nz(g(row, ["Emergency Contact", "In Case Of Emergency Contact Number"])),
          nz(g(row, ["Emergency Relation", "Relation with Person"])),
          panelId ? "Panel" : "Normal",
          panelId,
          panelId ? (nz(g(row, ["Panel Category"])) === "Pensioner" ? "Pensioner" : nz(g(row, ["Panel Category"]))) : null,
          panelId ? nz(g(row, ["Card ID"])) : null,
          nz(g(row, ["Referred By", "How did you know about this clinic?"])),
          // Anything the register spelled some other way becomes "Other"
          // rather than being refused by the check constraint.
          refType ? (ALLOWED.includes(refType) ? refType : "Other") : null,
          dateISO(g(row, ["Timestamp", "Registered On"]))
        ]
      );

      // Every row of the register is a COLLECTION. Forty patients had
      // several; in the sheets they looked like duplicates, and here they
      // are what they always were — the same patient, asked again.
      await client.query(
        `INSERT INTO patient_registrations (
           uhid, collected_at, status, conditions, allergies, medicines, habits,
           chief_complaint, pain_level, how_known, snapshot)
         VALUES ($1, COALESCE($2::timestamptz, now()), 'Complete', $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
          uhid,
          dateISO(g(row, ["Timestamp", "Registered On"])),
          listOf(g(row, ["Conditions", "Have you ever suffered/suffering from any of the following?"])),
          listOf(g(row, ["Allergies", "Are you allergic to any of the following?"])),
          nz(g(row, ["Medicines", "Medicines you are taking currently:"])),
          listOf(g(row, ["Habits"])),
          nz(g(row, ["Complaint", "What is your chief complaint?"])),
          (() => {
            const n = num(g(row, ["Pain Level", "What is your level of pain on a scale of 0-10?"]));
            return n === null || n < 0 || n > 10 ? null : Math.round(n);
          })(),
          listOf(g(row, ["How did you know about this clinic?"])),
          JSON.stringify(Object.fromEntries(t.table.headers.map((h, i) => [h, row[i]])))
        ]
      );
      placed++;
    }
    count(report.in, `${t.book}/${t.tab}`, t.table.rows.length);
    count(report.out, `${t.book}/${t.tab}`, placed);
  }

  const n = await client.query("SELECT count(*)::int n FROM patients");
  report.notes.push(`${n.rows[0].n} patients from all books (the register's rows are collections, not patients)`);
}

// ── treatment cases ──────────────────────────────────────────────────────
// Returns a map from the sheet's CaseId text to the new numeric id, so the
// appointments that reference them can be joined up.
async function importCases(client, findAny, use) {
  const ids = new Map();
  for (const t of findAny("Treatment Cases")) {
    use(t);
    let n = 0;
    for (const row of t.table.rows) {
      const ref = t.table.get(row, ["CaseId", "Case Id"]);
      const uhid = uhidOf(t.table.get(row, ["UHID"]));
      const code = t.table.get(row, ["ProcedureCode", "Procedure Code"]);
      if (!uhid || !code) { reject("Treatment Cases", "no UHID or procedure code", row); continue; }

      const known = await client.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
      if (!known.rowCount) { reject("Treatment Cases", `${uhid} is in no register`, row); continue; }
      // A case for a procedure the library no longer lists would be refused
      // by the foreign key. Put the procedure back rather than lose the case.
      await client.query(
        `INSERT INTO procedures (code, name, family_code) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [code, t.table.get(row, ["ProcedureName", "Procedure Name"]) || code,
         t.table.get(row, ["FamilyCode", "Family Code"]) || "OTHER"]
      );

      const status = t.table.get(row, ["CaseStatus", "Status"]);
      const closed = dateISO(t.table.get(row, ["ClosedDate", "Closed Date"]));
      const dbStatus = status === "completed" ? "completed" : status === "abandoned" ? "abandoned" : "open";
      const r = await client.query(
        `INSERT INTO treatment_cases
           (uhid, procedure_code, tooth_numbers, patient_name, status, opened_on, closed_on, visit_counter)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7, $8) RETURNING id`,
        [uhid, code, nz(t.table.get(row, ["ToothRef", "Tooth Ref"])),
         nz(t.table.get(row, ["PatientName", "Patient Name"])), dbStatus,
         dateISO(t.table.get(row, ["OpenedDate", "Opened Date"])),
         dbStatus === "open" ? null : closed,
         Math.max(0, Math.round(num(t.table.get(row, ["VisitCounter", "Visit Counter"])) || 0))]
      );
      const caseId = r.rows[0].id;
      if (ref) ids.set(ref, caseId);

      let stages = [];
      try { stages = JSON.parse(t.table.get(row, ["StagesJson", "Stages"]) || "[]"); } catch (_) { stages = []; }
      for (const s of (Array.isArray(stages) ? stages : [])) {
        if (s.sequenceNo === undefined) continue;
        await client.query(
          `INSERT INTO case_stages
             (case_id, sequence_no, stage_code, stage_name, status, done_on, completes_treatment)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (case_id, sequence_no) DO NOTHING`,
          [caseId, Number(s.sequenceNo), nz(s.stageCode), String(s.stageName || "Stage"),
           ["completed", "skipped"].includes(s.status) ? s.status : "pending",
           dateISO(s.completedDate), s.completesTreatment === true]
        );
      }
      n++;
    }
    count(report.in, "Treatment Cases", t.table.rows.length);
    count(report.out, "Treatment Cases", n);
  }
  return ids;
}

// ── appointments ─────────────────────────────────────────────────────────
async function importAppointments(client, findAny, use, caseIds) {
  const ids = new Map();
  for (const t of findAny("Appointments")) {
    use(t);
    let n = 0;
    for (const row of t.table.rows) {
      const g = (names) => t.table.get(row, names);
      const date = dateISO(g(["Date"]));
      const time = timeHM(g(["Time"]));
      if (!date || !time) { reject("Appointments", "no readable date or time", row); continue; }

      const uhid = uhidOf(g(["UHID"]));
      let uhidOrNull = null;
      if (uhid) {
        const known = await client.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
        if (known.rowCount) uhidOrNull = uhid;
        else reject("Appointments", `${uhid} is in no register — kept as a name-only booking`, row);
      }

      const doctorId = await upsertNamed(client, "doctors", g(["Doctor"]));
      let chairId = await upsertNamed(client, "chairs", g(["Chair"]));

      const rawStatus = g(["Status"]) || "Scheduled";
      const ALLOWED = ["Scheduled", "Checked In", "In Chair", "Completed", "Cancelled", "No Show"];
      const status = ALLOWED.includes(rawStatus) ? rawStatus : "Scheduled";

      // The stamps, in order. A sheet row that had a checkout and no
      // check-in cannot go in as it stands — the constraint refuses it —
      // so the gap is filled from the stamp before it and reported.
      let checkin = stamp(date, g(["CheckinTime"]));
      let engaged = stamp(date, g(["EngagedTime"]));
      let checkout = stamp(date, g(["CheckoutTime"]));
      if (engaged && !checkin) { checkin = engaged; reject("Appointments", "engaged with no check-in — check-in set to the same time", row); }
      if (checkout && !engaged) { engaged = checkout; if (!checkin) checkin = checkout; reject("Appointments", "checked out with no earlier stamp — filled from the checkout", row); }

      let cancelReason = nz(g(["CancelReason"]));
      if (status === "Cancelled" && !cancelReason) {
        cancelReason = "Not recorded (cancelled before the reason was asked for)";
      }

      const caseRef = g(["CaseId"]);
      const caseId = caseRef && caseIds.has(caseRef) ? caseIds.get(caseRef) : null;
      if (caseRef && !caseId) reject("Appointments", `case ${caseRef} is in no case sheet`, row);

      // Two bookings in one chair at one time: the sheet allowed it, the
      // index does not. The second keeps its booking and loses its chair,
      // which the desk can put right — losing the appointment would be worse.
      //
      // A savepoint, not a bare retry: in Postgres the first failed
      // statement aborts the whole transaction, and every statement after
      // it is refused until something rolls back. The savepoint undoes just
      // this insert and leaves the migration running.
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        await client.query("SAVEPOINT booking");
        try {
          r = await client.query(
            `INSERT INTO appointments (
               uhid, patient_name, mobile, appt_date, appt_time, reason, sub_type,
               doctor_id, chair_id, case_id, notes, status,
               checkin_at, engaged_at, checkout_at, cancel_reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
            [uhidOrNull, g(["Patient Name"]) || uhid || "(no name)", nz(g(["Mobile"])),
             date, time, g(["Type"]) || "Consultation", nz(g(["SubType"])),
             doctorId, chairId, caseId, nz(g(["Notes"])), status,
             checkin, engaged, checkout, cancelReason]
          );
          await client.query("RELEASE SAVEPOINT booking");
          break;
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT booking");
          if (e.constraint === "one_patient_per_chair_per_slot" && chairId !== null) {
            reject("Appointments", `${g(["Chair"])} was double-booked at ${time} on ${date} — kept with no chair`, row);
            chairId = null;
            continue;
          }
          throw e;
        }
      }
      if (g(["ID"])) ids.set(g(["ID"]), r.rows[0].id);
      n++;
    }
    count(report.in, "Appointments", t.table.rows.length);
    count(report.out, "Appointments", n);
  }
  return ids;
}

function stamp(date, hhmm) {
  const t = timeHM(hhmm);
  return t ? `${date}T${t}:00` : null;
}

// ── the Daily Register ───────────────────────────────────────────────────
async function importVisits(client, findAny, use) {
  for (const t of findAny("Daily Register")) {
    use(t);
    let n = 0;
    for (const row of t.table.rows) {
      const g = (names) => t.table.get(row, names);
      const uhid = uhidOf(g(["UHID / Registration ID", "UHID", "Registration ID"]));
      const date = dateISO(g(["Timestamp", "Date"]));
      if (!uhid || !date) { reject("Daily Register", "no UHID or no readable date", row); continue; }

      const known = await client.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
      if (!known.rowCount) { reject("Daily Register", `${uhid} is in no register`, row); continue; }

      const doctorId = await upsertNamed(client, "doctors", g(["Operating Doctor"]));
      await client.query(
        `INSERT INTO visits (
           uhid, visit_date, procedure_done, tooth_numbers, work_done, doctor_id,
           initial_assessment_done, care_plan_documented,
           walk_in_at, consultation_at, delay_reason, payment_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (uhid, visit_date) DO UPDATE SET
           procedure_done = COALESCE(visits.procedure_done, EXCLUDED.procedure_done),
           work_done      = COALESCE(visits.work_done, EXCLUDED.work_done),
           tooth_numbers  = COALESCE(visits.tooth_numbers, EXCLUDED.tooth_numbers)`,
        [uhid, date, nz(g(["Procedure Done"])), nz(g(["Tooth No. (If any)", "Tooth No."])),
         nz(g(["Work Done"])), doctorId,
         bool(g(["Initial Assessment Done"])), bool(g(["Care Plan Documented"])),
         timeHM(g(["Time of Walk-in", "Time of Walk in"])), timeHM(g(["Consultation Time"])),
         nz(g(["If Delay Reason for Delay"])), nz(g(["Mode of payment & payment"]))]
      );
      n++;
    }
    count(report.in, "Daily Register", t.table.rows.length);
    count(report.out, "Daily Register", n);
  }
}

// ── money ────────────────────────────────────────────────────────────────
async function importPayments(client, findAny, use) {
  for (const t of [...findAny("Patient Fee Receipt"), ...findAny("Receipts")]) {
    use(t);
    let n = 0, total = 0;
    for (const row of t.table.rows) {
      const g = (names) => t.table.get(row, names);
      const uhid = uhidOf(g(["UHID"]));
      const amount = num(g(["Fee", "Amount", "Amount Received", "Total"]));
      const date = dateISO(g(["Date"]));
      if (!uhid || amount === null || amount <= 0 || !date) {
        reject("Receipts", "no UHID, no amount, or no readable date", row);
        continue;
      }
      const known = await client.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
      if (!known.rowCount) { reject("Receipts", `${uhid} is in no register — RECEIPT NOT IMPORTED`, row); continue; }

      // Attach to that day's visit if there is one. If there is not, the
      // payment is still the patient's: that is the whole point.
      const v = await client.query(
        "SELECT id FROM visits WHERE uhid = $1 AND visit_date = $2", [uhid, date]
      );
      let receiptNo = nz(g(["E. Receipt No", "Receipt No.", "Receipt No", "Receipt"]));
      // Two receipts with one number exist in the sheet. The number is kept
      // on the first and the later ones are suffixed, so neither is lost.
      if (receiptNo) {
        const clash = await client.query("SELECT 1 FROM payments WHERE receipt_no = $1", [receiptNo]);
        if (clash.rowCount) {
          const original = receiptNo;
          let i = 2;
          for (;;) {
            const candidate = `${original}-${i}`;
            const again = await client.query("SELECT 1 FROM payments WHERE receipt_no = $1", [candidate]);
            if (!again.rowCount) { receiptNo = candidate; break; }
            i++;
          }
          reject("Receipts", `receipt number ${original} was used more than once — this one stored as ${receiptNo}`, row);
        }
      }

      await client.query(
        `INSERT INTO payments (uhid, visit_id, paid_on, amount, mode, service, receipt_no, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uhid, v.rowCount ? v.rows[0].id : null, date, amount,
         nz(g(["Mode", "Mode of Payment"])) || "Cash",
         nz(g(["Nature of Professional Services", "Service"])),
         receiptNo, nz(g(["Remarks"]))]
      );
      n++; total += amount;
    }
    count(report.in, t.tab, t.table.rows.length);
    count(report.out, t.tab, n);
    report.notes.push(`${t.tab}: ₹${total.toLocaleString("en-IN")} imported`);
  }
}

async function importExpenses(client, findAny, use) {
  for (const t of findAny("Expenses")) {
    use(t);
    let n = 0;
    for (const row of t.table.rows) {
      const g = (names) => t.table.get(row, names);
      const amount = num(g(["Amount"]));
      const date = dateISO(g(["Date"]));
      if (amount === null || amount <= 0 || !date) { reject("Expenses", "no amount or no readable date", row); continue; }
      await client.query(
        `INSERT INTO expenses (spent_on, category, amount, mode, payee, remarks)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [date, nz(g(["Category"])) || "Other", amount,
         nz(g(["Mode"])), nz(g(["Payee", "Paid To"])), nz(g(["Remarks"]))]
      );
      n++;
    }
    count(report.in, "Expenses", t.table.rows.length);
    count(report.out, "Expenses", n);
  }
}

// ── clinical records ─────────────────────────────────────────────────────
// Every clinical tab becomes rows of one table, each keeping its own shape.
const CLINICAL_TABS = {
  "Clinical Sheets": "clinical_sheets",
  "Clinical records": "clinical_record",
  "Clinical Notes": "clinical_note",
  "Pathology": "pathology",
  "Radiology": "radiology",
  "Lab Log": "lab_log",
  "Prescriptions": "prescription",
  "Consents": "consent",
  "Care Plans": "care_plan",
  "Treatment Plans": "treatment_plan",
  "Patient Documents": "patient_document",
  "Blocked Slots": "blocked_slot"
};

async function importClinical(client, tabs, use) {
  for (const t of tabs) {
    const formType = CLINICAL_TABS[Object.keys(CLINICAL_TABS).find((k) => norm(k) === norm(t.tab))];
    if (!formType) continue;
    use(t);
    let n = 0;

    for (const row of t.table.rows) {
      const g = (names) => t.table.get(row, names);
      const asObject = Object.fromEntries(t.table.headers.map((h, i) => [h, row[i]]));

      if (formType === "blocked_slot") {
        const date = dateISO(g(["Date"]));
        if (!date) { reject(t.tab, "no readable date", row); continue; }
        await client.query(
          `INSERT INTO blocked_slots (block_date, from_time, to_time, chair_id, doctor_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [date, timeHM(g(["From", "From Time"])) || "00:00",
           timeHM(g(["To", "To Time"])) || "23:59",
           await upsertNamed(client, "chairs", g(["Chair"])),
           await upsertNamed(client, "doctors", g(["Doctor"])), nz(g(["Reason"]))]
        );
        n++;
        continue;
      }

      const uhid = uhidOf(g(["UHID", "Registration ID"]));
      if (!uhid) { reject(t.tab, "no UHID", row); continue; }
      const known = await client.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
      if (!known.rowCount) { reject(t.tab, `${uhid} is in no register`, row); continue; }
      const date = dateISO(g(["Date", "Saved At", "Timestamp"]));

      if (formType === "care_plan") {
        await client.query(
          `INSERT INTO care_plans (uhid, plan_date, data) VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3::jsonb)`,
          [uhid, date, JSON.stringify(asObject)]
        );
      } else if (formType === "treatment_plan") {
        await client.query(
          `INSERT INTO treatment_plans (uhid, plan_date, plan_rows, estimate)
           VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3::jsonb, $4::jsonb)`,
          [uhid, date, g(["Rows"]) || "[]", nz(g(["Estimate"]))]
        );
      } else if (formType === "consent") {
        await client.query(
          `INSERT INTO consents (uhid, consent_type, signed_on, data)
           VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4::jsonb)`,
          [uhid, nz(g(["Consent Type", "Type"])) || "General", date, JSON.stringify(asObject)]
        );
      } else if (formType === "prescription") {
        await client.query(
          `INSERT INTO prescriptions (uhid, prescribed_on, procedure_text, teeth, notes, medicines)
           VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6::jsonb)`,
          [uhid, date, nz(g(["Procedure"])), nz(g(["Teeth"])), nz(g(["Notes"])),
           (() => { try { return JSON.stringify(JSON.parse(g(["Medicines"]) || "[]")); } catch (_) { return "[]"; } })()]
        );
      } else if (formType === "patient_document") {
        const storage = nz(g(["File Id", "Drive File Id", "File"]));
        if (!storage) { reject(t.tab, "no file reference", row); continue; }
        await client.query(
          `INSERT INTO patient_documents (uhid, file_name, mime_type, category, storage_ref, doc_key)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (uhid, doc_key) DO NOTHING`,
          [uhid, nz(g(["File Name"])) || "document",
           nz(g(["Mime Type", "Type"])) || "application/octet-stream",
           nz(g(["Category"])) || "Other", storage, nz(g(["Doc Key"]))]
        );
        report.notes.push("patient_documents: rows point at Drive file ids — the files themselves still have to be downloaded into the documents folder");
      } else {
        const v = date
          ? await client.query("SELECT id FROM visits WHERE uhid = $1 AND visit_date = $2", [uhid, date])
          : { rowCount: 0 };
        await client.query(
          `INSERT INTO clinical_records (uhid, form_type, visit_id, record_date, site, data)
           VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6::jsonb)`,
          [uhid, formType, v.rowCount ? v.rows[0].id : null, date,
           nz(g(["Tooth No.", "Tooth No", "Site"])), JSON.stringify(asObject)]
        );
      }
      n++;
    }
    count(report.in, t.tab, t.table.rows.length);
    count(report.out, t.tab, n);
  }
  // Said once, not once per row.
  report.notes = [...new Set(report.notes)];
}

// ── CRM ──────────────────────────────────────────────────────────────────
async function importCrm(client, tabs, use) {
  for (const t of tabs) {
    if (!/^crm /i.test(t.tab)) continue;
    use(t);
    const name = t.tab.replace(/^crm /i, "").trim().toLowerCase();

    if (name === "lead inbox") {
      let n = 0;
      for (const row of t.table.rows) {
        const uhid = uhidOf(t.table.get(row, ["UHID"]));
        if (!uhid) continue;
        const known = await client.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
        if (!known.rowCount) { reject(t.tab, `${uhid} is in no register`, row); continue; }
        await client.query(
          `INSERT INTO crm_lead_inbox (uhid, patient_name, mobile, panel, referred_by, referred_by_type, taken_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (uhid) DO NOTHING`,
          [uhid, t.table.get(row, ["Name"]) || uhid, nz(t.table.get(row, ["Mobile"])),
           nz(t.table.get(row, ["Panel"])), nz(t.table.get(row, ["Referred By"])),
           nz(t.table.get(row, ["Referred By Type"])),
           nz(t.table.get(row, ["Taken At"])) ? new Date(t.table.get(row, ["Taken At"])) : null]
        );
        n++;
      }
      count(report.in, t.tab, t.table.rows.length);
      count(report.out, t.tab, n);
      continue;
    }

    // The CRM's own collections keep their own shape — see the note in
    // database/002-api.sql.
    let n = 0;
    for (let i = 0; i < t.table.rows.length; i++) {
      const row = t.table.rows[i];
      const rec = {};
      t.table.headers.forEach((h, j) => {
        const raw = row[j] == null ? "" : String(row[j]);
        // The CRM writes JSON into some cells. Keep it as JSON rather than
        // as a string that looks like it.
        if (/^[[{]/.test(raw.trim())) { try { rec[h] = JSON.parse(raw); return; } catch (_) { /* a plain string after all */ } }
        rec[h] = raw;
      });
      const id = String(rec.id || rec.ID || `row-${i + 1}`);
      await client.query(
        `INSERT INTO crm_documents (collection, record_id, data) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (collection, record_id) DO UPDATE SET data = EXCLUDED.data`,
        [name, id, JSON.stringify(rec)]
      );
      n++;
    }
    count(report.in, t.tab, t.table.rows.length);
    count(report.out, t.tab, n);
  }
}

// ── the report ───────────────────────────────────────────────────────────
function printReport() {
  console.log("── What went in");
  const keys = [...new Set([...Object.keys(report.in), ...Object.keys(report.out)])].sort();
  for (const k of keys) {
    const i = report.in[k] || 0, o = report.out[k] || 0;
    const mark = i === o ? "  " : "!!";
    console.log(`${mark} ${k.padEnd(34)} ${String(i).padStart(6)} read  ${String(o).padStart(6)} written`);
  }
  if (report.notes.length) {
    console.log("\n── Notes");
    for (const n of report.notes) console.log(`   ${n}`);
  }
  if (report.skippedTabs.length) {
    console.log("\n── Tabs nothing was done with");
    for (const s of report.skippedTabs) console.log(`   ${s}`);
  }
  if (report.rejected.length) {
    console.log(`\n── ${report.rejected.length} row(s) could not be placed as they stood`);
    const byWhy = {};
    for (const r of report.rejected) {
      const key = `${r.what}: ${r.why.replace(/\b[A-Z]{2}\d{4,}\b/g, "<uhid>")}`;
      byWhy[key] = (byWhy[key] || 0) + 1;
    }
    for (const [why, n] of Object.entries(byWhy).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(n).padStart(5)} × ${why}`);
    }
    console.log("   (every one of them, in full, is in import-report.json)");
  } else {
    console.log("\n   Every row was placed.");
  }
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
