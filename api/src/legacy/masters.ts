// The Master screen's lists and the clinic's settings, answering exactly as
// the live Apps Script does (apps-script/out/Code.gs). The screens save a
// whole list at a time; here that becomes, in one transaction:
//   - named lists: update or add each entry, deactivate the ones left out
//     (history still points at an old doctor or fee, so nothing is deleted)
//   - plain value lists: replace the rows
import { sql } from "kysely";
import { hashPassword, verifyPassword } from "../auth/password.js";
import type { Tx } from "../db/index.js";
import { read, write, DeskError, type ActionTable, type Params } from "./types.js";
import { hhmm, isoDay, num, nz, parseList, parseObject, str } from "./util.js";

// ── settings ─────────────────────────────────────────────────────────────

export async function getSetting<T>(tx: Tx, key: string): Promise<T | null> {
  const r = await sql<{ value: T }>`SELECT value FROM clinic_settings WHERE key = ${key}`.execute(tx);
  return r.rows[0]?.value ?? null;
}

export async function putSetting(tx: Tx, key: string, value: unknown): Promise<void> {
  await sql`INSERT INTO clinic_settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
            ON CONFLICT (clinic_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(tx);
}

// ── plain value lists ────────────────────────────────────────────────────

async function readValues(tx: Tx, list: string): Promise<string[]> {
  const r = await sql<{ value: string }>`SELECT value FROM pick_lists WHERE list_name = ${list} ORDER BY sort_order`.execute(tx);
  return r.rows.map((x) => x.value);
}

async function writeValues(tx: Tx, list: string, entries: { value: string; data?: unknown }[]): Promise<void> {
  await sql`DELETE FROM pick_lists WHERE list_name = ${list}`.execute(tx);
  const seen = new Set<string>();
  let i = 0;
  for (const e of entries) {
    // The same entry twice in one list is a typo, not two entries.
    if (!e.value || seen.has(e.value)) continue;
    seen.add(e.value);
    await sql`INSERT INTO pick_lists (list_name, value, data, sort_order)
              VALUES (${list}, ${e.value}, ${e.data === undefined ? null : JSON.stringify(e.data)}::jsonb, ${i++})`.execute(tx);
  }
}

// [action suffix, list name, the key the screen reads and sends, defaults]
const VALUE_LISTS: [string, string, string, string[]][] = [
  ["ExpenseCategoriesList", "expense_category", "categories", []],
  ["DocumentCategoriesList", "document_category", "categories", [
    "X-Ray / RVG", "OPG", "CBCT", "Blood Reports", "Clinical Photograph",
    "Digital Scan", "Prescription (Scanned PDF)", "Referral Letter", "Consent Form (Scanned PDF)"]],
  ["MedicineDosagesList", "medicine_dosage", "dosages", []],
  ["MedicineFrequenciesList", "medicine_frequency", "frequencies", []],
  ["MedicineDurationsList", "medicine_duration", "durations", []],
  ["MedicineNotesList", "medicine_note", "medNotes", []],
  ["PaymentModesList", "payment_mode", "modes", []]
];

// Lists of {situation, text, category}.
const SITUATION_LISTS: [string, string, string, string][] = [
  ["MedicineInstructionsList", "medicine_instruction", "instructions", "medicine instructions"],
  ["ClinicalNoteTemplates", "clinical_note_template", "templates", "clinical note templates"]
];

// ── named lists ──────────────────────────────────────────────────────────

/** Upserts by name (case-insensitive), keeps order, deactivates the rest. */
async function replaceNamed(tx: Tx, table: "doctors" | "staff" | "chairs" | "panels" | "treatments" | "medicines" | "implant_brands" | "appointment_reasons",
  rows: { name: string; cols: Record<string, unknown> }[]): Promise<void> {
  const t = sql.table(table);
  await sql`UPDATE ${t} SET active = false WHERE active`.execute(tx);
  const seen = new Set<string>();
  let i = 0;
  for (const r of rows) {
    const key = r.name.toLowerCase();
    if (!r.name || seen.has(key)) continue;
    seen.add(key);
    const cols: Record<string, unknown> = { ...r.cols, ...(table === "doctors" || table === "staff" || table === "chairs" || table === "panels" ? {} : { sort_order: i }) };
    const names = Object.keys(cols);
    const existing = await sql<{ id: string }>`SELECT id FROM ${t} WHERE lower(name) = ${key}`.execute(tx);
    if (existing.rows[0]) {
      const sets = sql.join([sql`name = ${r.name}`, sql`active = true`,
        ...names.map((c) => sql`${sql.ref(c)} = ${cols[c] as never}`)]);
      await sql`UPDATE ${t} SET ${sets} WHERE id = ${existing.rows[0].id}`.execute(tx);
    } else {
      await sql`INSERT INTO ${t} (${sql.join([sql.ref("name"), ...names.map((c) => sql.ref(c))])})
                VALUES (${sql.join([r.name, ...names.map((c) => cols[c] as never)])})`.execute(tx);
    }
    i++;
  }
}

function person(row: { name: string; phone: string | null; email: string | null; role: string | null }) {
  return { name: row.name, phone: row.phone ?? "", email: row.email ?? "", role: row.role ?? "" };
}

const toPeople = (raw: unknown, label: string) => parseList(raw, label).map((d) => {
  const o = (d ?? {}) as Record<string, unknown>;
  return { name: str(o.name), cols: { phone: nz(o.phone), email: nz(o.email), role: nz(o.role) } };
});

// ── screen passwords (Finance, Master, Reports) ──────────────────────────
// Kept because today's screens ask for them. They are now hashed, and the
// role check on every action is what actually protects the data.

function verifyScreenPassword(key: string) {
  return read(async (p, { tx }) => {
    const stored = await getSetting<string>(tx, key);
    if (!stored) return { success: true, correct: true }; // none set yet: do not lock the clinic out
    return { success: true, correct: await verifyPassword(str(p.password), stored) };
  });
}

export const masters: ActionTable = {};

for (const [suffix, list, key, defaults] of VALUE_LISTS) {
  masters[`get${suffix}`] = read(async (_p, { tx }) => {
    const values = await readValues(tx, list);
    return { success: true, [key]: values.length || !defaults.length ? values : defaults };
  });
  masters[`save${suffix}`] = write("masters:write", async (p, { tx }) => {
    const arr = parseList(p[key], suffix.replace(/List$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
    await writeValues(tx, list, arr.map((v) => ({ value: str(v) })));
    return { success: true };
  });
}

for (const [suffix, list, key, label] of SITUATION_LISTS) {
  masters[`get${suffix}`] = read(async (_p, { tx }) => {
    const r = await sql<{ value: string; data: { text?: string; category?: string } | null }>`
      SELECT value, data FROM pick_lists WHERE list_name = ${list} ORDER BY sort_order`.execute(tx);
    return { success: true, [key]: r.rows.map((x) => ({
      situation: x.value, text: x.data?.text ?? x.value, category: x.data?.category ?? "" })) };
  });
  masters[`save${suffix}`] = write("masters:write", async (p, { tx }) => {
    const arr = parseList(p[key], label);
    await writeValues(tx, list, arr.map((v) => typeof v === "string"
      ? { value: v.trim(), data: { text: v.trim(), category: "" } }
      : { value: str((v as Params).situation), data: { text: str((v as Params).text), category: str((v as Params).category) } }));
    return { success: true };
  });
}

Object.assign(masters, {
  getDoctorDetailsList: read(async (_p, { tx }) => {
    const r = await sql<{ name: string; phone: string; email: string; role: string }>`
      SELECT name, phone, email, role FROM doctors WHERE active ORDER BY created_at`.execute(tx);
    return { success: true, doctors: r.rows.map(person) };
  }),
  saveDoctorDetailsList: write("masters:write", async (p, { tx }) => {
    await replaceNamed(tx, "doctors", toPeople(p.doctors, "doctor details"));
    return { success: true };
  }),

  getEmployeesList: read(async (_p, { tx }) => {
    const r = await sql<{ name: string; phone: string; email: string; role: string }>`
      SELECT name, phone, email, role FROM staff WHERE active ORDER BY created_at`.execute(tx);
    return { success: true, employees: r.rows.map(person) };
  }),
  saveEmployeesList: write("masters:write", async (p, { tx }) => {
    await replaceNamed(tx, "staff", toPeople(p.employees, "employees"));
    return { success: true };
  }),

  getChairsList: read(async (_p, { tx }) => {
    const r = await sql<{ name: string }>`SELECT name FROM chairs WHERE active ORDER BY created_at`.execute(tx);
    return { success: true, chairs: r.rows.map((x) => x.name) };
  }),
  saveChairsList: write("masters:write", async (p, { tx }) => {
    await replaceNamed(tx, "chairs", parseList(p.chairs, "chairs").map((c) => ({ name: str(c), cols: {} })));
    return { success: true };
  }),

  getPanelsList: read(async (_p, { tx }) => {
    const r = await sql<{ name: string }>`SELECT name FROM panels WHERE active ORDER BY created_at`.execute(tx);
    return { success: true, panels: r.rows.map((x) => x.name) };
  }),
  savePanelsList: write("masters:write", async (p, { tx }) => {
    await replaceNamed(tx, "panels", parseList(p.panels, "panels").map((c) => ({ name: str(c), cols: {} })));
    return { success: true };
  }),

  getTreatmentsMaster: read(async (_p, { tx }) => {
    const r = await sql<{ name: string; fee: string | null; department: string | null }>`
      SELECT name, fee, department FROM treatments WHERE active ORDER BY sort_order`.execute(tx);
    return { success: true, treatments: r.rows.map((x) => ({ name: x.name, fee: x.fee === null ? "" : Number(x.fee), department: x.department ?? "" })) };
  }),
  saveTreatmentsMaster: write("masters:write", async (p, { tx }) => {
    await replaceNamed(tx, "treatments", parseList(p.treatments, "treatments master").map((t) => {
      const o = (t ?? {}) as Params;
      return { name: str(o.name), cols: { fee: num(o.fee), department: nz(o.department) } };
    }));
    return { success: true };
  }),

  getMedicinesMaster: read(async (_p, { tx }) => {
    const r = await sql<{ name: string; d: string | null; f: string | null }>`
      SELECT name, default_dosage AS d, default_frequency AS f FROM medicines WHERE active ORDER BY sort_order`.execute(tx);
    return { success: true, medicines: r.rows.map((x) => ({ name: x.name, dosage: x.d ?? "", frequency: x.f ?? "" })) };
  }),
  saveMedicinesMaster: write("masters:write", async (p, { tx }) => {
    await replaceNamed(tx, "medicines", parseList(p.medicines, "medicines master").map((m) => {
      const o = (m ?? {}) as Params;
      return { name: str(o.name), cols: { default_dosage: nz(o.dosage), default_frequency: nz(o.frequency) } };
    }));
    return { success: true };
  }),

  getImplantBrandsList: read(async (_p, { tx }) => {
    const r = await sql<{ name: string; sizes: string[] }>`SELECT name, sizes FROM implant_brands WHERE active ORDER BY sort_order`.execute(tx);
    // The screen edits sizes as one comma-separated string.
    return { success: true, brands: r.rows.map((x) => ({ name: x.name, sizes: x.sizes.join(", ") })) };
  }),
  saveImplantBrandsList: write("masters:write", async (p, { tx }) => {
    await replaceNamed(tx, "implant_brands", parseList(p.brands, "implant brands").map((b) => {
      const o = (b ?? {}) as Params;
      return { name: str(o.name), cols: { sizes: str(o.sizes).split(",").map((s) => s.trim()).filter(Boolean) } };
    }));
    return { success: true };
  }),

  getReasonsList: read(async (_p, { tx }) => {
    const r = await sql<{ name: string; steps: string[] }>`SELECT name, steps FROM appointment_reasons WHERE active ORDER BY sort_order`.execute(tx);
    let rows = r.rows;
    if (!rows.length) rows = DEFAULT_APPT_REASONS.map((name) => ({ name, steps: [] }));
    // steps travel as one comma-separated string per reason, as in the sheet.
    return { success: true, reasons: rows.map((x) => x.name), reasonSteps: rows.map((x) => ({ name: x.name, steps: x.steps.join(", ") })) };
  }),
  saveReasonsList: write("masters:write", async (p, { tx }) => {
    await replaceNamed(tx, "appointment_reasons", parseList(p.reasons, "appointment reasons").map((r) =>
      r && typeof r === "object"
        ? { name: str((r as Params).name), cols: { steps: str((r as Params).steps).split(",").map((s) => s.trim()).filter(Boolean) } }
        : { name: str(r), cols: { steps: [] } }));
    return { success: true };
  }),

  getPanelRates: read(async (p, { tx }) => {
    const want = str(p.panel).toUpperCase();
    const r = await sql<{ panel: string; code: string; procedure: string | null; rate: string | null; classification: string }>`
      SELECT pn.name AS panel, pr.code, pr.procedure, pr.rate, pr.classification
        FROM panel_rates pr JOIN panels pn ON pn.id = pr.panel_id
       WHERE ${want} = '' OR upper(pn.name) = ${want}
       ORDER BY pn.name, pr.sort_order`.execute(tx);
    return { success: true, rates: r.rows.map((x) => ({
      panel: x.panel, code: x.code, procedure: x.procedure ?? "", rate: x.rate === null ? "" : Number(x.rate), classification: x.classification })) };
  }),
  savePanelRates: write("masters:write", async (p, { tx }) => {
    const panel = str(p.panel);
    if (!panel) return { success: false, error: "No panel given" };
    const arr = parseList(p.rates, "rate card");
    let pid = (await sql<{ id: string }>`SELECT id FROM panels WHERE upper(name) = ${panel.toUpperCase()}`.execute(tx)).rows[0]?.id;
    pid ??= (await sql<{ id: string }>`INSERT INTO panels (name) VALUES (${panel}) RETURNING id`.execute(tx)).rows[0]!.id;
    const others = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM panel_rates WHERE panel_id <> ${pid}`.execute(tx)).rows[0]!.n);
    await sql`DELETE FROM panel_rates WHERE panel_id = ${pid}`.execute(tx);
    let saved = 0;
    for (const raw of arr) {
      const r = (raw ?? {}) as Params;
      const code = str(r.code);
      if (!code) continue; // a rate with no code cannot be claimed
      await sql`INSERT INTO panel_rates (panel_id, code, procedure, rate, classification, sort_order)
                VALUES (${pid}, ${code}, ${nz(r.procedure)}, ${num(r.rate)}, ${str(r.classification)}, ${saved})`.execute(tx);
      saved++;
    }
    return { success: true, saved, kept: others };
  }),

  getClinicProfile: read(async (_p, { tx }) => ({ success: true, profile: (await getSetting(tx, "clinic_profile")) ?? {} })),
  saveClinicProfile: write("masters:write", async (p, { tx }) => {
    let profile: Record<string, unknown>;
    try { profile = parseObject(p.profile, "clinic profile"); } catch {
      return { success: false, error: "the clinic profile never reached the sheet" };
    }
    await putSetting(tx, "clinic_profile", profile);
    return { success: true };
  }),

  getClinicTimings: read(async (_p, { tx }) => {
    const t = (await getSetting<{ open?: string; close?: string; slotMinutes?: number }>(tx, "clinic_timings")) ?? {};
    return { success: true, open: t.open || "09:00", close: t.close || "19:00", slotMinutes: t.slotMinutes && t.slotMinutes > 0 ? t.slotMinutes : 30 };
  }),
  saveClinicTimings: write("masters:write", async (p, { tx }) => {
    const open = hhmm(p.open), close = hhmm(p.close);
    const step = parseInt(str(p.slotMinutes), 10);
    if (!open || !close) return { success: false, error: "the opening and closing times must read as HH:MM" };
    if (!(step > 0)) return { success: false, error: "a slot must be at least one minute long" };
    if (close <= open) return { success: false, error: "the clinic cannot close before it opens" };
    await putSetting(tx, "clinic_timings", { open, close, slotMinutes: step });
    return { success: true };
  }),

  getWorkingDays: read(async (_p, { tx }) => {
    const weekOff = ((await getSetting<number[]>(tx, "week_off")) ?? []).slice().sort((a, b) => a - b);
    const h = await sql<{ d: string; name: string }>`SELECT holiday_date::text AS d, name FROM holidays ORDER BY holiday_date`.execute(tx);
    return { success: true, weekOff, holidays: h.rows.map((x) => ({ date: x.d, name: x.name })) };
  }),
  saveWorkingDays: write("masters:write", async (p, { tx }) => {
    const weekOff = parseList(p.weekOff, "week off days").map((n) => parseInt(str(n), 10)).filter((n) => n >= 0 && n <= 6);
    const holidays = parseList(p.holidays, "holiday list");
    await putSetting(tx, "week_off", [...new Set(weekOff)]);
    await sql`DELETE FROM holidays`.execute(tx);
    for (const raw of holidays) {
      const h = (raw ?? {}) as Params;
      const date = isoDay(h.date);
      if (!date) continue;
      await sql`INSERT INTO holidays (holiday_date, name) VALUES (${date}, ${str(h.name)})
                ON CONFLICT (clinic_id, holiday_date) DO UPDATE SET name = EXCLUDED.name`.execute(tx);
    }
    return { success: true };
  }),

  getSignatures: read(async (_p, { tx }) => {
    const r = await sql<{ owner_name: string; image_data: string }>`SELECT owner_name, image_data FROM signatures`.execute(tx);
    return { success: true, signatures: Object.fromEntries(r.rows.map((x) => [x.owner_name, x.image_data])) };
  }),
  saveSignature: write("clinical:write", async (p, { tx }) => {
    const doctor = str(p.doctor);
    const data = str(p.signatureDataUrl);
    // PNG, JPEG or WebP as base64, nothing else: an SVG or a value with a
    // quote in it could carry script into the pages that print signatures.
    if (!SIGNATURE_DATA_URL.test(data)) throw new DeskError("The signature did not arrive as an image");
    await sql`INSERT INTO signatures (owner_name, image_data) VALUES (${doctor}, ${data})
              ON CONFLICT (clinic_id, owner_name) DO UPDATE SET image_data = EXCLUDED.image_data`.execute(tx);
    return { success: true };
  }),

  // What the old backend said about its own setup. The Finance sheet id is
  // meaningless here; the *Set flags still drive the password screens.
  getSettings: read(async (_p, { tx }) => {
    const r = await sql<{ key: string }>`SELECT key FROM clinic_settings WHERE key LIKE '%password%'`.execute(tx);
    const set = new Set(r.rows.map((x) => x.key));
    return {
      success: true, financeSheetId: "",
      financePasswordSet: set.has("finance_password"), masterPasswordSet: set.has("master_password"),
      reportsPassword1Set: set.has("reports_password_1"), reportsPassword2Set: set.has("reports_password_2")
    };
  }),
  saveSettings: write("masters:write", async () =>
    ({ success: false, error: "The finance sheet is no longer used: finance lives in the clinic's database now." }))
});

const SIGNATURE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const DEFAULT_APPT_REASONS = [
  "Consultation", "Follow Up", "RCT", "Crown Cementation", "Scaling / Cleaning",
  "Extraction", "Implant Surgery", "Implant Prosthesis", "Orthodontics",
  "Restoration", "Denture", "Whitening", "Review", "Other"
];

// Screen passwords: stored hashed, under the same flags getSettings reports.
for (const [name, key] of [["Finance", "finance_password"], ["Master", "master_password"]] as const) {
  masters[`save${name}Password`] = write("masters:write", async (p, ctx) => {
    const pw = str(p.password);
    if (!pw) return { success: false, error: "Password required" };
    await putSetting(ctx.tx, key, await hashPassword(pw));
    return { success: true };
  });
  masters[`verify${name}Password`] = verifyScreenPassword(key);
}

// Reports has two independent passwords; either one opens it.
masters.saveReportsPassword = write("masters:write", async (p, { tx }) => {
  const slot = str(p.slot);
  if (slot !== "1" && slot !== "2") return { success: false, error: "Invalid password slot" };
  const pw = str(p.password);
  if (!pw) return { success: false, error: "Password required" };
  await putSetting(tx, `reports_password_${slot}`, await hashPassword(pw));
  return { success: true };
});
masters.verifyReportsPassword = read(async (p, { tx }) => {
  const a = await getSetting<string>(tx, "reports_password_1");
  const b = await getSetting<string>(tx, "reports_password_2");
  if (!a && !b) return { success: true, correct: true };
  const entered = str(p.password);
  const correct = (!!a && await verifyPassword(entered, a)) || (!!b && await verifyPassword(entered, b));
  return { success: true, correct };
});
