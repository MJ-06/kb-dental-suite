// The promise this whole design makes: one clinic can never see or touch
// another clinic's rows, by any route, even if the code forgets a filter.
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTenant } from "../src/db/index.js";
import { APP_URL, makeWorld, signIn, type World } from "./setup.js";

let w: World;
let alphaPatient: string;
let alpha: string;
let beta: string;

beforeAll(async () => {
  w = await makeWorld();
  alpha = await signIn(w.app, "alpha", "a-admin");
  beta = await signIn(w.app, "beta", "b-admin");
  const res = await w.app.inject({
    method: "POST", url: "/api/v1/patients", headers: { cookie: alpha },
    payload: { full_name: "Asha Verma", mobile: "9876543210" }
  });
  expect(res.statusCode).toBe(201);
  alphaPatient = res.json().patient.id;
});
afterAll(() => w.close());

describe("through the API", () => {
  it("does not list another clinic's patients", async () => {
    const res = await w.app.inject({ url: "/api/v1/patients?q=asha", headers: { cookie: beta } });
    expect(res.statusCode).toBe(200);
    expect(res.json().patients).toEqual([]);
  });

  it("answers 404, not 403, for another clinic's patient id", async () => {
    // 403 would confirm the id exists somewhere.
    const res = await w.app.inject({ url: `/api/v1/patients/${alphaPatient}`, headers: { cookie: beta } });
    expect(res.statusCode).toBe(404);
  });

  it("cannot change another clinic's patient", async () => {
    const res = await w.app.inject({
      method: "PATCH", url: `/api/v1/patients/${alphaPatient}`, headers: { cookie: beta },
      payload: { version: 1, changes: { full_name: "Hijacked" } }
    });
    expect(res.statusCode).toBe(404);
    const own = await w.app.inject({ url: `/api/v1/patients/${alphaPatient}`, headers: { cookie: alpha } });
    expect(own.json().patient.full_name).toBe("Asha Verma");
  });

  it("refuses everything when signed out", async () => {
    const res = await w.app.inject({ url: "/api/v1/patients" });
    expect(res.statusCode).toBe(401);
  });
});

describe("in the database itself, as the app's own role", () => {
  async function asApp<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: APP_URL });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  }

  it("shows no rows at all when no clinic is set (a forgotten filter fails closed)", async () => {
    const n = await asApp(async (c) => (await c.query("SELECT count(*)::int AS n FROM patients")).rows[0].n);
    expect(n).toBe(0);
  });

  it("shows only the current clinic's rows even with no WHERE clause", async () => {
    await w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicB);
      const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM patients`.execute(tx);
      expect(rows.rows[0]!.n).toBe(0);
    });
    await w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicA);
      const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM patients`.execute(tx);
      expect(rows.rows[0]!.n).toBe(1);
    });
  });

  it("refuses to insert a row for another clinic", async () => {
    await expect(w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicB);
      await sql`INSERT INTO patients (clinic_id, uhid, full_name) VALUES (${w.clinicA}, 'X1', 'Planted')`.execute(tx);
    })).rejects.toThrow(/row-level security/);
  });

  it("refuses to move a row to another clinic", async () => {
    await expect(w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicA);
      await sql`UPDATE patients SET clinic_id = ${w.clinicB} WHERE id = ${alphaPatient}`.execute(tx);
    })).rejects.toThrow();
  });

  it("does not let the app role read the clinic registry", async () => {
    await expect(asApp((c) => c.query("SELECT * FROM clinics"))).rejects.toThrow(/permission denied/);
  });

  it("does not let the app role rewrite the audit log", async () => {
    await expect(w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicA);
      await sql`DELETE FROM audit_log`.execute(tx);
    })).rejects.toThrow(/permission denied/);
  });
});
