// Registration through /exec, the way the registration screen calls it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec, execLogin } from "./legacy.js";
import { kbPrefix, makeWorld, type World } from "./setup.js";

let w: World;
let desk: string;
beforeAll(async () => {
  w = await makeWorld();
  desk = await execLogin(w, "alpha", "a-desk");
});
afterAll(() => w.close());

async function quickRegister(name: string, extra: Record<string, unknown> = {}) {
  const { uhid } = await exec(w, desk, "getNextUHID");
  const res = await exec(w, desk, "saveRegistration", { uhid, name, dob: "22/02/2005", mobile: "9876500001", complaint: "Pain", regStatus: "Quick", ...extra });
  expect(res).toEqual({ success: true, uhid });
  return uhid as string;
}

describe("registration", () => {
  it("does not truncate the monthly UHID when the sequence grows past 99", async () => {
    const {default:pg}=await import("pg"); const {OWNER_URL}=await import("./setup.js");
    const c=new pg.Client({connectionString:OWNER_URL});await c.connect();
    try {
      await c.query("BEGIN"); await c.query("SELECT set_config('app.clinic_id',$1,true)",[w.clinicA]);
      await c.query("INSERT INTO uhid_counters(period,last_value) SELECT period,99 FROM uhid_period() ON CONFLICT(clinic_id,period) DO UPDATE SET last_value=99");
      await c.query("COMMIT");
    } finally {await c.end();}
    const issued=await exec(w,desk,"getNextUHID"); expect(issued.uhid).toBe(kbPrefix()+"100");
  });
  it("retains the current UI's safety flags and supports explicitly clearing them", async () => {
    const uhid=await quickRegister("Synthetic Flags Example",{safetyFlags:["Apprehensive"]});
    expect((await exec(w,desk,"getPatient",{uhid})).patient.safetyFlags).toEqual(["Apprehensive"]);
    await exec(w,desk,"saveRegistration",{uhid,safetyFlags:[]});
    expect((await exec(w,desk,"getPatient",{uhid})).patient.safetyFlags).toEqual([]);
  });
  it("saves a new patient under the UHID the screen was shown", async () => {
    const uhid = await quickRegister("Test Patient One");
    expect(uhid.startsWith(kbPrefix())).toBe(true);
    const p = (await exec(w, desk, "getPatient", { uhid })).patient;
    expect(p).toMatchObject({ uhid, name: "Test Patient One", dob: "22/02/2005", mobile: "9876500001", complaint: "Pain" });
  });

  it("refuses a made-up UHID for a new patient", async () => {
    const res = await exec(w, desk, "saveRegistration", { uhid: "ZZ0101", name: "Invented" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not issued by this system/);
  });

  it("refuses to use one UHID for two new patients", async () => {
    const { uhid } = await exec(w, desk, "getNextUHID");
    await exec(w, desk, "saveRegistration", { uhid, name: "First" });
    // A second desk replaying the same number gets the FIRST patient
    // updated, never a second patient under it.
    await exec(w, desk, "saveRegistration", { uhid, name: "Second" });
    const all = (await exec(w, desk, "getAllPatients")).patients.filter((x: { uhid: string }) => x.uhid === uhid);
    expect(all).toHaveLength(1);
  });

  it("never blanks a field the later save left empty", async () => {
    const uhid = await quickRegister("Keep Fields", { occupation: "Teacher", allergies: '["Penicillin"]' });
    await exec(w, desk, "saveRegistration", { uhid, name: "Keep Fields", address: "12 MG Road", occupation: "" });
    const p = (await exec(w, desk, "getPatient", { uhid })).patient;
    expect(p).toMatchObject({ occupation: "Teacher", address: "12 MG Road", allergies: ["Penicillin"] });
  });

  it("records a panel patient with their panel, and refuses one without", async () => {
    const admin = await execLogin(w, "alpha", "a-admin");
    await exec(w, admin, "savePanelsList", { panels: ["CGHS"] });
    const uhid = await quickRegister("Panel Person", { patientType: "Panel", panel: "CGHS", panelCategory: "Pensioner", cardId: "C-1" });
    const row = (await exec(w, desk, "getAllPatients")).patients.find((x: { uhid: string }) => x.uhid === uhid);
    expect(row).toMatchObject({ panel: "CGHS", panelCategory: "Pensioner", cardId: "C-1" });
    const { uhid: u2 } = await exec(w, desk, "getNextUHID");
    expect((await exec(w, desk, "saveRegistration", { uhid: u2, name: "No Panel", patientType: "Panel" })).success).toBe(false);
    // The desk cannot invent a panel; that is Master's job.
    const res = await exec(w, desk, "saveRegistration", { uhid: u2, name: "New Panel", patientType: "Panel", panel: "MADE UP" });
    expect(res.error).toMatch(/Add it in Master first/);
  });

  it("finds a duplicate by name and date of birth, whatever the spacing or case", async () => {
    await quickRegister("Asha  Verma");
    const res = await exec(w, desk, "checkDuplicate", { name: "asha verma", dob: "22/02/2005" });
    expect(res).toMatchObject({ success: true, duplicate: true, existingName: "Asha  Verma" });
    expect((await exec(w, desk, "checkDuplicate", { name: "asha verma", dob: "23/02/2005" })).duplicate).toBe(false);
  });

  it("finds patients by part of a name, UHID or mobile, at most 20", async () => {
    const res = await exec(w, desk, "searchPatients", { query: "verma" });
    expect(res.patients.map((x: { name: string }) => x.name)).toContain("Asha  Verma");
    expect((await exec(w, desk, "searchPatients", { query: "98765" })).patients.length).toBeLessThanOrEqual(20);
  });
});

describe("the iPad form", () => {
  it("matches a patient only with their UHID and the mobile on file", async () => {
    const uhid = await quickRegister("Ipad Person");
    expect((await exec(w, desk, "patientLookup", { uhid, mobile: "9999999999" })).success).toBe(false);
    const ok = await exec(w, desk, "patientLookup", { uhid, mobile: "+91 98765 00001" });
    expect(ok.patient.name).toBe("Ipad Person");
  });

  it("completes the history without letting the form change the name", async () => {
    const uhid = await quickRegister("Real Name");
    await exec(w, desk, "patientCompleteRegistration", { uhid, mobile: "9876500001", name: "Other Name", bloodGroup: "B + ve", conditions: ["Diabetes"] });
    const p = (await exec(w, desk, "getPatient", { uhid })).patient;
    expect(p).toMatchObject({ name: "Real Name", bloodGroup: "B + ve", conditions: ["Diabetes"], complaint: "Pain" });
  });
});
