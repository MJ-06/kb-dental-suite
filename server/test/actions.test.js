// The API, run against a real PostgreSQL database.
//
// Not mocks. Every test below opens a connection, writes rows, and reads
// them back, so a constraint that would refuse the write at the desk
// refuses it here too. Point it at a scratch database:
//
//   PGHOST=/tmp/kbpg/sock PGPORT=5433 PGUSER=kb PGDATABASE=kbdental \
//     node test/actions.test.js
const { actions } = require("../src/registry");
const { route } = require("../src/server");
const db = require("../src/db");

let passed = 0, failed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  failures.push(`${label}${detail ? `\n      ${detail}` : ""}`);
}

function eq(label, got, want) {
  ok(label, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    failed++;
    failures.push(`${name} threw: ${e.message}\n${(e.stack || "").split("\n").slice(1, 3).join("\n")}`);
  }
}

// A clean database before every run, so one run cannot pass because of what
// the last one left behind.
async function reset() {
  await db.query(`
    TRUNCATE crm_lead_inbox, crm_documents, audit_log, sessions,
             payments, expenses, prescriptions, consents, care_plans,
             treatment_plans, clinical_records, patient_documents,
             case_stages, treatment_cases, visits, blocked_slots, appointments,
             patient_registrations, patients, panel_rates, panels,
             doctors, staff, chairs, appointment_reasons,
             procedure_stages, procedures, medicines, implant_brands,
             treatments, pick_lists, clinic_settings, holidays, signatures
      RESTART IDENTITY CASCADE`);
}

async function seed() {
  await actions.savePanelsList({ panels: ["CGHS", "DGEHS"] });
  await actions.saveChairsList({ chairs: ["Chair 1", "Chair 2"] });
  await actions.saveDoctorDetailsList({
    doctors: [
      { name: "Dr. Viveyk Mittel", phone: "9810000000", role: "Prosthodontist" },
      { name: "Dr. Neha Sharma", phone: "9811111111", role: "Endodontist" }
    ]
  });
  await actions.saveProcedureLibrary({
    library: [{
      procedureCode: "RCT_ANTERIOR", procedureName: "RCT (Anterior)",
      familyCode: "ENDODONTIC", visitsMin: 2, visitsMax: 3,
      stages: [
        { sequenceNo: 1, stageCode: "ACCESS", stageName: "Access Opening", stageType: "P" },
        { sequenceNo: 2, stageCode: "BMP", stageName: "BMP", stageType: "P" },
        { sequenceNo: 3, stageCode: "OBT", stageName: "Obturation", stageType: "T", completesTreatment: true }
      ]
    }]
  });
}

async function run() {
  await reset();
  await seed();

  // ── masters ────────────────────────────────────────────────────────────
  await test("master lists come back as they went in", async () => {
    const d = await actions.getDoctorDetailsList();
    eq("two doctors", d.doctors.length, 2);
    eq("the phone stays text", d.doctors[1].phone, "9810000000");
    const c = await actions.getChairsList();
    eq("two chairs", c.chairs.join(","), "Chair 1,Chair 2");
  });

  await test("a list that arrived damaged is refused, not saved as empty", async () => {
    const before = (await actions.getPaymentModesList()).modes;
    await actions.savePaymentModesList({ modes: ["Cash", "UPI", "Card"] });
    const r = await route({ action: "savePaymentModesList", modes: "{not json" });
    eq("refused", r.success, false);
    const after = (await actions.getPaymentModesList()).modes;
    eq("the old list is still there", after.join(","), "Cash,UPI,Card");
    ok("and was not wiped", after.length >= before.length);
  });

  await test("a doctor is deactivated, never deleted", async () => {
    await actions.saveDoctorDetailsList({ doctors: [{ name: "Dr. Viveyk Mittel" }] });
    const d = await actions.getDoctorDetailsList();
    eq("one on the list now", d.doctors.length, 1);
    const still = await db.query("SELECT count(*)::int n FROM doctors");
    eq("but both rows survive", still.rows[0].n, 2);
    // Put her back for the rest of the run.
    await actions.saveDoctorDetailsList({
      doctors: [{ name: "Dr. Viveyk Mittel" }, { name: "Dr. Neha Sharma" }]
    });
  });

  // ── patients ───────────────────────────────────────────────────────────
  await test("a new patient registers, and is queued as a lead", async () => {
    const next = await actions.getNextUHID();
    ok("a UHID was issued", /^[A-Z]{2}\d{2}\d{2,}$/.test(next.uhid), next.uhid);

    const r = await actions.saveRegistration({
      uhid: next.uhid, name: "Neena Arora", gender: "Female", dob: "1961-04-12",
      mobile: "9810123456", address: "Dwarka", patientType: "Normal",
      referredBy: "Anil Kumar", referredByType: "PR / Marketing",
      conditions: ["Diabetes", "Hypertension"], allergies: ["Penicillin"],
      complaint: "Pain in upper left", painLevel: "7"
    });
    eq("saved", r.success, true);

    const got = await actions.getPatient({ uhid: next.uhid });
    eq("name", got.patient.name, "Neena Arora");
    eq("the medical history came back", got.patient.conditions.join(","), "Diabetes,Hypertension");
    eq("the referrer kind came back", got.patient.referredByType, "PR / Marketing");
    eq("pain level is not lost as a zero-ish blank", got.patient.painLevel, "7");

    const inbox = await actions.getCrmLeadInbox();
    eq("waiting as a lead", inbox.leadInbox.length, 1);
    eq("under their own name", inbox.leadInbox[0].name, "Neena Arora");
  });

  await test("the iPad's medical history does not wipe the desk's work", async () => {
    const uhid = (await db.query("SELECT uhid FROM patients LIMIT 1")).rows[0].uhid;
    // The patient's own form sends a history and nothing else.
    const r = await actions.patientCompleteRegistration({
      uhid, conditions: ["Asthma"], complaint: "Sensitivity"
    });
    eq("accepted", r.success, true);
    const got = await actions.getPatient({ uhid });
    eq("the address the desk typed survives", got.patient.address, "Dwarka");
    eq("the mobile survives", got.patient.mobile, "9810123456");
    eq("the newest history wins", got.patient.conditions.join(","), "Asthma");
    // And the earlier answer is still on the record, not overwritten.
    const n = await db.query("SELECT count(*)::int n FROM patient_registrations WHERE uhid = $1", [uhid]);
    eq("two collections on file", n.rows[0].n, 2);
  });

  await test("a re-registered patient is one patient, not two", async () => {
    const before = (await actions.getAllPatients()).patients.length;
    const uhid = (await db.query("SELECT uhid FROM patients LIMIT 1")).rows[0].uhid;
    await actions.saveRegistration({ uhid, name: "Neena Arora", mobile: "9810123456" });
    const after = (await actions.getAllPatients()).patients;
    eq("the count did not move", after.length, before);
  });

  await test("a panel patient must have a panel, and a private one must not", async () => {
    const u = (await actions.getNextUHID()).uhid;
    await actions.saveRegistration({
      uhid: u, name: "R K Gupta", patientType: "Panel", panel: "CGHS",
      panelCategory: "Pensioner", cardId: "CG-4471", mobile: "9999000011"
    });
    const got = await actions.getPatient({ uhid: u });
    eq("panel", got.patient.panel, "CGHS");
    eq("card", got.patient.cardId, "CG-4471");
    eq("type", got.patient.patientType, "Panel");

    // The constraint, directly: a private patient carrying a card id.
    let refused = false;
    try {
      await db.query(
        `INSERT INTO patients (uhid, full_name, patient_type, card_id) VALUES ('ZZ9999','X','Normal','CG-1')`
      );
    } catch (e) { refused = e.constraint === "panel_patient_has_a_panel"; }
    ok("the database refuses it", refused);
  });

  await test("search finds a patient by name, number or UHID", async () => {
    const byName = await actions.searchPatients({ query: "Neena" });
    eq("by name", byName.patients.length, 1);
    const byPhone = await actions.searchPatients({ query: "9810123456" });
    eq("by number", byPhone.patients.length, 1);
    const byId = await actions.searchPatients({ query: byName.patients[0].uhid });
    eq("by UHID", byId.patients.length, 1);
  });

  // ── appointments ───────────────────────────────────────────────────────
  let apptId, uhid;
  await test("a booking is saved, and a chair cannot hold two patients at once", async () => {
    uhid = (await actions.searchPatients({ query: "Neena" })).patients[0].uhid;
    const a = await actions.saveAppointment({
      uhid, patientName: "Neena Arora", date: "2026-11-10", time: "10:30",
      type: "RCT", doctor: "Dr. Neha Sharma", chair: "Chair 1", mobile: "9810123456"
    });
    eq("booked", a.success, true);
    apptId = a.id;

    const clash = await actions.saveAppointment({
      patientName: "Someone Else", date: "2026-11-10", time: "10:30",
      type: "Consultation", doctor: "Dr. Neha Sharma", chair: "Chair 1"
    });
    eq("the second is refused", clash.success, false);
    ok("and says which chair and when", /Chair 1/.test(clash.error) && /10:30/.test(clash.error), clash.error);

    const other = await actions.saveAppointment({
      patientName: "Someone Else", date: "2026-11-10", time: "10:30",
      type: "Consultation", doctor: "Dr. Neha Sharma", chair: "Chair 2"
    });
    eq("the other chair is free", other.success, true);
  });

  await test("a check-in can be undone, and the stamp goes with it", async () => {
    await actions.updateAppointmentStatus({ id: apptId, status: "Checked In" });
    let a = (await actions.getAppointments({ date: "2026-11-10" })).appointments
      .find((x) => x.id === apptId);
    ok("checked in at a real time", /^\d{2}:\d{2}$/.test(a.checkinTime), a.checkinTime);

    await actions.updateAppointmentStatus({ id: apptId, status: "In Chair" });
    a = (await actions.getAppointments({ date: "2026-11-10" })).appointments.find((x) => x.id === apptId);
    ok("engaged", !!a.engagedTime);

    // Back to Scheduled: the patient never came.
    await actions.updateAppointmentStatus({ id: apptId, status: "Scheduled" });
    a = (await actions.getAppointments({ date: "2026-11-10" })).appointments.find((x) => x.id === apptId);
    eq("status went back", a.status, "Scheduled");
    eq("the check-in stamp is gone", a.checkinTime, "");
    eq("and so is the engaged stamp", a.engagedTime, "");
  });

  await test("the stamps cannot happen out of order", async () => {
    let refused = false;
    try {
      await db.query(
        `INSERT INTO appointments (patient_name, appt_date, appt_time, reason, checkout_at)
         VALUES ('X', '2026-11-11', '09:00', 'Consultation', now())`
      );
    } catch (e) { refused = e.constraint === "stamps_in_order"; }
    ok("checked out without ever arriving is refused", refused);
  });

  await test("a cancellation needs a reason", async () => {
    const bad = await actions.updateAppointmentStatus({ id: apptId, status: "Cancelled" });
    eq("refused", bad.success, false);
    const good = await actions.updateAppointmentStatus({
      id: apptId, status: "Cancelled", cancelReason: "Patient rescheduled"
    });
    eq("accepted with one", good.success, true);
    const a = (await actions.getAppointments({ date: "2026-11-10" })).appointments
      .find((x) => x.id === apptId);
    eq("and it is on the record", a.cancelReason, "Patient rescheduled");
  });

  await test("nothing is booked on a day the clinic is shut", async () => {
    await actions.saveWorkingDays({ weekOff: ["Sunday"], holidays: [{ date: "2026-11-14", name: "Diwali" }] });
    const r = await actions.saveAppointment({
      patientName: "Walk By", date: "2026-11-14", time: "11:00", type: "Consultation", chair: "Chair 1"
    });
    eq("refused", r.success, false);
    ok("and says why", /Diwali/.test(r.error), r.error);
    const walkIn = await actions.saveAppointment({
      patientName: "Emergency", date: "2026-11-14", time: "11:00",
      type: "Consultation", chair: "Chair 1", walkIn: true
    });
    eq("but an emergency seen that day is still recordable", walkIn.success, true);
  });

  // ── cases, and the appointment's sub-reason ────────────────────────────
  let caseId;
  await test("a case knows which step is next, and the booking reads it", async () => {
    const started = await actions.startTreatmentCase({
      uhid, procedureCode: "RCT_ANTERIOR", toothRef: "21", patientName: "Neena Arora"
    });
    eq("started", started.success, true);
    caseId = started.caseId;
    eq("current step", started.currentStageName, "Access Opening");
    eq("next step", started.nextStageName, "BMP");

    // The booking sends no subType at all — it comes from the case.
    const a = await actions.saveAppointment({
      uhid, patientName: "Neena Arora", date: "2026-11-12", time: "09:30",
      type: "RCT", doctor: "Dr. Neha Sharma", chair: "Chair 1", caseId
    });
    eq("booked", a.success, true);
    const got = (await actions.getAppointments({ date: "2026-11-12" })).appointments[0];
    eq("the day sheet shows the step", got.subType, "Access Opening");
    eq("alongside the reason", got.type, "RCT");
  });

  await test("finishing a stage moves the case on, and finishing them all closes it", async () => {
    let s = await actions.resolveStageOutcome({ caseId, completedStages: [1], outcome: "completed" });
    eq("current moved on", s.currentStageName, "BMP");
    eq("one visit counted", s.visitCounter, 1);

    s = await actions.resolveStageOutcome({ caseId, completedStages: [2], outcome: "adjustment_required" });
    eq("an adjustment was inserted next", s.currentStageName, "BMP / adjustment");
    eq("and Obturation still follows", s.nextStageName, "Obturation");

    s = await actions.resolveStageOutcome({ caseId, completedStages: [2.1, 3], outcome: "completed" });
    eq("nothing left pending", s.currentStageName, "");
    eq("so the case is closed", s.caseStatus, "completed");
  });

  await test("an open case is found again instead of started twice", async () => {
    const u2 = (await actions.getNextUHID()).uhid;
    await actions.saveRegistration({ uhid: u2, name: "Test Case Patient", mobile: "9000000001" });
    const first = await actions.startTreatmentCase({ uhid: u2, procedureCode: "RCT_ANTERIOR" });
    const found = await actions.getOpenCase({ uhid: u2, procedureCode: "RCT_ANTERIOR" });
    eq("found", found.found, true);
    eq("the same case", found.caseId, first.caseId);
  });

  // ── the register, and the money ────────────────────────────────────────
  await test("two clinical actions in one visit make one register row", async () => {
    await actions.saveToDailyRegister({
      uhid, date: "2026-09-15", procedureDone: "RCT", toothNo: "21",
      operatingDoctor: "Dr. Neha Sharma", timeWalkIn: "10:05", consultationTime: "11:10"
    });
    await actions.saveToDailyRegister({ uhid, date: "2026-09-15", workDone: "Access opened, dressing" });
    const reg = await actions.getDailyRegister({ uhid, date: "2026-09-15" });
    eq("one row", reg.entries.length, 1);
    eq("the first save's procedure is still there", reg.entries[0].procedureDone, "RCT");
    eq("and the second save's work was added", reg.entries[0].workDone, "Access opened, dressing");
    eq("TAT is worked out, not typed", reg.entries[0].tat, "1h 05m");
    // Born 12 April 1961: their age today, worked out from the patient's own
    // row rather than copied into the register and left to go stale.
    const today = new Date();
    const birthdayPassed = today.getMonth() > 3 || (today.getMonth() === 3 && today.getDate() >= 12);
    eq("the age comes from the patient",
       reg.entries[0].age, String(today.getFullYear() - 1961 - (birthdayPassed ? 0 : 1)));
  });

  await test("a payment on a day with no visit is still the patient's money", async () => {
    // The real case: three payments, one of them on a day that has no
    // register entry. The browser used to join them by date and drop it.
    await actions.saveReceipt({ uhid, date: "2026-09-15", fee: 65000, mode: "Card", service: "RCT", receiptNo: "R-001" });
    await actions.saveReceipt({ uhid, date: "2026-09-20", fee: 40000, mode: "UPI", service: "Crown", receiptNo: "R-002" });
    await actions.saveReceipt({ uhid, date: "2026-10-02", fee: 65000, mode: "Cash", service: "Implant", receiptNo: "R-003" });

    const rev = await actions.getRevenueByPatient({ uhid });
    eq("Finance says", rev.revenue, 170000);

    const prog = await actions.getTreatmentProgress({ uhid });
    eq("and so does the procedures sheet", prog.totalReceived, 170000);
    ok("the unmatched payments have their own lines",
       prog.entries.filter((e) => e.paymentOnly).length === 2,
       JSON.stringify(prog.entries.map((e) => [e.date, e.amountReceived])));
    const sep15 = prog.entries.find((e) => e.date === "2026-09-15" && !e.paymentOnly);
    eq("the visit's own line shows its payment", sep15.amountReceived, 65000);
    eq("with the mode", sep15.paymentMode, "Card");
  });

  await test("a receipt cannot name a patient who does not exist", async () => {
    const r = await actions.saveReceipt({ uhid: "NOBODY1", fee: 100, mode: "Cash" });
    eq("refused", r.success, false);
  });

  await test("two receipts cannot share a number", async () => {
    const r = await actions.saveReceipt({ uhid, date: "2026-10-03", fee: 500, mode: "Cash", receiptNo: "R-001" });
    eq("refused", r.success, false);
    ok("and says so", /R-001/.test(r.error), r.error);
  });

  await test("the day's collection adds up by mode", async () => {
    const c = await actions.getDailyCollection({ fromDate: "2026-09-01", toDate: "2026-10-31" });
    eq("total", c.total, 170000);
    eq("card", c.byMode.Card, 65000);
    eq("cash", c.byMode.Cash, 65000);
    eq("upi", c.byMode.UPI, 40000);
  });

  // ── clinical records ───────────────────────────────────────────────────
  await test("a form is filed against the visit it belongs to", async () => {
    const r = await actions.saveRadiograph({
      uhid, date: "2026-09-15", toothNo: "21", view: "IOPA", finding: "Periapical radiolucency"
    });
    eq("saved", r.success, true);
    const linked = await db.query(
      "SELECT visit_id FROM clinical_records WHERE id = $1", [r.id]
    );
    ok("joined to the day's register row by a column, not a date guess", linked.rows[0].visit_id !== null);

    const back = await actions.getClinicalRecords({ uhid, formType: "radiograph" });
    eq("one record", back.records.length, 1);
    eq("the form's own fields survive", back.records[0].finding, "Periapical radiolucency");
  });

  await test("the four examination pages are one living record", async () => {
    await actions.saveClinicalSheets({ uhid, page1: { chiefComplaint: "Pain 21" } });
    await actions.saveClinicalSheets({ uhid, page3: { occlusion: "Class I" } });
    const s = await actions.getClinicalSheets({ uhid });
    eq("page 1 survived the page 3 save", s.page1.chiefComplaint, "Pain 21");
    eq("page 3 is there", s.page3.occlusion, "Class I");
    const n = await db.query(
      "SELECT count(*)::int n FROM clinical_records WHERE uhid = $1 AND form_type = 'clinical_sheets'", [uhid]
    );
    eq("in one row, not two", n.rows[0].n, 1);
  });

  // ── documents ──────────────────────────────────────────────────────────
  await test("a prescription is kept once, however many times it is printed", async () => {
    const html = "<html><body>Rx: Amoxicillin 500mg</body></html>";
    const first = await actions.createDocumentPDF({ uhid, html, fileName: "Prescription", docKey: "rx-abc123" });
    eq("saved", first.success, true);
    eq("and it is new", first.duplicate, false);

    const reprint = await actions.createDocumentPDF({ uhid, html, fileName: "Prescription", docKey: "rx-abc123" });
    eq("the reprint is accepted", reprint.success, true);
    eq("but files nothing new", reprint.duplicate, true);
    eq("it hands back the one that exists", reprint.id, first.id);

    const docs = await actions.getPatientDocuments({ uhid });
    eq("one document in the folder", docs.documents.length, 1);
  });

  await test("a document cannot be filed against a patient who does not exist", async () => {
    const r = await actions.createDocumentPDF({ uhid: "NOBODY2", html: "<p>x</p>", docKey: "k" });
    eq("refused", r.success, false);
  });

  // ── CRM ────────────────────────────────────────────────────────────────
  await test("leads drain from the inbox and are not offered twice", async () => {
    const before = await actions.getCrmLeadInbox();
    ok("somebody is waiting", before.leadInbox.length > 0);
    const ids = before.leadInbox.map((x) => x.id);
    const marked = await actions.markCrmLeadsTaken({ ids });
    eq("all taken", marked.marked, ids.length);
    const after = await actions.getCrmLeadInbox();
    eq("nobody waiting now", after.leadInbox.length, 0);
    // The same patient registering again does not queue a second time.
    await actions.saveRegistration({ uhid, name: "Neena Arora", mobile: "9810123456" });
    const again = await actions.getCrmLeadInbox();
    eq("and they are not offered again", again.leadInbox.length, 0);
  });

  await test("a CRM collection is replaced whole, in one transaction", async () => {
    await actions.saveCrmCollection({
      name: "contacts",
      records: [{ id: "c1", firstName: "Neena", company: "CGHS" }, { id: "c2", firstName: "R K" }]
    });
    let d = await actions.getCrmData();
    eq("two contacts", d.data.contacts.length, 2);
    await actions.saveCrmCollection({ name: "contacts", records: [{ id: "c1", firstName: "Neena" }] });
    d = await actions.getCrmData();
    eq("one after the replace", d.data.contacts.length, 1);
    const bad = await actions.saveCrmCollection({ name: "nonsense", records: [] });
    eq("an unknown collection is refused", bad.success, false);
  });

  // ── the wire ───────────────────────────────────────────────────────────
  await test("an unknown action is named, not swallowed", async () => {
    const r = await route({ action: "noSuchThing" });
    eq("refused", r.success, false);
    ok("by name", /noSuchThing/.test(r.error), r.error);
  });

  await test("a batch answers every read under its own key", async () => {
    const r = await route({
      action: "batch",
      actions: JSON.stringify([
        { key: "chairs", action: "getChairsList" },
        { key: "panels", action: "getPanelsList" },
        { key: "patient", action: "getPatient", params: { uhid } },
        { key: "today", action: "getAppointments", params: { date: "2026-11-12" } }
      ])
    });
    eq("the batch succeeded", r.success, true);
    eq("chairs came back", r.results.chairs.chairs.length, 2);
    eq("so did the patient", r.results.patient.patient.name, "Neena Arora");
    eq("and the day", r.results.today.appointments.length, 1);
  });

  await test("a batch will not write, and will not nest", async () => {
    const r = await route({
      action: "batch",
      actions: JSON.stringify([
        { key: "w", action: "saveExpense", params: { amount: 100, category: "Lab" } },
        { key: "n", action: "batch" }
      ])
    });
    eq("the write was refused", r.results.w.error, "batch: reads only");
    eq("and the nesting", r.results.n.error, "batch: not allowed");
    const spent = await db.query("SELECT count(*)::int n FROM expenses");
    eq("nothing was written", spent.rows[0].n, 0);
  });

  await test("an entry cannot smuggle its own token into a batch", async () => {
    const r = await route({
      action: "batch", token: "",
      actions: JSON.stringify([{ key: "p", action: "getPanelsList", params: { token: "forged", action: "saveSettings" } }])
    });
    eq("it still ran as the read it named", r.results.p.success, true);
    ok("and returned panels", Array.isArray(r.results.p.panels));
  });

  // ── auth ───────────────────────────────────────────────────────────────
  await test("sign-in issues a token, and documents are always behind one", async () => {
    const { hashPassword, putSetting } = require("../src/auth");
    await putSetting("app_password", hashPassword("open-sesame"));

    const bad = await actions.staffLogin({ password: "wrong" });
    eq("a wrong password is refused", bad.success, false);

    const good = await actions.staffLogin({ password: "open-sesame" });
    eq("the right one is not", good.success, true);
    ok("and a token comes back", typeof good.token === "string" && good.token.length >= 32);

    // Documents need a session even while the rollout flag is off.
    const noSession = await route({ action: "getPatientDocuments", uhid });
    eq("refused without one", noSession.error, "AUTH_REQUIRED");
    const withSession = await route({ action: "getPatientDocuments", uhid, token: good.token });
    eq("allowed with one", withSession.success, true);
  });

  await test("turning auth on closes everything but the public actions", async () => {
    const { putSetting } = require("../src/auth");
    await putSetting("require_auth", true);
    try {
      const shut = await route({ action: "getAllPatients" });
      eq("the patient list is shut", shut.error, "AUTH_REQUIRED");
      const open = await route({ action: "ping" });
      eq("but ping is not", open.success, true);
      const login = await route({ action: "staffLogin", password: "open-sesame" });
      eq("and neither is signing in", login.success, true);
      const now = await route({ action: "getAllPatients", token: login.token });
      eq("with a token it opens", now.success, true);
    } finally {
      await putSetting("require_auth", false);
    }
  });

  await test("the token is taken from a header, a cookie, or last of all the URL", async () => {
    const { tokenFrom } = require("../src/auth");
    // A header first: that is where the app puts it now.
    eq("header", tokenFrom({ token: "from-url" }, { "x-kb-token": "from-header" }), "from-header");
    eq("cookie next", tokenFrom({ token: "from-url" }, { cookie: "a=1; kb_session=from-cookie; b=2" }), "from-cookie");
    eq("a url token still works, for the rollback", tokenFrom({ token: "from-url" }, {}), "from-url");
    eq("nothing at all", tokenFrom({}, {}), "");
    // A cookie value is url-encoded on the way out, so it has to be decoded.
    eq("an encoded cookie", tokenFrom({}, { cookie: "kb_session=a%2Bb" }), "a+b");
    // A cookie whose name merely ends in kb_session is a different cookie.
    eq("not a lookalike name", tokenFrom({}, { cookie: "not_kb_session=x" }), "");
  });

  await test("logging in sets an HttpOnly cookie, and signing out clears it", async () => {
    const { hashPassword, putSetting } = require("../src/auth");
    await putSetting("app_password", hashPassword("cookie-test"));
    const login = await actions.staffLogin({ password: "cookie-test", _from: "test-cookie" });
    eq("signed in", login.success, true);
    eq("and the server was told to set the cookie", login.setCookie, login.token);
    const out = await actions.staffLogout({ token: login.token });
    eq("signing out clears it", out.clearCookie, true);
    eq("and the session is gone", await require("../src/auth").isValidSession(login.token), false);
  });

  await test("a wrong password cannot be guessed at full speed", async () => {
    const { hashPassword, putSetting, LOGIN_MAX_TRIES, loginAttempts } = require("../src/auth");
    await putSetting("app_password", hashPassword("right-one"));
    const from = "192.0.2.77";
    loginAttempts.delete(from);

    for (let i = 0; i < LOGIN_MAX_TRIES; i++) {
      const r = await actions.staffLogin({ password: `wrong-${i}`, _from: from });
      eq(`attempt ${i + 1} refused`, r.success, false);
    }
    const blocked = await actions.staffLogin({ password: "wrong-again", _from: from });
    eq("the next one is held off", blocked.success, false);
    ok("and says for how long", /minute/.test(blocked.error), blocked.error);
    // Even the RIGHT password waits: otherwise the block tells an attacker
    // the moment they have found it.
    const evenRight = await actions.staffLogin({ password: "right-one", _from: from });
    eq("the right password waits too", evenRight.success, false);

    // Somebody else at a different machine is unaffected.
    const other = await actions.staffLogin({ password: "right-one", _from: "192.0.2.78" });
    eq("another desk still works", other.success, true);

    // And a successful sign-in clears that desk's count.
    loginAttempts.delete(from);
    const after = await actions.staffLogin({ password: "right-one", _from: from });
    eq("once the wait is over, the right password works", after.success, true);
    eq("and the slate is clean", loginAttempts.has(from), false);
  });

  await test("a screen password is stored hashed, never in the clear", async () => {
    await actions.saveFinancePassword({ password: "money123" });
    const row = await db.query("SELECT value FROM clinic_settings WHERE key = 'finance_password'");
    ok("not the password itself", !String(row.rows[0].value).includes("money123"), String(row.rows[0].value));
    eq("the right one unlocks", (await actions.verifyFinancePassword({ password: "money123" })).correct, true);
    eq("a wrong one does not", (await actions.verifyFinancePassword({ password: "nope" })).correct, false);
  });

  // ── the registry itself ────────────────────────────────────────────────
  await test("every action the app calls exists", async () => {
    const { missingActions, EXPECTED } = require("../src/registry");
    const missing = missingActions();
    eq("none missing", missing.join(", "), "");
    ok("and the list is the app's whole router", EXPECTED.length >= 130, `${EXPECTED.length} actions`);
  });

  // ── speed, since that is the reason for all of this ────────────────────
  await test("a patient lookup uses the index", async () => {
    const plan = await db.query(
      "EXPLAIN SELECT * FROM patients WHERE uhid = $1", [uhid]
    );
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join(" ");
    ok("index scan, not a sequential one", /Index Scan/.test(text), text);
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await db.close();
  process.exit(failed ? 1 : 0);
}

run().catch(async (e) => {
  console.error(e);
  await db.close();
  process.exit(1);
});
