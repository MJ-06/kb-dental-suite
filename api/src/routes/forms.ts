// Form definitions and what is filled into them. Same gate as every clinic
// route (cookie -> session -> clinic), plus the form's own access list.
//
//   GET  /api/v1/forms                          the forms this user may fill or view
//   GET  /api/v1/forms/:key                     the current version
//   POST /api/v1/forms                          publish a new version (masters:write)
//   GET  /api/v1/forms/:key/submissions?uhid=   a patient's records of this form
//   POST /api/v1/forms/:key/submissions         save a draft or a final record
//   GET/PUT /api/v1/forms/settings/phone-session
import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { sql } from "kysely";
import type { AppOptions } from "../app.js";
import { can } from "../auth/permissions.js";
import type { Actor, Tx } from "../db/index.js";
import { HttpError, notFound } from "../http/errors.js";
import { asActor } from "../http/context.js";
import { FormError, validateDefinition, validateValues, type FormSection } from "../forms/definition.js";
import { seedClinicForms } from "../forms/seed.js";
import { RECORD_HEADINGS } from "../legacy/clinical-forms.js";

interface DefRow {
  id: string; form_key: string; form_version: number; title: string; status: string; sections: FormSection[];
  fill_role_ids: string[]; view_role_ids: string[]; legacy_tab: string | null; version_note: string | null;
}

/**
 * Who may fill or view a form: an administrator (who can manage roles), or a
 * person whose role id is on the form's list. Filling also needs the clinical
 * write permission, and viewing the read permission, so a role on the list
 * cannot get past what the role page says it may do.
 */
export function formAccess(actor: Actor, def: Pick<DefRow, "fill_role_ids" | "view_role_ids">, mode: "fill" | "view"): boolean {
  if (can(actor, "roles:manage")) return true;
  if (!can(actor, mode === "fill" ? "clinical:write" : "clinical:read")) return false;
  const ids = mode === "fill" ? def.fill_role_ids : def.view_role_ids;
  return ids.includes(actor.roleId) || (mode === "view" && def.fill_role_ids.includes(actor.roleId));
}

const DEF_COLS = sql`id, form_key, form_version, title, status, sections, fill_role_ids, view_role_ids, legacy_tab, version_note`;

async function currentDefinition(tx: Tx, key: string): Promise<DefRow> {
  const r = await sql<DefRow>`
    SELECT ${DEF_COLS} FROM form_definitions WHERE form_key = ${key} AND status = 'published'
     ORDER BY form_version DESC LIMIT 1`.execute(tx);
  if (!r.rows[0]) throw notFound("Form");
  return r.rows[0];
}

const asHttp = <T>(fn: () => T): T => {
  try { return fn(); } catch (e) { if (e instanceof FormError) throw new HttpError(422, "invalid_form", e.message); throw e; }
};

const publicDef = (d: DefRow, actor: Actor) => ({
  key: d.form_key, version: d.form_version, title: d.title, sections: d.sections,
  fillRoleIds: d.fill_role_ids, viewRoleIds: d.view_role_ids, note: d.version_note,
  canFill: formAccess(actor, d, "fill")
});

/** Value as the old sheet held it: text. */
const asCell = (v: unknown): string => Array.isArray(v) ? v.join(", ") : v === undefined || v === null ? "" : String(v);

export const formRoutes: FastifyPluginAsyncTypebox<AppOptions> = async (app, { db }) => {
  app.get("/", async (req) => asActor(db, req, null, async (tx, actor) => {
    await seedClinicForms(tx);
    const r = await sql<DefRow>`
      SELECT DISTINCT ON (form_key) ${DEF_COLS} FROM form_definitions WHERE status = 'published'
       ORDER BY form_key, form_version DESC`.execute(tx);
    const forms = r.rows.filter((d) => formAccess(actor, d, "view") || formAccess(actor, d, "fill"))
      .map((d) => ({ key: d.form_key, version: d.form_version, title: d.title, canFill: formAccess(actor, d, "fill") }))
      .sort((a, b) => a.title.localeCompare(b.title));
    return { forms };
  }));

  app.get("/settings/phone-session", async (req) => asActor(db, req, "masters:write", async (tx) => phoneSettings(tx)));

  app.put("/settings/phone-session", {
    schema: { body: Type.Object({
      idleMinutes: Type.Integer({ minimum: 5, maximum: 1440 }),
      absoluteHours: Type.Integer({ minimum: 1, maximum: 168 })
    }, { additionalProperties: false }) }
  }, async (req) => asActor(db, req, "masters:write", async (tx) => {
    for (const [key, v] of [["phone_session_idle_minutes", req.body.idleMinutes], ["phone_session_hours", req.body.absoluteHours]] as const) {
      await sql`INSERT INTO clinic_settings (key, value) VALUES (${key}, ${JSON.stringify(v)}::jsonb)
                ON CONFLICT (clinic_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(tx);
    }
    return phoneSettings(tx);
  }));

  app.get("/:key", { schema: { params: Type.Object({ key: Type.String({ maxLength: 60 }) }) } },
    async (req) => asActor(db, req, null, async (tx, actor) => {
      await seedClinicForms(tx);
      const d = await currentDefinition(tx, req.params.key);
      if (!formAccess(actor, d, "view") && !formAccess(actor, d, "fill")) throw new HttpError(403, "forbidden", "Your role does not allow this form");
      return { form: publicDef(d, actor) };
    }));

  app.post("/", {
    schema: { body: Type.Object({
      key: Type.String({ maxLength: 60 }),
      title: Type.String({ minLength: 1, maxLength: 120 }),
      sections: Type.Array(Type.Any(), { maxItems: 30 }),
      fillRoleIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { maxItems: 50 })),
      viewRoleIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { maxItems: 50 })),
      note: Type.Optional(Type.String({ maxLength: 300 }))
    }, { additionalProperties: false }) }
  }, async (req, reply) => asActor(db, req, "masters:write", async (tx, actor) => {
    const b = req.body;
    const sections = asHttp(() => validateDefinition({ key: b.key, title: b.title, sections: b.sections }));
    const prev = (await sql<DefRow>`
      SELECT ${DEF_COLS} FROM form_definitions WHERE form_key = ${b.key} ORDER BY form_version DESC LIMIT 1`.execute(tx)).rows[0];
    // Access carries over from the last version unless this one sets it.
    const fill = b.fillRoleIds ?? prev?.fill_role_ids ?? [], view = b.viewRoleIds ?? prev?.view_role_ids ?? [];
    await checkRoleIds(tx, [...fill, ...view]);
    const r = await sql<DefRow>`
      INSERT INTO form_definitions (form_key, form_version, title, sections, fill_role_ids, view_role_ids, legacy_tab, version_note)
      VALUES (${b.key}, ${(prev?.form_version ?? 0) + 1}, ${b.title.trim()}, ${JSON.stringify(sections)}::jsonb,
              ${fill}::uuid[], ${view}::uuid[], ${prev?.legacy_tab ?? null}, ${b.note ?? null})
      RETURNING ${DEF_COLS}`.execute(tx);
    reply.status(201);
    return { form: publicDef(r.rows[0]!, actor) };
  }));

  app.get("/:key/submissions", {
    schema: { params: Type.Object({ key: Type.String({ maxLength: 60 }) }), querystring: Type.Object({ uhid: Type.String({ minLength: 1, maxLength: 30 }) }) }
  }, async (req) => asActor(db, req, null, async (tx, actor) => {
    const d = await currentDefinition(tx, req.params.key);
    if (!formAccess(actor, d, "view") && !formAccess(actor, d, "fill")) throw new HttpError(403, "forbidden", "Your role does not allow this form");
    const r = await sql`
      SELECT s.id, s.form_version, s.status, s."values", s.submitted_at, s.created_at, u.display_name AS by
        FROM form_submissions s LEFT JOIN app_users u ON u.id = coalesce(s.submitted_by, s.created_by)
       WHERE s.form_key = ${req.params.key} AND upper(s.uhid) = upper(${req.query.uhid})
         AND (s.status = 'final' OR s.created_by = ${actor.userId} OR ${can(actor, "roles:manage")})
       ORDER BY coalesce(s.submitted_at, s.created_at) DESC LIMIT 200`.execute(tx);
    return { submissions: r.rows };
  }));

  app.post("/:key/submissions", {
    schema: {
      params: Type.Object({ key: Type.String({ maxLength: 60 }) }),
      body: Type.Object({
        uhid: Type.String({ minLength: 1, maxLength: 30 }),
        values: Type.Record(Type.String(), Type.Any()),
        final: Type.Boolean(),
        id: Type.Optional(Type.String({ format: "uuid" }))
      }, { additionalProperties: false })
    }
  }, async (req, reply) => asActor(db, req, null, async (tx, actor) => {
    const { uhid, values: input, final, id } = req.body;
    let def: DefRow;
    let draft: { id: string; created_by: string | null; status: string; form_id: string; uhid: string } | undefined;
    if (id) {
      draft = (await sql<NonNullable<typeof draft>>`
        SELECT id, created_by, status, form_id, uhid FROM form_submissions WHERE id = ${id} AND form_key = ${req.params.key} FOR UPDATE`.execute(tx)).rows[0];
      if (!draft) throw notFound("Draft");
      if (draft.status !== "draft") throw new HttpError(409, "already_final", "A final record cannot be changed. Save a new record to correct it.");
      if (draft.created_by !== actor.userId && !can(actor, "roles:manage")) throw new HttpError(403, "forbidden", "That draft belongs to someone else");
      if (draft.uhid.toUpperCase() !== uhid.toUpperCase()) throw new HttpError(422, "wrong_patient", "A draft stays with its patient");
      // A draft finishes against the version it was started on.
      def = (await sql<DefRow>`SELECT ${DEF_COLS} FROM form_definitions WHERE id = ${draft.form_id}`.execute(tx)).rows[0]!;
    } else {
      def = await currentDefinition(tx, req.params.key);
    }
    if (!formAccess(actor, def, "fill")) throw new HttpError(403, "forbidden", "Your role may not fill this form");

    const patient = (await sql<{ id: string; uhid: string; full_name: string; gender: string | null; age: number | null }>`
      SELECT id, uhid, full_name, gender, date_part('year', age(date_of_birth))::int AS age FROM patients
       WHERE upper(uhid) = upper(${uhid}) AND deleted_at IS NULL`.execute(tx)).rows[0];
    if (!patient) throw new HttpError(422, "no_patient", "Choose the patient this record is for");

    const checked = asHttp(() => validateValues(def.sections, input, final));
    if (checked.photoIds.length) {
      const have = (await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM patient_documents
         WHERE id = ANY(${checked.photoIds}::uuid[]) AND upper(uhid) = upper(${patient.uhid}) AND deleted_at IS NULL`.execute(tx)).rows[0]!.n;
      if (have !== checked.photoIds.length) throw new HttpError(422, "bad_photo", "A photo is not filed under this patient. Upload it again.");
    }

    let legacyId: string | null = null;
    if (final && def.legacy_tab) {
      // Today's screens read the old tab, so a final record is written there too.
      const fields: Record<string, string> = {};
      for (const f of def.sections.flatMap((s) => s.fields)) {
        const v = checked.values[f.key];
        if (f.legacy && v !== undefined && f.type !== "tooth_chart" && f.type !== "photo" && f.type !== "signature") fields[f.legacy] = asCell(v);
      }
      for (const h of RECORD_HEADINGS[def.legacy_tab] ?? []) {
        if (/^UHID/.test(h)) fields[h] = patient.uhid;
        else if (/^(Patient Name|Name( of (the )?[Pp]atient)?|Name the Patient)$/.test(h)) fields[h] = patient.full_name;
        else if (h === "Age") fields[h] = patient.age === null ? "" : String(patient.age);
        else if (h === "Gender") fields[h] = patient.gender ?? "";
      }
      legacyId = (await sql<{ id: string }>`
        INSERT INTO clinical_records (tab_name, uhid, patient_id, fields)
        VALUES (${def.legacy_tab}, ${patient.uhid}, ${patient.id}, ${JSON.stringify(fields)}::jsonb) RETURNING id`.execute(tx)).rows[0]!.id;
    }

    const vals = JSON.stringify(checked.values);
    let saved: { id: string };
    if (draft) {
      saved = (await sql<{ id: string }>`
        UPDATE form_submissions SET "values" = ${vals}::jsonb, status = ${final ? "final" : "draft"},
               submitted_by = ${final ? actor.userId : null}, submitted_at = ${final ? sql`now()` : null},
               legacy_record_id = ${legacyId}, legacy_source = ${legacyId ? "record" : null}
         WHERE id = ${draft.id} RETURNING id`.execute(tx)).rows[0]!;
    } else {
      saved = (await sql<{ id: string }>`
        INSERT INTO form_submissions (form_id, form_key, form_version, uhid, patient_id, "values", status, submitted_by, submitted_at, legacy_record_id, legacy_source)
        VALUES (${def.id}, ${def.form_key}, ${def.form_version}, ${patient.uhid}, ${patient.id}, ${vals}::jsonb,
                ${final ? "final" : "draft"}, ${final ? actor.userId : null}, ${final ? sql`now()` : null},
                ${legacyId}, ${legacyId ? "record" : null}) RETURNING id`.execute(tx)).rows[0]!;
    }
    reply.status(id ? 200 : 201);
    return { submission: { id: saved.id, status: final ? "final" : "draft", formVersion: def.form_version } };
  }));
};

async function checkRoleIds(tx: Tx, ids: string[]): Promise<void> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return;
  const n = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM roles WHERE id = ANY(${uniq}::uuid[])`.execute(tx)).rows[0]!.n;
  if (n !== uniq.length) throw new HttpError(422, "unknown_role", "One of the roles is not one of this clinic's roles");
}

async function phoneSettings(tx: Tx) {
  const r = await sql<{ key: string; value: number }>`
    SELECT key, (value #>> '{}')::int AS value FROM clinic_settings
     WHERE key IN ('phone_session_idle_minutes', 'phone_session_hours')`.execute(tx);
  const get = (k: string, d: number) => r.rows.find((x) => x.key === k)?.value ?? d;
  return { idleMinutes: get("phone_session_idle_minutes", 60), absoluteHours: get("phone_session_hours", 24) };
}
