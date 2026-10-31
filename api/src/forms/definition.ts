// What a form definition is, and what a filled form must look like against one.
// Pure functions: the routes and the seed both go through them, and the tests
// need no database.

export const FIELD_TYPES = ["text", "number", "date", "choice", "multi_choice", "tooth_chart", "photo", "signature"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];       // choice / multi_choice; for a tooth chart, the marks a tooth can carry
  multiline?: boolean;      // text only
  help?: string;
  max?: number;             // photo: how many
  legacy?: string;          // the old sheet heading this field was carried over from
}
export interface FormSection { id: string; title: string; fields: FormField[] }

const KEY = /^[a-z][a-zA-Z0-9_]{0,39}$/;
const FORM_KEY = /^[a-z0-9][a-z0-9_-]{1,59}$/;

export class FormError extends Error {}

/** Throws FormError with a sentence a clinic admin can act on. Returns the cleaned sections. */
export function validateDefinition(d: { key: string; title: string; sections: unknown }): FormSection[] {
  if (!FORM_KEY.test(d.key)) throw new FormError("The form key uses lower case letters, digits, - and _ (2 to 60 characters)");
  if (!d.title.trim()) throw new FormError("The form needs a title");
  if (!Array.isArray(d.sections) || !d.sections.length) throw new FormError("The form needs at least one section");
  const seenSections = new Set<string>(), seenFields = new Set<string>();
  const out: FormSection[] = [];
  for (const s of d.sections as Record<string, unknown>[]) {
    const id = String(s?.id ?? ""), title = String(s?.title ?? "").trim();
    if (!/^[a-z0-9_-]{1,40}$/.test(id) || seenSections.has(id)) throw new FormError(`Section id "${id}" is missing, odd or used twice`);
    seenSections.add(id);
    if (!Array.isArray(s.fields) || !s.fields.length) throw new FormError(`Section "${title || id}" has no fields`);
    const fields: FormField[] = [];
    for (const f of s.fields as Record<string, unknown>[]) {
      const key = String(f?.key ?? ""), label = String(f?.label ?? "").trim(), type = f?.type as FieldType;
      if (!KEY.test(key) || seenFields.has(key)) throw new FormError(`Field key "${key}" is missing, odd or used twice`);
      seenFields.add(key);
      if (!label) throw new FormError(`Field "${key}" needs a label`);
      if (!FIELD_TYPES.includes(type)) throw new FormError(`Field "${key}" has an unknown type`);
      const options = f.options === undefined ? undefined : (f.options as unknown[]).map((o) => String(o).trim());
      if ((type === "choice" || type === "multi_choice") && (!options?.length || options.some((o) => !o) || new Set(options).size !== options.length))
        throw new FormError(`Field "${label}" needs a list of different, non-empty options`);
      if (type === "tooth_chart" && options && (!options.length || options.some((o) => !o)))
        throw new FormError(`Field "${label}" has an empty tooth mark`);
      const max = f.max === undefined ? undefined : Number(f.max);
      if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 20)) throw new FormError(`Field "${label}": max photos is 1 to 20`);
      fields.push({
        key, label, type, ...(f.required ? { required: true } : {}), ...(options ? { options } : {}),
        ...(f.multiline ? { multiline: true } : {}), ...(f.help ? { help: String(f.help).slice(0, 300) } : {}),
        ...(max ? { max } : {}), ...(f.legacy ? { legacy: String(f.legacy) } : {})
      });
    }
    out.push({ id, title, fields });
  }
  return out;
}

const FDI = new Set([
  ...[1, 2, 3, 4].flatMap((q) => Array.from({ length: 8 }, (_, i) => `${q}${i + 1}`)),
  ...[5, 6, 7, 8].flatMap((q) => Array.from({ length: 5 }, (_, i) => `${q}${i + 1}`))
]);
export const DEFAULT_TOOTH_MARKS = ["Treated", "Planned", "Missing", "Needs attention"];
const MAX_SIGNATURE_CHARS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Checked { values: Record<string, unknown>; photoIds: string[] }

/**
 * Checks a filled form against its definition. A draft only has to be well
 * formed; a final record must also have every required field. Keys the
 * definition does not have are refused, so a record is exactly one version's shape.
 */
export function validateValues(sections: FormSection[], input: Record<string, unknown>, final: boolean): Checked {
  const fields = new Map(sections.flatMap((s) => s.fields).map((f) => [f.key, f] as const));
  const values: Record<string, unknown> = {};
  const photoIds: string[] = [];
  for (const k of Object.keys(input)) if (!fields.has(k)) throw new FormError(`This form has no field "${k}"`);
  for (const f of fields.values()) {
    const v = input[f.key];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) ||
      (f.type === "tooth_chart" && typeof v === "object" && !Object.keys(v as object).length);
    if (empty) {
      if (final && f.required) throw new FormError(`"${f.label}" is required`);
      continue;
    }
    switch (f.type) {
      case "text":
        if (typeof v !== "string" || v.length > (f.multiline ? 5000 : 500)) throw new FormError(`"${f.label}" must be text of reasonable length`);
        values[f.key] = v.trim();
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) throw new FormError(`"${f.label}" must be a number`);
        values[f.key] = v;
        break;
      case "date":
        if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)
          throw new FormError(`"${f.label}" must be a date (YYYY-MM-DD)`);
        values[f.key] = v;
        break;
      case "choice":
        if (typeof v !== "string" || !f.options!.includes(v)) throw new FormError(`"${f.label}": choose one of the listed options`);
        values[f.key] = v;
        break;
      case "multi_choice":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !f.options!.includes(x)) || new Set(v).size !== v.length)
          throw new FormError(`"${f.label}": choose from the listed options`);
        values[f.key] = v;
        break;
      case "tooth_chart": {
        const marks = f.options ?? DEFAULT_TOOTH_MARKS;
        if (typeof v !== "object" || Array.isArray(v)) throw new FormError(`"${f.label}" must be a tooth chart`);
        const chart: Record<string, string> = {};
        for (const [tooth, mark] of Object.entries(v as Record<string, unknown>)) {
          if (!FDI.has(tooth)) throw new FormError(`"${f.label}": ${tooth} is not a tooth number`);
          if (typeof mark !== "string" || !marks.includes(mark)) throw new FormError(`"${f.label}": tooth ${tooth} has an unlisted mark`);
          chart[tooth] = mark;
        }
        values[f.key] = chart;
        break;
      }
      case "photo":
        if (!Array.isArray(v) || v.length > (f.max ?? 6) || v.some((x) => typeof x !== "string" || !UUID.test(x)) || new Set(v).size !== v.length)
          throw new FormError(`"${f.label}": attach up to ${f.max ?? 6} uploaded photos`);
        values[f.key] = v;
        photoIds.push(...(v as string[]));
        break;
      case "signature":
        if (typeof v !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > MAX_SIGNATURE_CHARS)
          throw new FormError(`"${f.label}" must be a drawn signature`);
        values[f.key] = v;
        break;
    }
  }
  return { values, photoIds };
}
