// Clinical forms, tooth-chart sheets, care plans, consents and progress through /exec.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, type World } from "./setup.js";

let w: World;
let admin: string;
let desk: string;
let betaAdmin: string;
let uhid: string;

beforeAll(async () => {
  w = await makeWorld();
  admin = await execLogin(w, "alpha", "a-admin");
  desk = await execLogin(w, "alpha", "a-desk");
  betaAdmin = await execLogin(w, "beta", "b-admin");
  ({ uhid } = await exec(w, desk, "getNextUHID"));
  await exec(w, desk, "saveRegistration", { uhid, name: "Clinical Patient", mobile: "9833300000" });
});
afterAll(() => w.close());
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

describe("flat record forms", () => {
  it("stores a form under the clinic's own headings and reads it back", async () => {
    const saved = await exec(w, admin, "saveRestoration", {
      uhid, patientName: "Clinical Patient", age: "34", gender: "Female", toothSite: "36",
      restoType: "Composite", material: "Filtek", operator: "Dr. A", shade: "A2"
    });
    expect(saved.success).toBe(true);
    const res = await exec(w, admin, "getClinicalRecords", { tabName: "Restoration", uhid: uhid.toLowerCase() });
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toMatchObject({
      _rowIndex: 2, "UHID No.": uhid, "Name of patient": "Clinical Patient", "Tooth No. / Site": "36",
      "Type of Restoration": "Composite", Shade: "A2", Remarks: ""
    });
    expect(res.records[0].Timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(res.headers[0]).toBe("Timestamp");
    expect(res.headers).toContain("Finishing & Polishing");
  });

  it("keeps each patient's rows to themselves and numbers rows down the tab", async () => {
    const other = (await exec(w, desk, "getNextUHID")).uhid;
    await exec(w, desk, "saveRegistration", { uhid: other, name: "Other Patient", mobile: "9833300001" });
    await exec(w, admin, "saveRestoration", { uhid: other, toothSite: "11" });
    await exec(w, admin, "saveRestoration", { uhid, toothSite: "37" });
    const mine = (await exec(w, admin, "getClinicalRecords", { tabName: "Restoration", uhid })).records;
    expect(mine.map((r: Record<string, unknown>) => r["Tooth No. / Site"])).toEqual(["36", "37"]);
    expect(mine.map((r: Record<string, unknown>) => r._rowIndex)).toEqual([2, 4]);
  });

  it("saves every form the screens offer, each on its own tab", async () => {
    const forms: Record<string, string> = {
      savePathology: "Pathology", saveRadiology: "Radiology", saveRadiograph: "Radiograph", saveLocalAnesthesia: "Local Anesthesia",
      saveIntraOralScanning: "Intra Oral Scan", savePrescription: "Prescriptions", saveScaling: "Scaling", saveMinorSurgery: "Minor Surgery",
      saveTMJoint: "TMJoint", saveOrthodontics: "Orthodontics", saveOrthodonticsProgress: "Orthodontics Progress",
      saveDenture: "Denture", savePedo: "Pedo", saveLabLog: "Lab Log"
    };
    for (const [action, tab] of Object.entries(forms)) {
      expect((await exec(w, admin, action, { uhid, patientName: "Clinical Patient", remarks: "r", medicines: [{ name: "Amox" }] })).success, action).toBe(true);
      const got = await exec(w, admin, "getClinicalRecords", { tabName: tab, uhid });
      expect(got.records, tab).toHaveLength(1);
    }
    const rx = (await exec(w, admin, "getClinicalRecords", { tabName: "Prescriptions", uhid })).records[0];
    expect(JSON.parse(rx.Medicines)).toEqual([{ name: "Amox" }]);
  });

  it("refuses a record with no patient, an unknown tab and a read with no patient", async () => {
    expect((await exec(w, admin, "savePathology", { testAdvised: "CBC" })).error).toBe("Choose the patient this record is for");
    expect((await exec(w, admin, "getClinicalRecords", { tabName: "Salaries", uhid })).error).toBe("Unknown record type: Salaries");
    expect((await exec(w, admin, "getClinicalRecords", { tabName: "Pedo" })).error).toBe("tabName and uhid required");
  });

  it("answers with an empty list for a tab nobody has used", async () => {
    expect(await exec(w, betaAdmin, "getClinicalRecords", { tabName: "Restoration", uhid })).toEqual({ success: true, records: [] });
  });

  it("keeps clinical records from reception", async () => {
    expect(await exec(w, desk, "getClinicalRecords", { tabName: "Pedo", uhid })).toMatchObject({ success: false, forbidden: true });
    expect(await exec(w, desk, "saveScaling", { uhid })).toMatchObject({ success: false, forbidden: true });
  });
});

describe("tooth charts and care plans", () => {
  it("saves one chart per sheet type and reads the newest when no type is named", async () => {
    await exec(w, admin, "saveClinicalSheets", { uhid, patientName: "Clinical Patient", sheetType: "RCT", allTeeth: { "36": { canals: 3 } } });
    await exec(w, admin, "saveClinicalSheets", { uhid, patientName: "Clinical Patient", sheetType: "Crown Bridge", allTeeth: { "46": { shade: "A2" } } });
    await exec(w, admin, "saveClinicalSheets", { uhid, patientName: "Clinical Patient", sheetType: "RCT", allTeeth: { "36": { canals: 4 } } });
    expect(await exec(w, admin, "getClinicalSheets", { uhid, sheetType: "RCT" })).toMatchObject({ allTeeth: { "36": { canals: 4 } }, sheetType: "RCT" });
    expect(await exec(w, admin, "getClinicalSheets", { uhid, sheetType: "Crown Bridge" })).toMatchObject({ allTeeth: { "46": { shade: "A2" } } });
    expect((await exec(w, admin, "getClinicalSheets", { uhid })).sheetType).toBe("RCT"); // the most recent save
    expect(await exec(w, admin, "getClinicalSheets", { uhid: "NOPE" })).toEqual({ success: true, allTeeth: null });
  });

  it("refuses a damaged chart rather than saving it empty", async () => {
    const res = await w.app.inject({ url: "/exec", query: { action: "saveClinicalSheets", uhid, sheetType: "RCT", allTeeth: "{oops" }, headers: { cookie: admin } });
    expect(res.json()).toMatchObject({ success: false, error: expect.stringMatching(/damaged/) });
    expect((await exec(w, admin, "getClinicalSheets", { uhid, sheetType: "RCT" })).allTeeth).toEqual({ "36": { canals: 4 } });
  });

  it("keeps a care plan per patient, page by page", async () => {
    expect(await exec(w, admin, "getCarePlan", { uhid })).toEqual({ success: true, page1: null, page2: null, page3: null, page4: null });
    await exec(w, admin, "saveCarePlan", { uhid, patientName: "Clinical Patient", date: "2026-10-28", page1: { a: 1 }, page2: { b: 2 } });
    await exec(w, admin, "saveCarePlan", { uhid, patientName: "Clinical Patient", date: "2026-10-29", page1: { a: 9 }, page3: [1, 2] });
    expect(await exec(w, admin, "getCarePlan", { uhid })).toMatchObject({ page1: { a: 9 }, page2: null, page3: [1, 2], page4: null });
  });
});

describe("consents and progress", () => {
  it("records every consent it is given", async () => {
    const one = { uhid, patientName: "Clinical Patient", date: "2026-10-28", procedure: "RCT", language: "Hindi", soap: "narrative", fee: "5000" };
    expect((await exec(w, admin, "saveConsent", one)).success).toBe(true);
    expect((await exec(w, admin, "saveConsent", { ...one, procedure: "Crown" })).success).toBe(true);
    expect(await exec(w, desk, "saveConsent", one)).toMatchObject({ success: false, forbidden: true });
  });

  it("lists the register's entries for a patient as treatment progress", async () => {
    await exec(w, desk, "saveToDailyRegister", { date: "2026-10-20", uhid, patientName: "Clinical Patient", procedureDone: "RCT", toothNo: "36", workDone: "Access opening", operatingDoctor: "Dr. A", modeOfPayment: "UPI" });
    const res = await exec(w, admin, "getTreatmentProgress", { uhid });
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({ date: "2026-10-20", toothNo: "36", treatmentRendered: "RCT", workDone: "Access opening", doctor: "Dr. A", paymentMode: "UPI", amountReceived: "", sigDataUrl: "" });
  });
});

describe("consent narrative", () => {
  it("says plainly when no key is set", async () => {
    expect(await exec(w, admin, "generateSOAPNotes", { name: "X" })).toMatchObject({ success: false, error: "ANTHROPIC_API_KEY is not set on the server" });
  });

  it("asks the model with the clinic's own name and returns the text", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ text: "Two paragraphs." }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await exec(w, admin, "generateSOAPNotes", { name: "Mr. Test", age: "45/Male", complaint: "pain", tooth: "46" });
    expect(res).toEqual({ success: true, soap: "Two paragraphs." });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.messages[0].content).toContain("Patient: Mr. Test | Age/Gender: 45/Male");
    expect(sent.messages[0].content).toContain("reported to Alpha Dental");
    expect(sent.messages[0].content).not.toContain("K.B.");
  });

  it("reports a failed call without leaking the reason", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up to 10.0.0.5"); }));
    const res = await exec(w, admin, "generateSOAPNotes", { name: "X" });
    expect(res).toEqual({ success: false, error: "The writer could not be reached. Try again." });
  });
});
