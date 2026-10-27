import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTenant } from "../src/db/index.js";
import { kbPrefix, makeWorld, signIn, type World } from "./setup.js";

let w: World;
let desk: string;

beforeAll(async () => {
  w = await makeWorld();
  desk = await signIn(w.app, "alpha", "a-admin");
});
afterAll(() => w.close());

const register = (name: string, cookie = desk) =>
  w.app.inject({ method: "POST", url: "/api/v1/patients", headers: { cookie }, payload: { full_name: name } });

describe("UHIDs", () => {
  it("follow KB's year-month scheme: year letters, month, then that month's number", async () => {
    const res = await register("First Patient");
    expect(res.json().patient.uhid).toBe(`${kbPrefix()}01`);
  });

  it("continue after the highest number already issued this month, e.g. by an import", async () => {
    await w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicA);
      await sql`INSERT INTO patients (uhid, full_name) VALUES (${kbPrefix() + "40"}, 'Imported')`.execute(tx);
    });
    const next = (await register("After Import")).json().patient.uhid;
    expect(next).toBe(`${kbPrefix()}41`);
    const peek = await w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicA);
      return (await sql<{ u: string }>`SELECT peek_uhid() AS u`.execute(tx)).rows[0]!.u;
    });
    expect(peek).toBe(`${kbPrefix()}42`);
  });

  it("never repeat when many desks register at the same moment", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => register(`Rush ${i}`)));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const uhids = results.map((r) => r.json().patient.uhid);
    expect(new Set(uhids).size).toBe(25);
  });

  it("are counted per clinic, so two clinics can both have their own first patient", async () => {
    const beta = await signIn(w.app, "beta", "b-admin");
    const res = await register("Beta First", beta);
    expect(res.json().patient.uhid).toBe("BE0001");
  });

  it("cannot be chosen by the browser", async () => {
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/patients", headers: { cookie: desk },
      payload: { full_name: "Sneaky", uhid: "AL0001" }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("two people editing one patient", () => {
  it("refuses the second save and says why, instead of silently overwriting", async () => {
    const created = (await register("Ravi Kumar")).json().patient;

    const first = await w.app.inject({
      method: "PATCH", url: `/api/v1/patients/${created.id}`, headers: { cookie: desk },
      payload: { version: created.version, changes: { mobile: "9811111111" } }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().patient.version).toBe(created.version + 1);

    const second = await w.app.inject({
      method: "PATCH", url: `/api/v1/patients/${created.id}`, headers: { cookie: desk },
      payload: { version: created.version, changes: { address: "12 MG Road" } }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("changed_elsewhere");
    expect(second.json().error.details.current.mobile).toBe("9811111111");
  });
});

describe("the clinic's rules", () => {
  it("refuses a panel patient with no panel", async () => {
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/patients", headers: { cookie: desk },
      payload: { full_name: "No Panel", patient_type: "Panel" }
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe("panel_patient_has_a_panel");
  });

  it("refuses a mobile number that is not a number", async () => {
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/patients", headers: { cookie: desk },
      payload: { full_name: "Bad Mobile", mobile: "call me" }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("audit", () => {
  it("records who created and who changed a patient", async () => {
    const created = (await register("Audited")).json().patient;
    await w.app.inject({
      method: "PATCH", url: `/api/v1/patients/${created.id}`, headers: { cookie: desk },
      payload: { version: 1, changes: { occupation: "Teacher" } }
    });
    await w.db.transaction().execute(async (tx) => {
      await setTenant(tx, w.clinicA);
      const rows = await sql<{ action: string; user_id: string | null }>`
        SELECT action, user_id FROM audit_log WHERE table_name = 'patients' AND row_id = ${created.id} ORDER BY happened_at`.execute(tx);
      expect(rows.rows.map((r) => r.action)).toEqual(["insert", "update"]);
      expect(rows.rows.every((r) => r.user_id === created.created_by)).toBe(true);
      expect(created.created_by).not.toBeNull();
    });
  });
});
