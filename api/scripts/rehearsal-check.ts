// Calls today's screens' actions against kb_rehearsal (in-process, no network)
// and prints how much each one returns, so a load can be checked end to end.
// Creates a throwaway admin "rehearsal-admin" with a random password that is
// never printed or stored.
import { randomBytes } from "node:crypto";
import { createUser } from "../src/admin.js";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/index.js";
import { required } from "../src/env.js";
import pg from "pg";

const ownerUrl = required("REHEARSAL_OWNER_DATABASE_URL");
const appUrl = new URL(required("DATABASE_URL")); appUrl.pathname = "/kb_rehearsal";
const password = randomBytes(18).toString("base64url");
const c = new pg.Client({ connectionString: ownerUrl }); await c.connect();
const clinic = (await c.query("SELECT id FROM clinics WHERE code = 'kb'")).rows[0].id as string;
await c.query("SELECT set_config('app.clinic_id', $1, false)", [clinic]);
await c.query("DELETE FROM sessions"); await c.query("DELETE FROM app_users WHERE username = 'rehearsal-admin'");
await c.end();
await createUser(ownerUrl, clinic, { username: "rehearsal-admin", displayName: "Rehearsal Admin", password, role: "admin" });

const db = createDb(appUrl.toString(), 3);
const app = await buildApp({ db, cookieSecure: false });
const login = await app.inject({ method: "POST", url: "/exec", headers: { "content-type": "text/plain" },
  payload: JSON.stringify({ action: "staffLogin", clinic: "kb", username: "rehearsal-admin", password }) });
const cookie = `kb_session=${login.cookies.find((x) => x.name === "kb_session")!.value}`;
async function call(action: string, params: Record<string, string> = {}) {
  const res = await app.inject({ url: "/exec", query: { action, ...params }, headers: { cookie } });
  const j = res.json();
  const sizes = Object.entries(j).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${(v as unknown[]).length}`);
  const objs = Object.entries(j).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v)).map(([k, v]) => `${k}{${Object.keys(v as object).length}}`);
  console.log(`${j.success ? "ok  " : "FAIL"} ${action}${Object.keys(params).length ? " " + JSON.stringify(params) : ""} ${sizes.concat(objs).join(" ")} ${j.success ? "" : j.error}`);
  return j;
}
const probe = (await call("getAllPatients")).patients?.[0]?.uhid as string | undefined;
for (const a of ["getPending", "getFinanceSummary", "getDailyCollection", "getOutstandingList", "getExpenses", "getReceipts", "getDailyRegister",
  "getCrmData", "getCrmLeadInbox", "getProcedureLibrary", "getTreatmentsMaster", "getMedicinesMaster", "getDoctorDetailsList", "getChairsList",
  "getPanelsList", "getPanelRates", "getClinicProfile", "getWorkingDays", "getClinicalNoteTemplates", "getPaymentModesList", "getTodaysBirthdays"]) await call(a);
await call("getClinicalRecords", { tabName: "RCT", uhid: "AL0705" });
await call("getAppointments", { date: "2026-08-24" });
await call("searchPatients", { query: "a" });
if (probe) {
  for (const a of ["getPatient", "getClinicalRecords", "getPatientOutstanding", "getTreatmentPlan", "getClinicalSheets", "getPatientDocuments", "getOpenCase"]) await call(a, { uhid: probe });
}
await app.close(); await db.destroy();
const o = new pg.Client({ connectionString: ownerUrl }); await o.connect();
await o.query("SELECT set_config('app.clinic_id', $1, false)", [clinic]);
await o.query("DELETE FROM sessions"); await o.query("DELETE FROM app_users WHERE username = 'rehearsal-admin'"); await o.end();
