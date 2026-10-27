// Patients and registration.
//
// The biggest single change in the move. Two books — the main register and
// the empanelled one — become one table with a column saying which kind, and
// NABH's repeat collections become rows of patient_registrations instead of
// extra patients. getAllPatients no longer merges anything in code: it is a
// query.
const { query, tx } = require("../db");
const {
  nz, num, bool, dateISO, uhidOf, uhidPrefix, textArray, parseObject, ageFrom
} = require("../util");

const actions = {};

// ── the next UHID ────────────────────────────────────────────────────────
// Taken from the highest number already issued this month, never from a
// count: a row deleted for any reason would send a counter backwards and
// reissue an id that already belongs to somebody.
actions.getNextUHID = async () => {
  const prefix = uhidPrefix();
  const r = await query(
    `SELECT uhid FROM patients WHERE uhid LIKE $1 || '%'`,
    [prefix]
  );
  let highest = 0;
  for (const row of r.rows) {
    const n = parseInt(String(row.uhid).slice(prefix.length), 10);
    if (!isNaN(n) && n > highest) highest = n;
  }
  // Two digits normally; a month busy enough to pass 99 simply grows to
  // three rather than wrapping onto somebody else.
  return { success: true, uhid: prefix + String(highest + 1).padStart(2, "0") };
};

actions.checkDuplicate = async (p) => {
  const name = String(p.name || "").trim();
  const dob = dateISO(p.dob);
  if (!name || !dob) return { success: true, duplicate: false };
  const r = await query(
    `SELECT uhid, full_name FROM patients
      WHERE lower(full_name) = lower($1) AND date_of_birth = $2 LIMIT 1`,
    [name, dob]
  );
  if (!r.rowCount) return { success: true, duplicate: false };
  return { success: true, duplicate: true, uhid: r.rows[0].uhid, name: r.rows[0].full_name };
};

// ── one row in, one row out ──────────────────────────────────────────────
// A patient's details, and the medical history as given on this occasion.
// The first is an update to `patients`; the second is always a NEW row of
// patient_registrations, which is what NABH re-collection actually is.
async function upsertPatient(c, p) {
  const uhid = uhidOf(p.uhid);
  if (!uhid) {
    const e = new Error("A patient cannot be saved without a UHID");
    e.clientSafe = true;
    throw e;
  }

  const panelName = nz(p.panel);
  const isPanel = String(p.patientType || (panelName ? "Panel" : "Normal")).trim() === "Panel" && panelName;
  let panelId = null;
  if (isPanel) {
    const r = await c.query(
      `INSERT INTO panels (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [panelName]
    );
    panelId = r.rows[0].id;
  }

  // The check constraint refuses a private patient carrying panel details,
  // so they are cleared here rather than smuggled past it.
  const panelCategory = isPanel ? nz(p.panelCategory) : null;
  const cardId = isPanel ? nz(p.cardId) : null;

  // COALESCE on update: a screen that sends only three fields must not blank
  // the other twenty. This is the rule the sheets had no way to express —
  // the iPad form sends a medical history and nothing else, and it used to
  // overwrite the desk's work with empties.
  await c.query(
    `INSERT INTO patients (
       uhid, full_name, gender, date_of_birth, blood_group, occupation,
       marital_status, address, mobile, mobile_2, whatsapp, email,
       emergency_name, emergency_contact, emergency_relation,
       patient_type, panel_id, panel_category, card_id,
       referred_by, referred_by_type, registered_on, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, COALESCE($22::timestamptz, now()), now())
     ON CONFLICT (uhid) DO UPDATE SET
       full_name      = COALESCE(NULLIF(EXCLUDED.full_name, ''), patients.full_name),
       gender         = COALESCE(EXCLUDED.gender, patients.gender),
       date_of_birth  = COALESCE(EXCLUDED.date_of_birth, patients.date_of_birth),
       blood_group    = COALESCE(EXCLUDED.blood_group, patients.blood_group),
       occupation     = COALESCE(EXCLUDED.occupation, patients.occupation),
       marital_status = COALESCE(EXCLUDED.marital_status, patients.marital_status),
       address        = COALESCE(EXCLUDED.address, patients.address),
       mobile         = COALESCE(EXCLUDED.mobile, patients.mobile),
       mobile_2       = COALESCE(EXCLUDED.mobile_2, patients.mobile_2),
       whatsapp       = COALESCE(EXCLUDED.whatsapp, patients.whatsapp),
       email          = COALESCE(EXCLUDED.email, patients.email),
       emergency_name     = COALESCE(EXCLUDED.emergency_name, patients.emergency_name),
       emergency_contact  = COALESCE(EXCLUDED.emergency_contact, patients.emergency_contact),
       emergency_relation = COALESCE(EXCLUDED.emergency_relation, patients.emergency_relation),
       -- A patient going on to a panel is a change; coming off one is done
       -- by saying so, not by sending a blank.
       patient_type   = CASE WHEN EXCLUDED.panel_id IS NOT NULL THEN 'Panel' ELSE patients.patient_type END,
       panel_id       = COALESCE(EXCLUDED.panel_id, patients.panel_id),
       panel_category = COALESCE(EXCLUDED.panel_category, patients.panel_category),
       card_id        = COALESCE(EXCLUDED.card_id, patients.card_id),
       referred_by      = COALESCE(EXCLUDED.referred_by, patients.referred_by),
       referred_by_type = COALESCE(EXCLUDED.referred_by_type, patients.referred_by_type),
       updated_at     = now()`,
    [
      uhid, String(p.name || p.patientName || "").trim(), nz(p.gender), dateISO(p.dob) || null,
      nz(p.bloodGroup), nz(p.occupation), nz(p.maritalStatus), nz(p.address),
      nz(p.mobile), nz(p.mobile2), nz(p.whatsapp), nz(p.email),
      nz(p.emergencyName), nz(p.emergencyContact), nz(p.emergencyRelation),
      isPanel ? "Panel" : "Normal", panelId, panelCategory, cardId,
      nz(p.referredBy), nz(p.referredByType),
      p.registeredOn ? new Date(p.registeredOn).toISOString() : null
    ]
  );
  return uhid;
}

async function addRegistration(c, uhid, p, status) {
  const r = await c.query(
    `INSERT INTO patient_registrations (
       uhid, collected_by, status, conditions, allergies, medicines, habits,
       pregnant, feeding_mother, chief_complaint, pain_level, how_known,
       consent_given, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     RETURNING id`,
    [
      uhid, nz(p.collectedBy), status,
      textArray(p.conditions), textArray(p.allergies), nz(p.medicines), textArray(p.habits),
      bool(p.pregnant), bool(p.feedingMother), nz(p.complaint),
      // 0 is a real pain level; only a blank is "not asked".
      p.painLevel === undefined || p.painLevel === null || String(p.painLevel).trim() === ""
        ? null : num(p.painLevel),
      textArray(p.howKnown), bool(p.consent) === true,
      JSON.stringify(p)
    ]
  );
  return r.rows[0].id;
}

// A new patient becomes a lead the next time somebody opens the CRM. Queued
// here, inside the same transaction as the registration, so there is no
// moment where a patient exists and the lead does not.
async function queueLead(c, uhid, p) {
  await c.query(
    `INSERT INTO crm_lead_inbox (uhid, patient_name, mobile, panel, referred_by, referred_by_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (uhid) DO NOTHING`,
    [uhid, String(p.name || p.patientName || "").trim() || uhid, nz(p.mobile),
     nz(p.panel), nz(p.referredBy), nz(p.referredByType)]
  );
}

actions.saveRegistration = async (p) => {
  return tx(async (c) => {
    const existed = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhidOf(p.uhid)]);
    const uhid = await upsertPatient(c, p);
    await addRegistration(c, uhid, p, "Complete");
    if (!existed.rowCount) await queueLead(c, uhid, p);
    return { success: true, uhid };
  });
};

// The desk's quick save: a name and a number, the rest to follow.
actions.patientLookup = async (p) => {
  const key = String(p.mobile || p.phone || p.uhid || "").trim();
  if (!key) return { success: false, error: "Give a mobile number or a UHID" };
  const r = await query(
    `SELECT uhid, full_name, mobile, date_of_birth FROM patients
      WHERE upper(uhid) = upper($1) OR mobile = $1 OR whatsapp = $1
      ORDER BY registered_on DESC LIMIT 5`,
    [key]
  );
  return {
    success: true,
    patients: r.rows.map((x) => ({
      uhid: x.uhid, name: x.full_name, mobile: x.mobile || "",
      dob: dateISO(x.date_of_birth)
    }))
  };
};

// The patient's own form, on the iPad. It carries the medical history and
// nothing else, which is why every field above is COALESCEd.
actions.patientCompleteRegistration = async (p) => {
  return tx(async (c) => {
    const uhid = uhidOf(p.uhid);
    const found = await c.query("SELECT 1 FROM patients WHERE uhid = $1", [uhid]);
    if (!found.rowCount) return { success: false, error: `Patient not found: ${uhid}` };
    await upsertPatient(c, p);
    await addRegistration(c, uhid, p, "Complete");
    return { success: true, uhid };
  });
};

// Registrations still waiting on the patient's own half.
actions.getPending = async () => {
  const r = await query(
    `SELECT p.uhid, p.full_name, p.mobile, p.registered_on
       FROM patients p
      WHERE NOT EXISTS (
        SELECT 1 FROM patient_registrations r
         WHERE r.uhid = p.uhid AND r.status = 'Complete'
           AND (r.chief_complaint IS NOT NULL OR array_length(r.conditions, 1) > 0))
      ORDER BY p.registered_on DESC LIMIT 200`
  );
  const rows = r.rows.map((x) => ({
    uhid: x.uhid, name: x.full_name, mobile: x.mobile || "",
    registeredOn: x.registered_on ? x.registered_on.toISOString() : ""
  }));
  return { success: true, pending: rows, rows };
};

// ── one patient, in full ─────────────────────────────────────────────────
actions.getPatient = async (p) => {
  const uhid = uhidOf(p.uhid);
  const r = await query(
    `SELECT p.*, pn.name AS panel_name FROM patients p
       LEFT JOIN panels pn ON pn.id = p.panel_id
      WHERE p.uhid = $1`,
    [uhid]
  );
  if (!r.rowCount) return { success: false, error: `Patient not found: ${uhid}` };
  const x = r.rows[0];

  // The newest collection holds the current medical history. A later
  // collection that left a field blank does not erase what an earlier one
  // recorded, so each field is the most recent non-empty answer.
  const h = await query(
    `SELECT conditions, allergies, habits, medicines, chief_complaint, pain_level
       FROM patient_registrations WHERE uhid = $1 ORDER BY collected_at DESC`,
    [uhid]
  );
  const filled = (v) => Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== "";
  const hist = {};
  for (const row of h.rows) {
    for (const [k, v] of Object.entries(row)) {
      if (!filled(hist[k]) && filled(v)) hist[k] = v;
    }
  }

  return {
    success: true,
    patient: {
      uhid: x.uhid,
      name: x.full_name || "",
      gender: x.gender || "",
      dob: dateISO(x.date_of_birth),
      age: ageFrom(x.date_of_birth),
      mobile: x.mobile || "",
      mobile2: x.mobile_2 || "",
      whatsapp: x.whatsapp || "",
      email: x.email || "",
      bloodGroup: x.blood_group || "",
      occupation: x.occupation || "",
      maritalStatus: x.marital_status || "",
      address: x.address || "",
      emergencyName: x.emergency_name || "",
      emergencyRelation: x.emergency_relation || "",
      emergencyContact: x.emergency_contact || "",
      patientType: x.patient_type,
      panel: x.panel_name || "",
      panelCategory: x.panel_category || "",
      cardId: x.card_id || "",
      referredBy: x.referred_by || "",
      referredByType: x.referred_by_type || "",
      conditions: hist.conditions || [],
      allergies: hist.allergies || [],
      habits: (hist.habits || []).join(", "),
      medicines: hist.medicines || "",
      complaint: hist.chief_complaint || "",
      painLevel: hist.pain_level === null || hist.pain_level === undefined ? "" : String(hist.pain_level),
      registeredOn: x.registered_on ? x.registered_on.toISOString() : ""
    }
  };
};

// ── the whole list ───────────────────────────────────────────────────────
// One row per patient, by definition — there is no newest-row-wins pass to
// write, because a patient cannot have two rows here.
actions.getAllPatients = async () => {
  const r = await query(
    `SELECT p.uhid, p.full_name, p.gender, p.date_of_birth, p.mobile,
            p.patient_type, pn.name AS panel, p.panel_category, p.card_id,
            p.referred_by, p.referred_by_type, p.registered_on
       FROM patients p LEFT JOIN panels pn ON pn.id = p.panel_id
      ORDER BY p.registered_on DESC`
  );
  return {
    success: true,
    patients: r.rows.map((x) => ({
      uhid: x.uhid, name: x.full_name || "", gender: x.gender || "",
      dob: dateISO(x.date_of_birth), mobile: x.mobile || "",
      patientType: x.patient_type,
      panel: x.panel || "", panelCategory: x.panel_category || "", cardId: x.card_id || "",
      referredBy: x.referred_by || "", referredByType: x.referred_by_type || "",
      registeredOn: x.registered_on ? x.registered_on.toISOString() : ""
    }))
  };
};

actions.searchPatients = async (p) => {
  const q = String(p.query || p.q || "").trim();
  if (!q) return { success: true, patients: [] };
  // Indexed on lower(full_name) and on mobile; a prefix match uses the index,
  // which is why this is instant where the sheet scanned 2,535 rows.
  const r = await query(
    `SELECT p.uhid, p.full_name, p.gender, p.date_of_birth, p.mobile,
            p.patient_type, pn.name AS panel, p.card_id
       FROM patients p LEFT JOIN panels pn ON pn.id = p.panel_id
      WHERE lower(p.full_name) LIKE lower($1) || '%'
         OR lower(p.full_name) LIKE '%' || lower($1) || '%'
         OR p.mobile LIKE $1 || '%'
         OR p.whatsapp LIKE $1 || '%'
         OR upper(p.uhid) = upper($1)
      ORDER BY (lower(p.full_name) LIKE lower($1) || '%') DESC, p.full_name
      LIMIT 50`,
    [q]
  );
  return {
    success: true,
    patients: r.rows.map((x) => ({
      uhid: x.uhid, name: x.full_name || "", gender: x.gender || "",
      dob: dateISO(x.date_of_birth), age: ageFrom(x.date_of_birth),
      mobile: x.mobile || "", patientType: x.patient_type,
      panel: x.panel || "", cardId: x.card_id || ""
    }))
  };
};

actions.getTodaysBirthdays = async () => {
  const r = await query(
    `SELECT uhid, full_name, mobile, date_of_birth FROM patients
      WHERE date_of_birth IS NOT NULL
        AND to_char(date_of_birth, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD')
      ORDER BY full_name`
  );
  return {
    success: true,
    patients: r.rows.map((x) => ({
      uhid: x.uhid, name: x.full_name, mobile: x.mobile || "",
      dob: dateISO(x.date_of_birth), age: ageFrom(x.date_of_birth)
    }))
  };
};

// Three lists the dashboard shows: patients due a post-treatment call, those
// due a recall, and appointments nobody turned up for.
actions.getFollowUps = async () => {
  const post = await query(
    `SELECT v.uhid, p.full_name, p.mobile, v.visit_date, v.procedure_done
       FROM visits v JOIN patients p ON p.uhid = v.uhid
      WHERE v.visit_date BETWEEN CURRENT_DATE - 3 AND CURRENT_DATE - 1
      ORDER BY v.visit_date DESC`
  );
  const recall = await query(
    `SELECT p.uhid, p.full_name, p.mobile, max(v.visit_date) AS last_seen
       FROM patients p JOIN visits v ON v.uhid = p.uhid
      GROUP BY p.uhid, p.full_name, p.mobile
     HAVING max(v.visit_date) < CURRENT_DATE - 180
      ORDER BY max(v.visit_date) DESC LIMIT 100`
  );
  const missed = await query(
    `SELECT a.uhid, a.patient_name, a.mobile, a.appt_date, a.reason
       FROM appointments a
      WHERE a.status = 'No Show' AND a.appt_date >= CURRENT_DATE - 30
      ORDER BY a.appt_date DESC`
  );
  return {
    success: true,
    postTreatment: post.rows.map((x) => ({
      uhid: x.uhid, name: x.full_name, mobile: x.mobile || "",
      date: dateISO(x.visit_date), procedure: x.procedure_done || ""
    })),
    recall: recall.rows.map((x) => ({
      uhid: x.uhid, name: x.full_name, mobile: x.mobile || "", lastSeen: dateISO(x.last_seen)
    })),
    missed: missed.rows.map((x) => ({
      uhid: x.uhid || "", name: x.patient_name, mobile: x.mobile || "",
      date: dateISO(x.appt_date), reason: x.reason || ""
    }))
  };
};

module.exports = { actions, upsertPatient, addRegistration, queueLead };
