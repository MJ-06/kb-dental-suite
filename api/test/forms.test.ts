// Form definitions, submissions, the carry-over of the old clinical rows, and phone sessions.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "../src/admin.js";
import { setTenant } from "../src/db/index.js";
import { backfillLegacy, seedForms } from "../src/forms/seed.js";
import { validateDefinition, validateValues, FormError } from "../src/forms/definition.js";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, OWNER_URL, PASSWORD, signIn, type World } from "./setup.js";

let w: World;
let admin: string, doctor: string, desk: string, betaAdmin: string;
let uhid: string;

const api = (cookie: string, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  w.app.inject({ method, url, headers: { cookie }, payload: payload as never });

const ownerQuery = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    // The schema owner is subject to FORCE RLS too. These assertions inspect
    // clinic A's fixtures, so give the connection the same explicit context as
    // the application instead of silently matching zero rows.
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [w.clinicA]);
    const rows = (await c.query<T>(text, params)).rows;
    await c.query("COMMIT");
    return rows;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally { await c.end(); }
};

beforeAll(async () => {
  w = await makeWorld();
  await createUser(OWNER_URL, w.clinicA, { username: "a-doc", displayName: "Dr A", password: PASSWORD, role: "doctor" });
  admin = await signIn(w.app, "alpha", "a-admin");
  doctor = await signIn(w.app, "alpha", "a-doc");
  desk = await signIn(w.app, "alpha", "a-desk");
  betaAdmin = await signIn(w.app, "beta", "b-admin");
  const reg = await execLogin(w, "alpha", "a-desk");
  ({ uhid } = await exec(w, reg, "getNextUHID"));
  await exec(w, reg, "saveRegistration", { uhid, name: "Form Patient", mobile: "9833300000" });
});
afterAll(() => w.close());

describe("definitions (no database)", () => {
  const sections = [{ id: "a", title: "A", fields: [
    { key: "tooth", label: "Tooth", type: "text", required: true },
    { key: "when", label: "When", type: "date" },
    { key: "kind", label: "Kind", type: "choice", options: ["X", "Y"] },
    { key: "many", label: "Many", type: "multi_choice", options: ["P", "Q"] },
    { key: "chart", label: "Chart", type: "tooth_chart" },
    { key: "pics", label: "Pics", type: "photo", max: 2 },
    { key: "sign", label: "Sign", type: "signature" }
  ] }];
  const def = validateDefinition({ key: "demo", title: "Demo", sections });

  it("refuses duplicate keys, empty option lists and unknown types", () => {
    expect(() => validateDefinition({ key: "d1", title: "t", sections: [{ id: "a", fields: [{ key: "x", label: "X", type: "text" }, { key: "x", label: "Y", type: "text" }] }] })).toThrow(FormError);
    expect(() => validateDefinition({ key: "d1", title: "t", sections: [{ id: "a", fields: [{ key: "x", label: "X", type: "choice", options: [] }] }] })).toThrow(FormError);
    expect(() => validateDefinition({ key: "d1", title: "t", sections: [{ id: "a", fields: [{ key: "x", label: "X", type: "video" }] }] })).toThrow(FormError);
  });
  it("lets a draft be incomplete but a final record not", () => {
    expect(validateValues(def, {}, false).values).toEqual({});
    expect(() => validateValues(def, {}, true)).toThrow(/required/);
  });
  it("checks each type and refuses keys the form does not have", () => {
    expect(() => validateValues(def, { tooth: "36", when: "2026-02-30" }, true)).toThrow(/date/);
    expect(() => validateValues(def, { tooth: "36", kind: "Z" }, true)).toThrow(/options/);
    expect(() => validateValues(def, { tooth: "36", chart: { "99": "Treated" } }, true)).toThrow(/tooth number/);
    expect(() => validateValues(def, { tooth: "36", sign: "http://evil/x.png" }, true)).toThrow(/signature/);
    expect(() => validateValues(def, { tooth: "36", pics: ["not-an-id"] }, true)).toThrow(/photos/);
    expect(() => validateValues(def, { tooth: "36", other: 1 }, true)).toThrow(/no field/);
  });
  it("seeds a definition for every old tab", () => {
    expect(seedForms().length).toBe(19);
    for (const f of seedForms()) expect(() => validateDefinition({ key: f.key, title: f.title, sections: f.sections })).not.toThrow();
  });
});

describe("access", () => {
  it("lists the forms to a doctor, none to reception, and keeps clinics apart", async () => {
    const docList = (await api(doctor, "GET", "/api/v1/forms")).json().forms;
    expect(docList.length).toBe(19);
    expect(docList.find((f: { key: string }) => f.key === "restoration")).toMatchObject({ canFill: true });
    expect((await api(desk, "GET", "/api/v1/forms")).json().forms).toEqual([]);
    expect((await api(desk, "GET", "/api/v1/forms/restoration")).statusCode).toBe(403);
    expect((await api(betaAdmin, "GET", "/api/v1/forms")).json().forms.length).toBe(19);
  });
  it("needs a session", async () => {
    expect((await w.app.inject({ url: "/api/v1/forms" })).statusCode).toBe(401);
  });
  it("lets only a role manager publish a definition", async () => {
    const body = { key: "x1", title: "X", sections: [{ id: "a", title: "A", fields: [{ key: "k", label: "K", type: "text" }] }] };
    expect((await api(doctor, "POST", "/api/v1/forms", body)).statusCode).toBe(403);
    expect((await api(admin, "POST", "/api/v1/forms", body)).statusCode).toBe(201);
  });
});

describe("submissions", () => {
  const sub = (cookie: string, key: string, payload: object) => api(cookie, "POST", `/api/v1/forms/${key}/submissions`, payload);

  it("keeps a draft editable, then freezes the final record and writes it through to the old tab", async () => {
    const d = await sub(doctor, "restoration", { uhid, values: { toothSite: "36" }, final: false });
    expect(d.statusCode).toBe(201);
    const id = d.json().submission.id;
    expect((await sub(doctor, "restoration", { uhid, id, values: { toothSite: "37", shade: "A2" }, final: true })).statusCode).toBe(200);

    expect((await sub(doctor, "restoration", { uhid, id, values: { toothSite: "38" }, final: true })).statusCode).toBe(409);
    expect(await ownerQuery("UPDATE form_submissions SET status = 'draft' WHERE id = $1", [id]).catch((e) => e.message)).toMatch(/cannot be changed/);
    expect(await ownerQuery("DELETE FROM form_submissions WHERE id = $1", [id]).catch((e) => e.message)).toMatch(/cannot be deleted/);

    const old = await exec(w, await execLogin(w, "alpha", "a-admin"), "getClinicalRecords", { tabName: "Restoration", uhid });
    expect(old.records.at(-1)).toMatchObject({ "Tooth No. / Site": "37", Shade: "A2", "UHID No.": uhid, "Name of patient": "Form Patient" });
    const list = (await api(doctor, "GET", `/api/v1/forms/restoration/submissions?uhid=${uhid}`)).json().submissions;
    expect(list.filter((s: { status: string }) => s.status === "final")).toHaveLength(1);
  });

  it("is refused for a role not allowed to fill, an unknown patient and a missing required field", async () => {
    expect((await sub(desk, "restoration", { uhid, values: {}, final: false })).statusCode).toBe(403);
    expect((await sub(doctor, "restoration", { uhid: "NOPE1", values: {}, final: false })).statusCode).toBe(422);
    await api(admin, "POST", "/api/v1/forms", { key: "need", title: "Need", sections: [{ id: "a", title: "A", fields: [{ key: "k", label: "K", type: "text", required: true }] }] });
    const r = await sub(admin, "need", { uhid, values: {}, final: true });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/required/);
  });

  it("refuses a photo that is not filed under this patient", async () => {
    await api(admin, "POST", "/api/v1/forms", { key: "pics", title: "Pics", sections: [{ id: "a", title: "A", fields: [{ key: "p", label: "P", type: "photo" }] }] });
    const r = await sub(admin, "pics", { uhid, values: { p: ["0190b0a0-0000-7000-8000-000000000000"] }, final: true });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("bad_photo");
  });

  it("a new version leaves old submissions as they were", async () => {
    await api(admin, "POST", "/api/v1/forms", { key: "ver", title: "V", sections: [{ id: "a", title: "A", fields: [{ key: "k", label: "K", type: "text" }] }] });
    const first = (await sub(admin, "ver", { uhid, values: { k: "one" }, final: true })).json().submission;
    expect(first.formVersion).toBe(1);
    const v2 = await api(admin, "POST", "/api/v1/forms", { key: "ver", title: "V", sections: [{ id: "a", title: "A", fields: [{ key: "k2", label: "K2", type: "text" }] }] });
    expect(v2.json().form.version).toBe(2);
    expect((await sub(admin, "ver", { uhid, values: { k: "again" }, final: true })).statusCode).toBe(422); // k no longer exists
    const second = (await sub(admin, "ver", { uhid, values: { k2: "two" }, final: true })).json().submission;
    expect(second.formVersion).toBe(2);
    const list = (await api(admin, "GET", `/api/v1/forms/ver/submissions?uhid=${uhid}`)).json().submissions;
    const old = list.find((s: { form_version: number }) => s.form_version === 1);
    expect(old.values).toEqual({ k: "one" });
    expect(await ownerQuery("UPDATE form_definitions SET sections = '[]' WHERE form_key = 'ver' AND form_version = 1").catch((e) => e.message)).toMatch(/cannot be changed/);
  });

  it("audits every save", async () => {
    const n = await ownerQuery<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'form_submissions'");
    expect(n[0]!.n).toBeGreaterThan(3);
  });
});

describe("carrying over the old rows", () => {
  it("links every old record and sheet once, keeping headings the form does not know", async () => {
    const reg = await execLogin(w, "alpha", "a-admin");
    await exec(w, reg, "saveOrthodontics", { uhid, patientName: "Form Patient", operator: "Dr. B" });
    await exec(w, reg, "saveClinicalSheets", { uhid, sheetType: "RCT", allTeeth: { "36": { canals: 3 } } });
    await ownerQuery(
      `INSERT INTO clinical_records (clinic_id, tab_name, uhid, fields) VALUES ($1, 'Pedo', $2, $3::jsonb)`,
      [w.clinicA, uhid, JSON.stringify({ UHID: uhid, "Tooth No. / Site": "55", "An Old Heading": "kept" })]);
    const before = await ownerQuery<{ n: number }>("SELECT (SELECT count(*) FROM clinical_records)::int + (SELECT count(*) FROM clinical_sheets)::int AS n");
    const run = () => w.db.transaction().execute(async (tx) => { await setTenant(tx, w.clinicA); return backfillLegacy(tx); });
    const first = await run();
    expect(first).toBeGreaterThanOrEqual(3);
    expect(await run()).toBe(0);
    const after = await ownerQuery<{ n: number }>("SELECT (SELECT count(*) FROM clinical_records)::int + (SELECT count(*) FROM clinical_sheets)::int AS n");
    expect(after[0]!.n).toBe(before[0]!.n); // the old tables were not touched

    const pedo = await ownerQuery<{ values: Record<string, unknown> }>(
      `SELECT "values" FROM form_submissions WHERE form_key = 'pedo' AND legacy_source = 'record'`);
    expect(pedo[0]!.values).toMatchObject({ toothSite: "55", _legacy: { "An Old Heading": "kept" } });
    const rct = await ownerQuery<{ values: { _legacy: { toothChart: unknown } } }>(`SELECT "values" FROM form_submissions WHERE form_key = 'rct' AND legacy_source = 'sheet'`);
    expect(rct[0]!.values._legacy.toothChart).toEqual({ "36": { canals: 3 } });
  });
});

describe("phone sessions", () => {
  const phoneLogin = () => w.app.inject({
    method: "POST", url: "/api/v1/auth/login", payload: { clinic: "alpha", username: "a-doc", password: PASSWORD, device: "phone" }
  });

  it("lasts a day from sign-in by default, and the clinic can change that", async () => {
    const res = await phoneLogin();
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === "kb_session")!.maxAge).toBe(24 * 3600);
    const put = await api(admin, "PUT", "/api/v1/forms/settings/phone-session", { idleMinutes: 30, absoluteHours: 8 });
    expect(put.json()).toEqual({ idleMinutes: 30, absoluteHours: 8 });
    expect((await phoneLogin()).cookies.find((c) => c.name === "kb_session")!.maxAge).toBe(8 * 3600);
    await api(admin, "PUT", "/api/v1/forms/settings/phone-session", { idleMinutes: 60, absoluteHours: 24 });
  });

  it("ends after an hour unused but not a desk session", async () => {
    const phone = `kb_session=${(await phoneLogin()).cookies.find((c) => c.name === "kb_session")!.value}`;
    expect((await api(phone, "GET", "/api/v1/auth/me")).statusCode).toBe(200);
    await ownerQuery("UPDATE sessions SET last_seen_at = now() - interval '61 minutes'");
    expect((await api(phone, "GET", "/api/v1/auth/me")).statusCode).toBe(401);
    expect((await api(doctor, "GET", "/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("stays alive while it is being used", async () => {
    const phone = `kb_session=${(await phoneLogin()).cookies.find((c) => c.name === "kb_session")!.value}`;
    await ownerQuery("UPDATE sessions SET last_seen_at = now() - interval '59 minutes' WHERE kind = 'phone'");
    expect((await api(phone, "GET", "/api/v1/auth/me")).statusCode).toBe(200);
    await ownerQuery("UPDATE sessions SET last_seen_at = last_seen_at - interval '30 minutes' WHERE kind = 'phone'");
    expect((await api(phone, "GET", "/api/v1/auth/me")).statusCode).toBe(200);
  });

  it("serves the entry page", async () => {
    const page = await w.app.inject({ url: "/forms.html" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="viewport"');
    expect(page.headers["content-security-policy"]).toContain("nonce-");
  });
});
