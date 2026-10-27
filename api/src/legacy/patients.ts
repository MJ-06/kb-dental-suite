// Registration and patient look-ups, answering as the live Apps Script does.
//
// One patient is one row in `patients`; each time the history is taken is a
// row in `patient_registrations`, and "the patient's medical history" is the
// newest of those. A save that leaves a field blank never wipes what was
// recorded before: that was the sheet's rule, and it stays.
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { read, write, DeskError, type ActionTable, type Params } from "./types.js";
import { nz, str, uhidOf } from "./util.js";

// ── dates of birth ───────────────────────────────────────────────────────
// The screens send and expect dd/mm/yyyy.

export function dobToISO(v: unknown): string | null {
  const s = str(v);
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return valid(`${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? valid(`${m[1]}-${m[2]}-${m[3]}`) : null;
}
function valid(iso: string): string | null {
  const d = new Date(iso + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso && iso > "1900-01-01" ? iso : null;
}
export function dobOut(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** A list sent as JSON text, as an array, or as "a, b, c". */
export function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean);
  const s = str(v);
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const a = JSON.parse(s);
      if (Array.isArray(a)) return a.map((x) => str(x)).filter(Boolean);
    } catch { /* read as text below */ }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

const last10 = (v: unknown) => str(v).replace(/\D/g, "").slice(-10);

// ── one patient, with their newest history ───────────────────────────────

interface Row {
  id: string; uhid: string; full_name: string; gender: string | null; dob: string | null;
  mobile: string | null; mobile_2: string | null; whatsapp: string | null; email: string | null;
  blood_group: string | null; occupation: string | null; marital_status: string | null; address: string | null;
  emergency_name: string | null; emergency_relation: string | null; emergency_contact: string | null;
  referred_by: string | null; referred_by_type: string | null; patient_type: string; panel: string | null;
  panel_category: string | null; card_id: string | null; registered_on: Date; registration_status: string;
  conditions: string[] | null; allergies: string[] | null; medicines: string | null; habits: string | null;
  chief_complaint: string | null; pain_level: string | null; how_known: string | null; reg_id: string | null;
}

export async function findPatient(tx: Tx, uhid: string): Promise<Row | undefined> {
  const r = await sql<Row>`
    SELECT p.id, p.uhid, p.full_name, p.gender, p.date_of_birth::text AS dob, p.mobile, p.mobile_2, p.whatsapp,
           p.email::text AS email, p.blood_group, p.occupation, p.marital_status, p.address,
           p.emergency_name, p.emergency_relation, p.emergency_contact, p.referred_by, p.referred_by_type,
           p.patient_type, pn.name AS panel, p.panel_category, p.card_id, p.registered_on, p.registration_status,
           r.conditions, r.allergies, r.medicines, r.habits, r.chief_complaint, r.pain_level, r.how_known, r.id AS reg_id
      FROM patients p
      LEFT JOIN panels pn ON pn.id = p.panel_id
      LEFT JOIN LATERAL (
        SELECT * FROM patient_registrations x WHERE x.patient_id = p.id ORDER BY x.collected_at DESC LIMIT 1
      ) r ON true
     WHERE p.uhid = ${uhid} AND p.deleted_at IS NULL`.execute(tx);
  return r.rows[0];
}

async function panelId(tx: Tx, name: string): Promise<string> {
  const found = await sql<{ id: string }>`SELECT id FROM panels WHERE upper(name) = ${name.toUpperCase()} AND active`.execute(tx);
  // Panels are added in Master, by someone allowed to; the desk picks one.
  if (!found.rows[0]) throw new DeskError(`"${name}" is not one of the clinic's panels. Add it in Master first.`);
  return found.rows[0].id;
}

// The demographic fields: [screen's key, column].
const FIELDS: [string, string][] = [
  ["name", "full_name"], ["gender", "gender"], ["bloodGroup", "blood_group"], ["occupation", "occupation"],
  ["maritalStatus", "marital_status"], ["address", "address"], ["mobile", "mobile"], ["mobile2", "mobile_2"],
  ["whatsapp", "whatsapp"], ["email", "email"], ["emergencyName", "emergency_name"],
  ["emergencyContact", "emergency_contact"], ["emergencyRelation", "emergency_relation"],
  ["referredBy", "referred_by"], ["referredByType", "referred_by_type"]
];

/** Only the fields that were filled in. */
function demographics(p: Params): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, col] of FIELDS) {
    const v = nz(p[key]);
    if (v !== null) out[col] = v;
  }
  const dob = dobToISO(p.dob);
  if (dob) out.date_of_birth = dob;
  return out;
}

async function setPanel(tx: Tx, patientId: string, p: Params): Promise<void> {
  const type = str(p.patientType);
  const panel = str(p.panel);
  if (type === "Panel" || (panel && type !== "Normal")) {
    if (!panel) throw new DeskError("A panel patient needs the panel they belong to");
    await sql`UPDATE patients SET patient_type = 'Panel', panel_id = ${await panelId(tx, panel)},
                     panel_category = coalesce(${nz(p.panelCategory)}, panel_category),
                     card_id = coalesce(${nz(p.cardId)}, card_id)
               WHERE id = ${patientId}`.execute(tx);
  } else if (type === "Normal") {
    await sql`UPDATE patients SET patient_type = 'Normal', panel_id = NULL, panel_category = NULL, card_id = NULL
               WHERE id = ${patientId}`.execute(tx);
  }
}

/**
 * A new history row, carrying forward whatever this save left blank, so the
 * newest row is always the whole picture and older ones stay as they were.
 */
async function addHistory(tx: Tx, patientId: string, prev: Row | undefined, p: Params, status: "Quick" | "Complete", extra: { consent?: boolean; form?: Params } = {}) {
  const pick = <T>(given: T | null | undefined, before: T | null | undefined): T | null =>
    given !== null && given !== undefined && !(Array.isArray(given) && !given.length) ? given : before ?? null;
  const conditions = pick(listOf(p.conditions), prev?.conditions) ?? [];
  const allergies = pick(listOf(p.allergies), prev?.allergies) ?? [];
  await sql`INSERT INTO patient_registrations
              (patient_id, status, conditions, allergies, medicines, habits, chief_complaint, pain_level, how_known,
               referred_by, consent_given, form)
            VALUES (${patientId}, ${status}, ${conditions}, ${allergies},
                    ${pick(nz(p.medicines), prev?.medicines)}, ${pick(nz(p.habits), prev?.habits)},
                    ${pick(nz(p.complaint), prev?.chief_complaint)}, ${pick(nz(p.painLevel), prev?.pain_level)},
                    ${pick(nz(p.howKnown), prev?.how_known)}, ${nz(p.referredBy)}, ${extra.consent ?? false},
                    ${JSON.stringify(extra.form ?? p)}::jsonb)`.execute(tx);
}

const HAS_HISTORY = ["conditions", "allergies", "medicines", "habits", "complaint", "painLevel", "howKnown"];

export const patients: ActionTable = {
  // Takes a real UHID and holds it for this form. See uhid_reservations.
  getNextUHID: write("patients:write", async (_p, { tx }) => {
    const uhid = (await sql<{ u: string }>`SELECT next_uhid() AS u`.execute(tx)).rows[0]!.u;
    await sql`INSERT INTO uhid_reservations (uhid) VALUES (${uhid})`.execute(tx);
    return { success: true, uhid };
  }),

  checkDuplicate: read(async (p, { tx }) => {
    const name = str(p.name).toLowerCase().replace(/\s+/g, " ");
    const dob = dobToISO(p.dob);
    if (!name || !dob) return { success: true, duplicate: false };
    const r = await sql<{ uhid: string; full_name: string }>`
      SELECT uhid, full_name FROM patients
       WHERE deleted_at IS NULL AND date_of_birth = ${dob}
         AND regexp_replace(lower(trim(full_name)), '\\s+', ' ', 'g') = ${name}
       ORDER BY registered_on LIMIT 1`.execute(tx);
    const hit = r.rows[0];
    return hit ? { success: true, duplicate: true, existingUHID: hit.uhid, existingName: hit.full_name }
               : { success: true, duplicate: false };
  }, "patients:read"),

  saveRegistration: write("patients:write", async (p, { tx }) => {
    const mobile = str(p.mobile);
    if (mobile) await sql`DELETE FROM pending_registrations WHERE mobile = ${mobile}`.execute(tx);

    const uhid = uhidOf(p.uhid);
    if (!uhid) throw new DeskError("A patient cannot be saved without a UHID. Ask for a new one and try again.");
    const status: "Quick" | "Complete" = str(p.regStatus) === "Quick" ? "Quick" : "Complete";
    const prev = await findPatient(tx, uhid);
    const fields = demographics(p);
    let patientId: string;

    if (prev) {
      patientId = prev.id;
      if (Object.keys(fields).length) {
        await sql`UPDATE patients SET ${sql.join(Object.entries(fields).map(([c, v]) => sql`${sql.ref(c)} = ${v as string}`))}
                   WHERE id = ${patientId}`.execute(tx);
      }
      if (str(p.regStatus)) await sql`UPDATE patients SET registration_status = ${status} WHERE id = ${patientId}`.execute(tx);
    } else {
      // A new patient only under a UHID this server handed out and nobody used.
      const claimed = await sql`UPDATE uhid_reservations SET used_at = now()
                                 WHERE uhid = ${uhid} AND used_at IS NULL RETURNING id`.execute(tx);
      if (!claimed.rows.length) {
        throw new DeskError(`UHID ${uhid} was not issued by this system, or has already been used. Ask for a new UHID and try again.`);
      }
      if (!fields.full_name) throw new DeskError("Full name is required");
      const cols = { ...fields, uhid, registration_status: status };
      patientId = (await sql<{ id: string }>`
        INSERT INTO patients (${sql.join(Object.keys(cols).map((c) => sql.ref(c)))})
        VALUES (${sql.join(Object.values(cols).map((v) => v as string))}) RETURNING id`.execute(tx)).rows[0]!.id;
    }

    await setPanel(tx, patientId, p);
    if (!prev || HAS_HISTORY.some((k) => nz(p[k]) !== null)) await addHistory(tx, patientId, prev, p, status);
    return { success: true, uhid };
  }),

  getPending: read(async (_p, { tx }) => {
    const r = await sql<{ id: string; form: Params }>`SELECT id, form FROM pending_registrations ORDER BY submitted_at`.execute(tx);
    const rows = r.rows.map((x) => ({ ID: x.id, ...x.form }));
    return { success: true, pending: rows, rows };
  }, "patients:read"),

  getPatient: read(async (p, { tx }) => {
    const uhid = uhidOf(p.uhid);
    const x = await findPatient(tx, uhid);
    if (!x) return { success: false, error: `Patient not found: ${uhid}` };
    return { success: true, patient: {
      uhid: x.uhid, name: x.full_name, gender: x.gender ?? "", dob: dobOut(x.dob),
      mobile: x.mobile ?? "", mobile2: x.mobile_2 ?? "", whatsapp: x.whatsapp ?? "", email: x.email ?? "",
      bloodGroup: x.blood_group ?? "", occupation: x.occupation ?? "", maritalStatus: x.marital_status ?? "",
      address: x.address ?? "", emergencyName: x.emergency_name ?? "", emergencyRelation: x.emergency_relation ?? "",
      emergencyContact: x.emergency_contact ?? "", referredBy: x.referred_by ?? "",
      conditions: x.conditions ?? [], medicines: x.medicines ?? "", allergies: x.allergies ?? [],
      habits: x.habits ?? "", complaint: x.chief_complaint ?? "", painLevel: x.pain_level ?? "",
      registeredOn: x.registered_on.toISOString()
    } };
  }, "patients:read"),

  getAllPatients: read(async (_p, { tx }) => {
    const r = await sql<{ uhid: string; name: string; gender: string | null; dob: string | null; mobile: string | null;
      panel: string | null; panel_category: string | null; card_id: string | null; referred_by: string | null;
      referred_by_type: string | null; registered_on: Date }>`
      SELECT p.uhid, p.full_name AS name, p.gender, p.date_of_birth::text AS dob, p.mobile, pn.name AS panel,
             p.panel_category, p.card_id, p.referred_by, p.referred_by_type, p.registered_on
        FROM patients p LEFT JOIN panels pn ON pn.id = p.panel_id
       WHERE p.deleted_at IS NULL ORDER BY p.registered_on`.execute(tx);
    return { success: true, patients: r.rows.map((x) => ({
      uhid: x.uhid, name: x.name, gender: x.gender ?? "", dob: dobOut(x.dob), mobile: x.mobile ?? "",
      panel: x.panel ?? "", panelCategory: x.panel_category ?? "", cardId: x.card_id ?? "",
      referredBy: x.referred_by ?? "", referredByType: x.referred_by_type ?? "", registeredOn: x.registered_on.toISOString()
    })) };
  }, "patients:read"),

  searchPatients: read(async (p, { tx }) => {
    const q = str(p.query).toLowerCase();
    const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    const r = await sql<{ uhid: string; name: string; mobile: string | null; dob: string | null; gender: string | null }>`
      SELECT uhid, full_name AS name, mobile, date_of_birth::text AS dob, gender FROM patients
       WHERE deleted_at IS NULL
         AND (lower(uhid) LIKE ${like} OR lower(full_name) LIKE ${like} OR lower(coalesce(mobile, '')) LIKE ${like})
       ORDER BY registered_on LIMIT 20`.execute(tx);
    return { success: true, patients: r.rows.map((x) => ({
      uhid: x.uhid, name: x.name, mobile: x.mobile ?? "", dob: dobOut(x.dob), gender: x.gender ?? "" })) };
  }, "patients:read"),

  getTodaysBirthdays: read(async (_p, { tx }) => {
    const r = await sql<{ uhid: string; name: string; mobile: string | null; dob: string }>`
      SELECT uhid, full_name AS name, mobile, date_of_birth::text AS dob FROM patients
       WHERE deleted_at IS NULL AND date_of_birth IS NOT NULL
         AND to_char(date_of_birth, 'MM-DD') = to_char(clinic_today(), 'MM-DD')
       ORDER BY full_name`.execute(tx);
    return { success: true, patients: r.rows.map((x) => ({ uhid: x.uhid, name: x.name, mobile: x.mobile ?? "", dob: dobOut(x.dob) })) };
  }, "patients:read"),

  // The iPad form (register.html): finds the patient by UHID and the mobile
  // or WhatsApp number on file, and returns what is already recorded.
  patientLookup: read(async (p, { tx }) => {
    const x = await findPatient(tx, uhidOf(p.uhid));
    const entered = last10(p.mobile);
    if (!x || entered.length !== 10 || (entered !== last10(x.mobile) && entered !== last10(x.whatsapp))) {
      return { success: false, error: "We could not match those details." };
    }
    return { success: true, patient: {
      uhid: x.uhid, name: x.full_name, dob: dobOut(x.dob), mobile: x.mobile ?? "", gender: x.gender ?? "",
      bloodGroup: x.blood_group ?? "", occupation: x.occupation ?? "", maritalStatus: x.marital_status ?? "",
      address: x.address ?? "", whatsapp: x.whatsapp ?? "", email: x.email ?? "", referredBy: x.referred_by ?? "",
      emergencyName: x.emergency_name ?? "", emergencyRelation: x.emergency_relation ?? "",
      emergencyContact: x.emergency_contact ?? "",
      // The sheet held these lists as JSON text, and the form reads them so.
      conditions: x.conditions?.length ? JSON.stringify(x.conditions) : "",
      medicines: x.medicines ?? "",
      allergies: x.allergies?.length ? JSON.stringify(x.allergies) : "",
      complaint: x.chief_complaint ?? ""
    } };
  }, "patients:write"),

  patientCompleteRegistration: write("patients:write", async (p, { tx }) => {
    const x = await findPatient(tx, uhidOf(p.uhid));
    const entered = last10(p.mobile);
    if (!x || entered.length !== 10 || (entered !== last10(x.mobile) && entered !== last10(x.whatsapp))) {
      return { success: false, error: "We could not match those details." };
    }
    // The patient may complete their details, not change who they are.
    const { full_name: _n, mobile: _m, date_of_birth: _d, ...fields } = demographics(p);
    if (Object.keys(fields).length) {
      await sql`UPDATE patients SET ${sql.join(Object.entries(fields).map(([c, v]) => sql`${sql.ref(c)} = ${v as string}`))}
                 WHERE id = ${x.id}`.execute(tx);
    }
    await sql`UPDATE patients SET registration_status = 'Complete' WHERE id = ${x.id}`.execute(tx);
    await addHistory(tx, x.id, x, p, "Complete", { consent: !!str(p.consent) });
    return { success: true, uhid: x.uhid };
  })
};
