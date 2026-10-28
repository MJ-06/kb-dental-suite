// The clinical record: the flat forms (Pathology, Restoration, Prescriptions
// and the rest), the tooth-chart sheets, care plans, consents, treatment
// progress and the consent narrative writer, answering as the live Apps
// Script does.
import { sql } from "kysely";
import { callLimiter, complete, LlmError } from "../llm.js";
import { RECORD_FORMS, RECORD_HEADINGS, RECORD_TABS } from "./clinical-forms.js";
import { read, write, DeskError, type ActionTable, type Params } from "./types.js";
import { jsonOf, nz, str, uhidOf } from "./util.js";

/** A form value as the sheet held it: text, whatever the screen sent. */
function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v).trim();
}

const ISO_MS = sql`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** One save action per flat form, all alike: heading -> parameter, stored as a row on the form's tab. */
const formSaves: ActionTable = Object.fromEntries(
  Object.entries(RECORD_FORMS).map(([action, form]) => [
    action,
    write("clinical:write", async (p, { tx }) => {
      const uhid = uhidOf(p.uhid);
      if (!uhid) throw new DeskError("Choose the patient this record is for");
      const fields: Record<string, string> = {};
      for (const [heading, param] of form.fields) fields[heading] = cell(p[param]);
      const patient = (await sql<{ id: string }>`SELECT id FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows[0];
      await sql`
        INSERT INTO clinical_records (tab_name, uhid, patient_id, fields)
        VALUES (${form.tab}, ${uhid}, ${patient?.id ?? null}, ${JSON.stringify(fields)}::jsonb)`.execute(tx);
      return { success: true };
    })
  ])
);

// A narrative a doctor asks for costs money and sends the case details to the
// language model, so it is capped per person and says plainly when no key is set.
const soapAllowed = callLimiter(20, 10 * 60_000);

function soapPrompt(clinicName: string, p: Params): string {
  return [
    "You are an experienced dentist writing the 'PATIENT FINDINGS' section of an informed-consent form for the case below.",
    "",
    `Patient: ${str(p.name)} | Age/Gender: ${str(p.age)}`,
    `Chief Complaint: ${str(p.complaint)}`,
    `Clinical / Radiographic Findings: ${str(p.clinical)}`,
    `Tooth / Site: ${str(p.tooth)}`,
    `Medical History: ${str(p.medHx)}`,
    `Planned Treatment: ${str(p.treatment)}`,
    "",
    "WRITE IT AS A FLOWING CLINICAL NARRATIVE — a full 'scene of events' in natural, professional prose,",
    "the way a dentist would write it in the case sheet. Exactly TWO paragraphs, no headings, no labels,",
    "NO 'S:/O:/A:/P:' letters, no bullet points, no separate one-line sentences.",
    "",
    "Paragraph 1 (the presentation): the patient's name, age/sex, that they reported to " + clinicName + ",",
    "the chief complaint and its character — duration, what aggravates/relieves it, radiation, associated",
    "sensitivity — woven into one continuous story.",
    "",
    "Paragraph 2 (the examination & plan): what was found on clinical and X-ray (IOPA/RVG) examination,",
    "the affected tooth described in words and by number, percussion/tenderness, radiographic signs, the",
    "resulting diagnosis, and the treatment advised (including any later steps such as post & core / crown),",
    "ending with a line that the patient was made aware of the procedure through audio-visual aids and models.",
    "",
    "Write in third person, past tense, specific and detailed. Do NOT invent facts that contradict the inputs;",
    "if a detail is missing, phrase it naturally without placeholders. Example of the required STYLE (do not copy the wording):",
    `"Mr. Ramesh Kumar, 45/Male, reported to ${clinicName} with a complaint of severe throbbing pain in the lower right back tooth region since 8 days. The pain aggravated on biting and hot foods with slight relief on cold water, radiating to the right ear and lower jaw, and was associated with sensitivity to sweet and hot foodstuffs.\\n\\nOn clinical and X-ray (IOPA) examination, a deep carious lesion was found in the lower right first molar — the sixth tooth from the centre (Tooth No. 46) — extending to the tooth's nerve (pulp). The tooth was tender to percussion, and the X-ray confirmed deep decay with periapical radiolucency (widening of the PDL) at the root end, indicating infection. Root canal treatment was advised, which will subsequently need post & core restoration and a PFM crown. The patient was made aware of the procedure through audio-visual aids and physical models."`,
    "",
    "Return ONLY the two-paragraph narrative, nothing else."
  ].join("\n");
}

export const clinical: ActionTable = {
  ...formSaves,

  getClinicalRecords: read(async (p, { tx }) => {
    const tab = str(p.tabName), uhid = uhidOf(p.uhid);
    if (!tab || !uhid) return { success: false, error: "tabName and uhid required" };
    if (!RECORD_TABS.has(tab)) return { success: false, error: `Unknown record type: ${tab}` };
    const r = await sql<{ row_index: number; ts: string; fields: Record<string, unknown>; total: number }>`
      SELECT * FROM (
        SELECT (row_number() OVER (ORDER BY recorded_at, id) + 1)::int AS row_index, upper(uhid) AS u,
               to_char(recorded_at AT TIME ZONE 'UTC', ${ISO_MS}) AS ts, fields, count(*) OVER ()::int AS total
          FROM clinical_records WHERE tab_name = ${tab}) x
       WHERE u = ${uhid} ORDER BY row_index`.execute(tx);
    if (!r.rows.length) {
      const any = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM clinical_records WHERE tab_name = ${tab}`.execute(tx)).rows[0]!.n;
      return any ? { success: true, records: [], headers: ["Timestamp", ...(RECORD_HEADINGS[tab] ?? [])] } : { success: true, records: [] };
    }
    const headers = ["Timestamp", ...(RECORD_HEADINGS[tab] ?? [])];
    const records = r.rows.map((row) => {
      const rec: Record<string, unknown> = { _rowIndex: row.row_index, Timestamp: row.ts };
      for (const [k, v] of Object.entries(row.fields)) {
        if (k !== "Timestamp") rec[k] = cell(v);
        if (!headers.includes(k)) headers.push(k);
      }
      for (const h of headers) if (!(h in rec)) rec[h] = "";
      return rec;
    });
    return { success: true, records, headers };
  }, "clinical:read"),

  getClinicalSheets: read(async (p, { tx }) => {
    const uhid = uhidOf(p.uhid), type = str(p.sheetType);
    const r = await sql<{ all_teeth: unknown; sheet_type: string; saved: string }>`
      SELECT all_teeth, sheet_type, to_char(updated_at AT TIME ZONE 'UTC', ${ISO_MS}) AS saved
        FROM clinical_sheets
       WHERE upper(uhid) = ${uhid} AND (${type} = '' OR sheet_type = ${type})
       ORDER BY updated_at DESC LIMIT 1`.execute(tx);
    const row = r.rows[0];
    return row ? { success: true, allTeeth: row.all_teeth, sheetType: row.sheet_type, savedAt: row.saved }
               : { success: true, allTeeth: null };
  }, "clinical:read"),

  saveClinicalSheets: write("clinical:write", async (p, { tx }) => {
    const uhid = uhidOf(p.uhid);
    if (!uhid) throw new DeskError("uhid required");
    const teeth = jsonOf(p.allTeeth, "tooth chart");
    const patient = (await sql<{ id: string }>`SELECT id FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows[0];
    await sql`
      INSERT INTO clinical_sheets (uhid, patient_id, patient_name, sheet_type, all_teeth)
      VALUES (${uhid}, ${patient?.id ?? null}, ${nz(p.patientName)}, ${str(p.sheetType)}, ${teeth}::jsonb)
      ON CONFLICT (clinic_id, uhid, sheet_type) DO UPDATE
        SET patient_name = EXCLUDED.patient_name, all_teeth = EXCLUDED.all_teeth`.execute(tx);
    return { success: true };
  }),

  getCarePlan: read(async (p, { tx }) => {
    const r = await sql<{ page1: unknown; page2: unknown; page3: unknown; page4: unknown; saved: string }>`
      SELECT page1, page2, page3, page4, to_char(updated_at AT TIME ZONE 'UTC', ${ISO_MS}) AS saved
        FROM care_plans WHERE upper(uhid) = ${uhidOf(p.uhid)}`.execute(tx);
    const row = r.rows[0];
    return row ? { success: true, page1: row.page1, page2: row.page2, page3: row.page3, page4: row.page4, savedAt: row.saved }
               : { success: true, page1: null, page2: null, page3: null, page4: null };
  }, "clinical:read"),

  saveCarePlan: write("clinical:write", async (p, { tx }) => {
    const uhid = uhidOf(p.uhid);
    if (!uhid) throw new DeskError("uhid required");
    const pages = [1, 2, 3, 4].map((n) => jsonOf(p[`page${n}`], `care plan page ${n}`));
    const patient = (await sql<{ id: string }>`SELECT id FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows[0];
    await sql`
      INSERT INTO care_plans (uhid, patient_id, patient_name, plan_date, page1, page2, page3, page4)
      VALUES (${uhid}, ${patient?.id ?? null}, ${nz(p.patientName)}, ${nz(p.date)},
              ${pages[0]}::jsonb, ${pages[1]}::jsonb, ${pages[2]}::jsonb, ${pages[3]}::jsonb)
      ON CONFLICT (clinic_id, uhid) DO UPDATE
        SET patient_name = EXCLUDED.patient_name, plan_date = EXCLUDED.plan_date,
            page1 = EXCLUDED.page1, page2 = EXCLUDED.page2, page3 = EXCLUDED.page3, page4 = EXCLUDED.page4`.execute(tx);
    return { success: true };
  }),

  saveConsent: write("clinical:write", async (p, { tx }) => {
    const uhid = uhidOf(p.uhid);
    if (!uhid) throw new DeskError("uhid required");
    const patient = (await sql<{ id: string }>`SELECT id FROM patients WHERE uhid = ${uhid}`.execute(tx)).rows[0];
    await sql`
      INSERT INTO consents (uhid, patient_id, patient_name, consent_date, procedure, language, soap, med_history, fee, pay_terms, extra_proc)
      VALUES (${uhid}, ${patient?.id ?? null}, ${nz(p.patientName)}, ${nz(p.date)}, ${nz(p.procedure)}, ${nz(p.language)},
              ${nz(p.soap)}, ${nz(p.medHistory)}, ${nz(p.fee)}, ${nz(p.payTerms)}, ${nz(p.extraProc)})`.execute(tx);
    return { success: true };
  }),

  // What the day's register says was done, for the treatment-progress table.
  getTreatmentProgress: read(async (p, { tx }) => {
    const r = await sql<{ sno: number | null; date: string; tooth: string | null; proc: string | null; work: string | null; doctor: string | null; mode: string | null }>`
      SELECT serial_no AS sno, visit_date::text AS date, tooth_no AS tooth, procedure_done AS proc,
             work_done AS work, operating_doctor AS doctor, mode_of_payment AS mode
        FROM daily_register WHERE upper(uhid) = ${uhidOf(p.uhid)}
       ORDER BY visit_date, created_at`.execute(tx);
    return {
      success: true,
      entries: r.rows.map((e) => ({
        sno: e.sno === null ? "" : String(e.sno), date: e.date, toothNo: e.tooth ?? "",
        treatmentRendered: e.proc ?? "", clinicalNotes: e.work ?? "", workDone: e.work ?? "",
        doctor: e.doctor ?? "", paymentMode: e.mode ?? "", amountReceived: "", sigDataUrl: ""
      }))
    };
  }, "clinical:read"),

  generateSOAPNotes: write("clinical:write", async (p, { tx, actor }) => {
    if (!process.env.ANTHROPIC_API_KEY) return { success: false, error: "ANTHROPIC_API_KEY is not set on the server" };
    if (!soapAllowed(actor.userId)) return { success: false, error: "Too many narratives requested. Wait a few minutes and try again." };
    const clinic = (await sql<{ name: string }>`SELECT name FROM clinic_profile()`.execute(tx)).rows[0]?.name ?? "the clinic";
    try {
      const soap = await complete({
        model: process.env.SOAP_MODEL ?? "claude-sonnet-5-5", maxTokens: 700,
        messages: [{ role: "user", content: soapPrompt(clinic, p) }]
      });
      return { success: true, soap };
    } catch (e) {
      if (e instanceof LlmError) return { success: false, error: e.message };
      throw e;
    }
  })
};
