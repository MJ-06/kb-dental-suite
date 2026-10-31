// The clinic's existing forms as version 1 definitions, and the old rows linked
// in as submissions. Both are safe to run again: a form already seeded and a
// row already linked are skipped. Nothing in clinical_records or
// clinical_sheets is changed or moved.
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { RECORD_FORMS, RECORD_HEADINGS } from "../legacy/clinical-forms.js";
import type { FormField, FormSection } from "./definition.js";

/** Sheet-type -> the form that carries its tooth chart (clinical_sheets.sheet_type). */
const SHEET_FORMS: Record<string, string> = {
  "RCT": "RCT", "Implant Surgery": "Implant Surgery", "Implant Prosthetic": "Implant Prosthetic", "Crown Bridge": "Crown & Bridge"
};
const PATIENT_PARAMS = new Set(["uhid", "patientName", "age", "gender"]);
const PATIENT_HEADING = /^(UHID( No\.)?|Name( of (the )?[Pp]atient)?|Name the Patient|Patient Name|Age|Gender)$/;

export const slug = (tab: string): string =>
  tab.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const camel = (heading: string): string => {
  const w = heading.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ");
  const k = w.map((x, i) => (i ? x[0]!.toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join("");
  return /^[a-z]/.test(k) ? k.slice(0, 40) : `f${k}`.slice(0, 40);
};

/** Text unless the heading says otherwise. Old values are strings, so nothing is forced narrower than that. */
function fieldFor(key: string, heading: string): FormField {
  const label = heading;
  if (/\bDate\b/i.test(heading)) return { key, label, type: "date", legacy: heading };
  if (/^(Remarks|Notes|Clinical Notes|Report Findings|Findings Summary|Additional Information)$/.test(heading))
    return { key, label, type: "text", multiline: true, legacy: heading };
  return { key, label, type: "text", legacy: heading };
}

export interface SeedForm { key: string; title: string; legacyTab: string; sections: FormSection[]; sheetType?: string }

export function seedForms(): SeedForm[] {
  const out: SeedForm[] = [];
  const done = new Set<string>();
  for (const form of Object.values(RECORD_FORMS)) {
    const fields = form.fields.filter(([, param]) => !PATIENT_PARAMS.has(param)).map(([heading, param]) => fieldFor(param, heading));
    out.push({ key: slug(form.tab), title: form.tab, legacyTab: form.tab, sections: [{ id: "details", title: form.tab, fields }] });
    done.add(form.tab);
  }
  // The sheet-style forms (RCT, implants, crown and bridge) have headings only.
  for (const [tab, headings] of Object.entries(RECORD_HEADINGS)) {
    if (done.has(tab)) continue;
    const used = new Set<string>();
    const fields = headings.filter((h) => !PATIENT_HEADING.test(h)).map((h) => {
      let k = camel(h);
      while (used.has(k)) k += "2";
      used.add(k);
      return fieldFor(k, h);
    });
    const sheetType = Object.entries(SHEET_FORMS).find(([, t]) => t === tab)?.[0];
    const sections: FormSection[] = [{ id: "details", title: tab, fields }];
    if (sheetType) sections.push({ id: "teeth", title: "Tooth chart", fields: [{ key: "teeth", label: "Tooth chart", type: "tooth_chart" }] });
    out.push({ key: slug(tab), title: tab, legacyTab: tab, sections, sheetType });
  }
  return out;
}

/** Adds version 1 of every standard form this clinic does not have yet. Returns how many were added. */
export async function seedClinicForms(tx: Tx): Promise<number> {
  let added = 0;
  // The roles that could already read and write clinical records get the same
  // access to the carried-over forms; the clinic narrows it per form afterwards.
  const roleIds = async (perm: string) => (await sql<{ id: string }>`SELECT id FROM roles WHERE ${perm} = ANY(permissions)`.execute(tx)).rows.map((r) => r.id);
  const fill = await roleIds("clinical:write"), view = await roleIds("clinical:read");
  for (const f of seedForms()) {
    const r = await sql`
      INSERT INTO form_definitions (form_key, form_version, title, sections, legacy_tab, version_note, fill_role_ids, view_role_ids)
      VALUES (${f.key}, 1, ${f.title}, ${JSON.stringify(f.sections)}::jsonb, ${f.legacyTab}, 'Carried over from the original form',
              ${fill}::uuid[], ${view}::uuid[])
      ON CONFLICT (clinic_id, form_key, form_version) DO NOTHING`.execute(tx);
    added += Number(r.numAffectedRows ?? 0);
  }
  return added;
}

/**
 * Links every old record and tooth-chart sheet in as a final submission of
 * version 1 of its form. Headings the form does not know are kept under
 * `_legacy`, so nothing an import brought in is dropped. Returns rows linked.
 */
export async function backfillLegacy(tx: Tx): Promise<number> {
  await seedClinicForms(tx);
  const defs = new Map((await sql<{ id: string; form_key: string; legacy_tab: string; sections: FormSection[] }>`
    SELECT id, form_key, legacy_tab, sections FROM form_definitions WHERE form_version = 1`.execute(tx)).rows.map((d) => [d.legacy_tab, d]));
  let linked = 0;

  const records = await sql<{ id: string; tab_name: string; uhid: string; patient_id: string | null; fields: Record<string, unknown>; recorded_at: Date; created_by: string | null }>`
    SELECT r.id, r.tab_name, r.uhid, r.patient_id, r.fields, r.recorded_at, r.created_by FROM clinical_records r
     WHERE NOT EXISTS (SELECT 1 FROM form_submissions s WHERE s.legacy_source = 'record' AND s.legacy_record_id = r.id)`.execute(tx);
  for (const r of records.rows) {
    const def = defs.get(r.tab_name);
    if (!def) continue; // a tab with no form (none today) stays only in clinical_records
    const byHeading = new Map(def.sections.flatMap((s) => s.fields).map((f) => [f.legacy, f.key] as const));
    const values: Record<string, unknown> = {}, extra: Record<string, unknown> = {};
    for (const [heading, v] of Object.entries(r.fields)) {
      const key = byHeading.get(heading);
      if (key && v !== "" && v !== null) values[key] = v;
      else if (!key && !PATIENT_HEADING.test(heading) && v !== "" && v !== null) extra[heading] = v;
    }
    if (Object.keys(extra).length) values._legacy = extra;
    await insertLinked(tx, def.id, def.form_key, r, values, "record", r.recorded_at);
    linked++;
  }

  const sheets = await sql<{ id: string; sheet_type: string; uhid: string; patient_id: string | null; all_teeth: unknown; updated_at: Date; created_by: string | null }>`
    SELECT c.id, c.sheet_type, c.uhid, c.patient_id, c.all_teeth, c.updated_at, c.created_by FROM clinical_sheets c
     WHERE NOT EXISTS (SELECT 1 FROM form_submissions s WHERE s.legacy_source = 'sheet' AND s.legacy_record_id = c.id)`.execute(tx);
  for (const s of sheets.rows) {
    const tab = SHEET_FORMS[s.sheet_type];
    const def = tab ? defs.get(tab) : undefined;
    if (!def || s.all_teeth === null) continue;
    // The old chart's shape is its own; it is kept whole, and the new chart field starts empty.
    await insertLinked(tx, def.id, def.form_key, s, { _legacy: { toothChart: s.all_teeth } }, "sheet", s.updated_at);
    linked++;
  }
  return linked;
}

async function insertLinked(
  tx: Tx, formId: string, formKey: string,
  row: { id: string; uhid: string; patient_id: string | null; created_by: string | null },
  values: Record<string, unknown>, source: "record" | "sheet", at: Date
): Promise<void> {
  await sql`
    INSERT INTO form_submissions (form_id, form_key, form_version, uhid, patient_id, "values", status, submitted_by, submitted_at, legacy_record_id, legacy_source)
    VALUES (${formId}, ${formKey}, 1, ${row.uhid}, ${row.patient_id}, ${JSON.stringify(values)}::jsonb, 'final', ${row.created_by}, ${at}, ${row.id}, ${source})
    ON CONFLICT DO NOTHING`.execute(tx);
}
