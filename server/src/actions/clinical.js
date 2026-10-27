// The clinical side: the Daily Register, treatment progress, the 21 forms,
// care and treatment plans, consents and prescriptions.
const { query, tx } = require("../db");
const {
  nz, num, bool, dateISO, timeHM, timeOrNull, uhidOf, parseObject, parseList, ageFrom, tatBetween
} = require("../util");
const { namedId } = require("./appointments");

const actions = {};

// ── the Daily Register ───────────────────────────────────────────────────
// One row per patient per day. The merge that saveToDailyRegister did by
// hand — an X-ray, a scan and local anesthesia in one visit must not make
// three rows — is now the unique index on (uhid, visit_date), so it cannot
// be got wrong by a second screen saving at the same moment.
actions.saveToDailyRegister = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A register entry needs a UHID" };
  const date = dateISO(p.date) || dateISO(new Date());

  return tx(async (c) => {
    const known = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
    if (!known.rowCount) return { success: false, error: `Patient not found: ${uhid}` };

    const doctorId = await namedId(c, "doctors", p.operatingDoctor || p.doctor);
    // COALESCE throughout: the second save of the day adds what it knows and
    // leaves the rest of the row alone.
    const r = await c.query(
      `INSERT INTO visits (
         uhid, visit_date, appointment_id, case_id, procedure_done, tooth_numbers,
         work_done, doctor_id, initial_assessment_done, care_plan_documented,
         walk_in_at, consultation_at, delay_reason, payment_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (uhid, visit_date) DO UPDATE SET
         appointment_id = COALESCE(EXCLUDED.appointment_id, visits.appointment_id),
         case_id        = COALESCE(EXCLUDED.case_id, visits.case_id),
         procedure_done = COALESCE(NULLIF(EXCLUDED.procedure_done, ''), visits.procedure_done),
         tooth_numbers  = COALESCE(NULLIF(EXCLUDED.tooth_numbers, ''), visits.tooth_numbers),
         work_done      = COALESCE(NULLIF(EXCLUDED.work_done, ''), visits.work_done),
         doctor_id      = COALESCE(EXCLUDED.doctor_id, visits.doctor_id),
         initial_assessment_done = COALESCE(EXCLUDED.initial_assessment_done, visits.initial_assessment_done),
         care_plan_documented    = COALESCE(EXCLUDED.care_plan_documented, visits.care_plan_documented),
         walk_in_at      = COALESCE(visits.walk_in_at, EXCLUDED.walk_in_at),
         consultation_at = COALESCE(visits.consultation_at, EXCLUDED.consultation_at),
         delay_reason    = COALESCE(NULLIF(EXCLUDED.delay_reason, ''), visits.delay_reason),
         payment_note    = COALESCE(NULLIF(EXCLUDED.payment_note, ''), visits.payment_note)
       RETURNING id`,
      [
        uhid, date, p.appointmentId ? Number(p.appointmentId) : null,
        p.caseId ? Number(p.caseId) : null,
        nz(p.procedureDone), nz(p.toothNo), nz(p.workDone), doctorId,
        bool(p.initialAssessment), bool(p.carePlanDocumented),
        timeOrNull(p.timeWalkIn), timeOrNull(p.consultationTime),
        nz(p.delayReason), nz(p.modeOfPayment)
      ]
    );
    return { success: true, id: String(r.rows[0].id), row: String(r.rows[0].id) };
  });
};

// The register, as the screen shows it. Age and phone are the patient's and
// are read from `patients` — in the sheet they were copied into every row
// and went stale the day somebody changed their number.
const REGISTER_SELECT = `
  SELECT v.id, v.uhid, v.visit_date, v.procedure_done, v.tooth_numbers,
         v.work_done, v.initial_assessment_done, v.care_plan_documented,
         v.walk_in_at, v.consultation_at, v.delay_reason, v.payment_note,
         d.name AS doctor, p.full_name, p.mobile, p.date_of_birth
    FROM visits v
    JOIN patients p ON p.uhid = v.uhid
    LEFT JOIN doctors d ON d.id = v.doctor_id`;

function registerRow(x) {
  return {
    id: String(x.id),
    month: x.visit_date
      ? new Date(`${dateISO(x.visit_date)}T12:00:00`).toLocaleString("en-US", { month: "long" })
      : "",
    date: dateISO(x.visit_date),
    uhid: x.uhid,
    patientName: x.full_name || "",
    phoneNo: x.mobile || "",
    age: ageFrom(x.date_of_birth),
    timeWalkIn: timeHM(x.walk_in_at),
    consultationTime: timeHM(x.consultation_at),
    tat: tatBetween(x.walk_in_at, x.consultation_at),
    initialAssessment: x.initial_assessment_done === null ? "" : (x.initial_assessment_done ? "Yes" : "No"),
    carePlanDocumented: x.care_plan_documented === null ? "" : (x.care_plan_documented ? "Yes" : "No"),
    procedureDone: x.procedure_done || "",
    toothNo: x.tooth_numbers || "",
    workDone: x.work_done || "",
    operatingDoctor: x.doctor || "",
    delayReason: x.delay_reason || "",
    modeOfPayment: x.payment_note || ""
  };
}

actions.getDailyRegister = async (p) => {
  const parts = [], params = [];
  if (uhidOf(p.uhid)) { params.push(uhidOf(p.uhid)); parts.push(`v.uhid = $${params.length}`); }
  if (dateISO(p.date)) { params.push(dateISO(p.date)); parts.push(`v.visit_date = $${params.length}`); }
  if (dateISO(p.fromDate)) { params.push(dateISO(p.fromDate)); parts.push(`v.visit_date >= $${params.length}`); }
  if (dateISO(p.toDate)) { params.push(dateISO(p.toDate)); parts.push(`v.visit_date <= $${params.length}`); }
  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  const r = await query(
    `${REGISTER_SELECT} ${where} ORDER BY v.visit_date DESC, v.id DESC`, params
  );
  return { success: true, entries: r.rows.map(registerRow) };
};

// ── Procedures, Notes & Fees ─────────────────────────────────────────────
//
// What was done, and what was paid, for one patient. This is the screen that
// showed ₹1,05,000 against ₹1,70,000 in Finance, because the two were joined
// by DATE in the browser and a payment taken on a day with no register entry
// had nowhere to land.
//
// Here a payment names its patient, always, and its visit when that is
// known. The total is the sum of the payments table either way, and a
// payment with no visit gets its own line rather than being dropped.
actions.getTreatmentProgress = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: true, entries: [] };

  const visits = await query(
    `${REGISTER_SELECT} WHERE v.uhid = $1 ORDER BY v.visit_date, v.id`, [uhid]
  );
  const pays = await query(
    `SELECT id, visit_id, paid_on, amount, mode, service, receipt_no
       FROM payments WHERE uhid = $1 ORDER BY paid_on, id`,
    [uhid]
  );

  const byVisit = new Map();
  const loose = [];
  for (const pay of pays.rows) {
    if (pay.visit_id) {
      if (!byVisit.has(String(pay.visit_id))) byVisit.set(String(pay.visit_id), []);
      byVisit.get(String(pay.visit_id)).push(pay);
    } else {
      loose.push(pay);
    }
  }

  const entries = [];
  for (const v of visits.rows) {
    const mine = byVisit.get(String(v.id)) || [];
    // A payment with no visit of its own, taken on a day this patient was
    // seen, belongs to that day's line — but only once, and only if it has
    // not already been claimed by another line.
    for (let i = loose.length - 1; i >= 0; i--) {
      if (dateISO(loose[i].paid_on) === dateISO(v.visit_date)) {
        mine.push(loose[i]);
        loose.splice(i, 1);
      }
    }
    const row = registerRow(v);
    row.amountReceived = mine.reduce((s, x) => s + Number(x.amount), 0);
    row.paymentMode = [...new Set(mine.map((x) => x.mode).filter(Boolean))].join(", ");
    row.receiptNo = mine.map((x) => x.receipt_no).filter(Boolean).join(", ");
    entries.push(row);
  }

  // Everything still unclaimed: an advance taken before the procedure was
  // written up. It is the patient's money and it shows.
  for (const pay of loose) {
    entries.push({
      id: `pay-${pay.id}`,
      date: dateISO(pay.paid_on),
      uhid,
      patientName: visits.rowCount ? visits.rows[0].full_name : "",
      procedureDone: pay.service || "Payment received",
      toothNo: "", workDone: "", operatingDoctor: "",
      month: "", phoneNo: "", age: "", timeWalkIn: "", consultationTime: "", tat: "",
      initialAssessment: "", carePlanDocumented: "", delayReason: "", modeOfPayment: "",
      amountReceived: Number(pay.amount),
      paymentMode: pay.mode || "",
      receiptNo: pay.receipt_no || "",
      paymentOnly: true
    });
  }

  entries.sort((a, b) => (a.date || "").localeCompare(b.date || "") ||
                         (a.paymentOnly ? 1 : 0) - (b.paymentOnly ? 1 : 0));
  const total = entries.reduce((s, x) => s + (x.amountReceived || 0), 0);
  return { success: true, entries, totalReceived: total };
};

// ── the 21 forms ─────────────────────────────────────────────────────────
//
// One table, one row per form filled, the form's own shape in `data`. A new
// form needs no new tab and no schema change — which is what twenty-one tabs
// with twenty-one column orders were costing.
const FORM_ACTIONS = {
  savePathology: "pathology",
  saveRadiology: "radiology",
  saveRadiograph: "radiograph",
  saveLocalAnesthesia: "local_anesthesia",
  saveIntraOralScanning: "intra_oral_scanning",
  saveScaling: "scaling",
  saveMinorSurgery: "minor_surgery",
  saveTMJoint: "tm_joint",
  saveRestoration: "restoration",
  saveOrthodontics: "orthodontics",
  saveOrthodonticsProgress: "orthodontics_progress",
  saveDenture: "denture",
  savePedo: "pedo",
  saveLabLog: "lab_log"
};

async function saveForm(formType, p) {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A clinical record needs a UHID" };
  return tx(async (c) => {
    const known = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
    if (!known.rowCount) return { success: false, error: `Patient not found: ${uhid}` };
    const date = dateISO(p.date) || dateISO(new Date());
    // The register row for that day, if there is one — so a form and the
    // visit it belongs to are joined by a column, not by a date guess.
    const v = await c.query(
      "SELECT id FROM visits WHERE uhid = $1 AND visit_date = $2", [uhid, date]
    );
    const r = await c.query(
      `INSERT INTO clinical_records (
         uhid, form_type, visit_id, case_id, record_date, site, doctor_id, data, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING id`,
      [
        uhid, formType, v.rowCount ? v.rows[0].id : null,
        p.caseId ? Number(p.caseId) : null, date,
        nz(p.toothNo || p.site || p.arch),
        await namedId(c, "doctors", p.doctor || p.operatingDoctor),
        JSON.stringify(p), nz(p.savedBy)
      ]
    );
    return { success: true, id: String(r.rows[0].id) };
  });
}

for (const [action, formType] of Object.entries(FORM_ACTIONS)) {
  actions[action] = (p) => saveForm(formType, p);
}

actions.getClinicalRecords = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: true, records: [], headers: [] };
  const parts = ["uhid = $1"], params = [uhid];
  if (nz(p.formType)) { params.push(nz(p.formType)); parts.push(`form_type = $${params.length}`); }
  const r = await query(
    `SELECT id, form_type, record_date, site, data, created_at
       FROM clinical_records WHERE ${parts.join(" AND ")}
      ORDER BY record_date DESC, id DESC`,
    params
  );
  return {
    success: true,
    records: r.rows.map((x) => ({
      id: String(x.id), formType: x.form_type, date: dateISO(x.record_date),
      site: x.site || "", ...x.data
    })),
    headers: []
  };
};

// ── the four-page records form ───────────────────────────────────────────
actions.getClinicalSheets = async (p) => {
  const uhid = uhidOf(p.uhid);
  const r = await query(
    `SELECT data FROM clinical_records
      WHERE uhid = $1 AND form_type = 'clinical_sheets'
      ORDER BY record_date DESC, id DESC LIMIT 1`,
    [uhid]
  );
  const d = r.rowCount ? r.rows[0].data : {};
  return {
    success: true,
    page1: d.page1 || null, page2: d.page2 || null,
    page3: d.page3 || null, page4: d.page4 || null
  };
};

actions.saveClinicalSheets = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A clinical sheet needs a UHID" };
  return tx(async (c) => {
    // One living record per patient, updated in place: these four pages are
    // the patient's current examination, not a new one every save.
    const existing = await c.query(
      `SELECT id, data FROM clinical_records
        WHERE uhid = $1 AND form_type = 'clinical_sheets'
        ORDER BY record_date DESC, id DESC LIMIT 1`,
      [uhid]
    );
    const merged = existing.rowCount ? { ...existing.rows[0].data } : {};
    for (const page of ["page1", "page2", "page3", "page4"]) {
      if (p[page] !== undefined) {
        merged[page] = typeof p[page] === "string" ? JSON.parse(p[page]) : p[page];
      }
    }
    if (existing.rowCount) {
      await c.query("UPDATE clinical_records SET data = $2::jsonb WHERE id = $1",
        [existing.rows[0].id, JSON.stringify(merged)]);
      return { success: true, id: String(existing.rows[0].id) };
    }
    const known = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
    if (!known.rowCount) return { success: false, error: `Patient not found: ${uhid}` };
    const r = await c.query(
      `INSERT INTO clinical_records (uhid, form_type, record_date, data)
       VALUES ($1, 'clinical_sheets', CURRENT_DATE, $2::jsonb) RETURNING id`,
      [uhid, JSON.stringify(merged)]
    );
    return { success: true, id: String(r.rows[0].id) };
  });
};

// ── care plan and treatment plan ─────────────────────────────────────────
actions.getCarePlan = async (p) => {
  const r = await query(
    "SELECT data FROM care_plans WHERE uhid = $1 ORDER BY plan_date DESC, id DESC LIMIT 1",
    [uhidOf(p.uhid)]
  );
  const d = r.rowCount ? r.rows[0].data : {};
  return { success: true, page1: d.page1 || null, page2: d.page2 || null,
           page3: d.page3 || null, page4: d.page4 || null, ...d };
};

actions.saveCarePlan = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A care plan needs a UHID" };
  const data = { ...p };
  delete data.action; delete data.token;
  const r = await query(
    `INSERT INTO care_plans (uhid, plan_date, data)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3::jsonb) RETURNING id`,
    [uhid, dateISO(p.date) || null, JSON.stringify(data)]
  );
  return { success: true, id: String(r.rows[0].id) };
};

actions.getTreatmentPlan = async (p) => {
  const r = await query(
    "SELECT plan_rows, estimate FROM treatment_plans WHERE uhid = $1 ORDER BY plan_date DESC, id DESC LIMIT 1",
    [uhidOf(p.uhid)]
  );
  if (!r.rowCount) return { success: true, rows: null, estimate: null };
  return { success: true, rows: r.rows[0].plan_rows, estimate: r.rows[0].estimate };
};

actions.saveTreatmentPlan = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A treatment plan needs a UHID" };
  const rows = p.rows === undefined ? [] : parseList(p.rows, "treatment plan");
  let estimate = null;
  if (p.estimate !== undefined && p.estimate !== null && String(p.estimate) !== "") {
    estimate = parseObject(p.estimate, "estimate");
  }
  const r = await query(
    `INSERT INTO treatment_plans (uhid, plan_date, plan_rows, estimate)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3::jsonb, $4::jsonb) RETURNING id`,
    [uhid, dateISO(p.date) || null, JSON.stringify(rows),
     estimate === null ? null : JSON.stringify(estimate)]
  );
  return { success: true, id: String(r.rows[0].id) };
};

actions.saveConsent = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A consent needs a UHID" };
  const data = { ...p };
  delete data.action; delete data.token;
  const r = await query(
    `INSERT INTO consents (uhid, consent_type, signed_on, data)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4::jsonb) RETURNING id`,
    [uhid, String(p.consentType || p.type || "General"), dateISO(p.date) || null, JSON.stringify(data)]
  );
  return { success: true, id: String(r.rows[0].id) };
};

// ── prescriptions ────────────────────────────────────────────────────────
actions.savePrescription = async (p) => {
  const uhid = uhidOf(p.uhid);
  if (!uhid) return { success: false, error: "A prescription needs a UHID" };
  return tx(async (c) => {
    const date = dateISO(p.date) || dateISO(new Date());
    const v = await c.query(
      "SELECT id FROM visits WHERE uhid = $1 AND visit_date = $2", [uhid, date]
    );
    const meds = p.medicines === undefined ? [] : parseList(p.medicines, "prescription medicines");
    const r = await c.query(
      `INSERT INTO prescriptions (
         uhid, visit_id, prescribed_on, doctor_id, procedure_text, teeth, notes, medicines)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
      [
        uhid, v.rowCount ? v.rows[0].id : null, date,
        await namedId(c, "doctors", p.doctor), nz(p.procedure), nz(p.teeth), nz(p.notes),
        JSON.stringify(meds)
      ]
    );
    return { success: true, id: String(r.rows[0].id) };
  });
};

module.exports = { actions, registerRow, REGISTER_SELECT, FORM_ACTIONS };
