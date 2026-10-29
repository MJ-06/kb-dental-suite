// The Master screen through /exec, the way today's screens call it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec, execLogin } from "./legacy.js";
import { createUser } from "../src/admin.js";
import { makeWorld, OWNER_URL, PASSWORD, type World } from "./setup.js";

let w: World;
let admin: string;
let desk: string;

beforeAll(async () => {
  w = await makeWorld();
  admin = await execLogin(w, "alpha", "a-admin");
  desk = await execLogin(w, "alpha", "a-desk");
});
afterAll(() => w.close());

describe("signing in through /exec", () => {
  it("refuses every action without a session, with the flag the screens act on", async () => {
    const res = await w.app.inject({ url: "/exec", query: { action: "getChairsList" } });
    expect(res.json()).toEqual({ success: false, error: "AUTH_REQUIRED", authRequired: true });
  });

  it("ignores a token in the URL", async () => {
    const res = await w.app.inject({ url: "/exec", query: { action: "getChairsList", token: "anything" } });
    expect(res.json().authRequired).toBe(true);
  });

  it("takes a sign-in only as a POST body, never from the URL, and bounds its length", async () => {
    const fromUrl = await w.app.inject({ url: "/exec", query: { action: "staffLogin", clinic: "alpha", username: "a-admin", password: PASSWORD } });
    expect(fromUrl.json().success).toBe(false);
    expect(fromUrl.cookies).toHaveLength(0);
    const long = await w.app.inject({
      method: "POST", url: "/exec", headers: { "content-type": "text/plain" },
      payload: JSON.stringify({ action: "staffLogin", clinic: "alpha", username: "a-admin", password: "x".repeat(5000) })
    });
    expect(long.json().success).toBe(false);
    expect(long.cookies).toHaveLength(0);
  });

  it("reports authRequired and whether this browser is signed in", async () => {
    expect(await exec(w, admin, "authStatus")).toEqual({ success: true, authRequired: true, valid: true });
    expect(await exec(w, "kb_session=nope", "authStatus")).toEqual({ success: true, authRequired: true, valid: false });
  });
});

describe("plain lists", () => {
  it("saves and returns a list in order", async () => {
    expect(await exec(w, admin, "savePaymentModesList", { modes: ["Cash", "UPI", "Card"] })).toEqual({ success: true });
    expect(await exec(w, admin, "getPaymentModesList")).toEqual({ success: true, modes: ["Cash", "UPI", "Card"] });
  });

  it("refuses a damaged payload instead of emptying the list", async () => {
    const res = await exec(w, admin, "savePaymentModesList", { modes: '["Cash", "UP' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/arrived damaged/);
    expect((await exec(w, admin, "getPaymentModesList")).modes).toEqual(["Cash", "UPI", "Card"]);
  });

  it("gives document categories their defaults until the clinic sets its own", async () => {
    expect((await exec(w, admin, "getDocumentCategoriesList")).categories).toContain("OPG");
  });

  it("keeps medicine instructions as situation, text and category", async () => {
    const instructions = [{ situation: "After food", text: "Take after meals", category: "Timing" }, "Plain"];
    await exec(w, admin, "saveMedicineInstructionsList", { instructions });
    expect((await exec(w, admin, "getMedicineInstructionsList")).instructions).toEqual([
      { situation: "After food", text: "Take after meals", category: "Timing" },
      { situation: "Plain", text: "Plain", category: "" }
    ]);
  });
});

describe("named lists", () => {
  it("round-trips doctors with phone, email and role as text", async () => {
    const doctors = [{ name: "Dr. A", phone: "9811111111", email: "a@x.in", role: "Endodontist" }, { name: "Dr. B" }];
    await exec(w, admin, "saveDoctorDetailsList", { doctors });
    expect((await exec(w, admin, "getDoctorDetailsList")).doctors).toEqual([
      { name: "Dr. A", phone: "9811111111", email: "a@x.in", role: "Endodontist" },
      { name: "Dr. B", phone: "", email: "", role: "" }
    ]);
  });

  it("deactivates a doctor left out of the list rather than deleting them", async () => {
    await exec(w, admin, "saveDoctorDetailsList", { doctors: [{ name: "Dr. B" }] });
    expect((await exec(w, admin, "getDoctorDetailsList")).doctors.map((d: { name: string }) => d.name)).toEqual(["Dr. B"]);
    await exec(w, admin, "saveDoctorDetailsList", { doctors: [{ name: "Dr. A" }, { name: "Dr. B" }] });
    expect((await exec(w, admin, "getDoctorDetailsList")).doctors).toHaveLength(2);
  });

  it("returns reasons with their steps as the screen expects", async () => {
    await exec(w, admin, "saveReasonsList", { reasons: [{ name: "RCT", steps: "Access Opening, BMP, Obturation" }, "Consultation"] });
    expect(await exec(w, admin, "getReasonsList")).toEqual({
      success: true, reasons: ["RCT", "Consultation"],
      reasonSteps: [{ name: "RCT", steps: "Access Opening, BMP, Obturation" }, { name: "Consultation", steps: "" }]
    });
  });

  it("gives the default reasons to a clinic with none", async () => {
    const beta = await execLogin(w, "beta", "b-admin");
    expect((await exec(w, beta, "getReasonsList")).reasons).toContain("Consultation");
  });

  it("keeps panel rate cards per panel", async () => {
    await exec(w, admin, "savePanelRates", { panel: "CGHS", rates: [{ code: "D1", procedure: "Extraction", rate: "450", classification: "NABH" }] });
    const r = await exec(w, admin, "savePanelRates", { panel: "ECHS", rates: [{ code: "E1", procedure: "Scaling", rate: 300 }, { procedure: "no code" }] });
    expect(r).toEqual({ success: true, saved: 1, kept: 1 });
    expect((await exec(w, admin, "getPanelRates", { panel: "cghs" })).rates).toEqual([
      { panel: "CGHS", code: "D1", procedure: "Extraction", rate: 450, classification: "NABH" }
    ]);
  });
});

describe("settings", () => {
  it("validates and returns clinic timings", async () => {
    expect((await exec(w, admin, "saveClinicTimings", { open: "19:00", close: "09:00", slotMinutes: 15 })).error)
      .toBe("the clinic cannot close before it opens");
    await exec(w, admin, "saveClinicTimings", { open: "9:30", close: "20:00", slotMinutes: 15 });
    expect(await exec(w, admin, "getClinicTimings")).toEqual({ success: true, open: "09:30", close: "20:00", slotMinutes: 15 });
  });

  it("keeps week offs and holidays", async () => {
    await exec(w, admin, "saveWorkingDays", { weekOff: [0], holidays: [{ date: "2026-11-08", name: "Diwali" }] });
    expect(await exec(w, admin, "getWorkingDays")).toEqual({ success: true, weekOff: [0], holidays: [{ date: "2026-11-08", name: "Diwali" }] });
  });

  it("stores screen passwords hashed and checks them", async () => {
    expect((await exec(w, admin, "verifyFinancePassword", { password: "x" })).correct).toBe(true); // none set yet
    await exec(w, admin, "saveFinancePassword", { password: "s3cret" });
    expect((await exec(w, admin, "verifyFinancePassword", { password: "x" })).correct).toBe(false);
    expect((await exec(w, admin, "verifyFinancePassword", { password: "s3cret" })).correct).toBe(true);
    expect((await exec(w, admin, "getSettings")).financePasswordSet).toBe(true);
  });
});

describe("signatures", () => {
  it("accepts a PNG and refuses an SVG or anything that is not a plain image", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(await exec(w, admin, "saveSignature", { doctor: "Dr. A", signatureDataUrl: png })).toEqual({ success: true });
    for (const bad of ["data:image/svg+xml;base64,PHN2Zz4=", 'data:image/png;base64,AA" onerror="alert(1)', "javascript:alert(1)"]) {
      expect((await exec(w, admin, "saveSignature", { doctor: "Dr. A", signatureDataUrl: bad })).success).toBe(false);
    }
    expect((await exec(w, admin, "getSignatures")).signatures).toEqual({ "Dr. A": png });
  });
});

describe("roles", () => {
  it("lets reception read the lists but not change them", async () => {
    expect((await exec(w, desk, "getPaymentModesList")).success).toBe(true);
    const res = await exec(w, desk, "savePaymentModesList", { modes: ["Barter"] });
    expect(res).toMatchObject({ success: false, forbidden: true });
  });
});

describe("batch", () => {
  it("answers several reads in one request", async () => {
    const res = await exec(w, admin, "batch", { actions: [{ key: "a", action: "getChairsList" }, "getPaymentModesList", "savePanelsList"] });
    expect(res.results.a.success).toBe(true);
    expect(res.results.getPaymentModesList.modes).toEqual(["Cash", "UPI", "Card"]);
    expect(res.results.savePanelsList.error).toBe("batch: reads only");
  });
});

describe("signature ownership", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  it("lets a doctor save only their own signature, and an admin anyone's", async () => {
    await createUser(OWNER_URL, w.clinicA, { username: "a-doc", displayName: "Dr. Asha Rao", password: PASSWORD, role: "doctor" });
    const doc = await execLogin(w, "alpha", "a-doc");
    expect(await exec(w, doc, "saveSignature", { doctor: "Asha Rao", signatureDataUrl: png })).toEqual({ success: true });
    const other = await exec(w, doc, "saveSignature", { doctor: "Dr. Vikram", signatureDataUrl: png });
    expect(other).toMatchObject({ success: false });
    expect(await exec(w, admin, "saveSignature", { doctor: "Dr. Vikram", signatureDataUrl: png })).toEqual({ success: true });
  });
});

describe("audit log", () => {
  it("never copies password hashes or password settings into before/after rows", async () => {
    await exec(w, admin, "saveFinancePassword", { password: "s3cret-master" });
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: OWNER_URL });
    await c.connect();
    try {
      await c.query("ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY");
      const r = await c.query(`SELECT count(*)::int AS n FROM audit_log
        WHERE (table_name = 'app_users' AND (before_row ? 'password_hash' OR after_row ? 'password_hash'))
           OR (table_name = 'clinic_settings' AND (after_row->>'key') ILIKE '%password%' AND after_row ? 'value')`);
      expect(r.rows[0].n).toBe(0);
      const seen = await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'app_users'
        OR (table_name = 'clinic_settings' AND (after_row->>'key') ILIKE '%password%')`);
      expect(seen.rows[0].n).toBeGreaterThan(1); // the rows are still audited, just without the secret
    } finally {
      await c.query("ALTER TABLE audit_log FORCE ROW LEVEL SECURITY");
      await c.end();
    }
  });
});
