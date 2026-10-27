// Every action the browser can ask for, in one place.
//
// Apps Script had a 180-line switch, and an action that was never written
// fell through to "Unknown action" at the desk, mid-task. Here the list the
// app calls is declared, checked against what is implemented when the server
// starts, and anything missing is printed at startup — not discovered by a
// receptionist.
const { query } = require("./db");
const auth = require("./auth");

const masters = require("./actions/masters").actions;
const patients = require("./actions/patients").actions;
const appointments = require("./actions/appointments").actions;
const clinical = require("./actions/clinical").actions;
const documents = require("./actions/documents").actions;
const cases = require("./actions/cases").actions;
const finance = require("./actions/finance").actions;
const crm = require("./actions/crm").actions;
const ai = require("./actions/ai").actions;

const actions = Object.assign(
  Object.create(null),
  masters, patients, appointments, clinical, documents, cases, finance, crm, ai
);

// ── auth and health, which belong to no module ───────────────────────────
actions.ping = async () => ({ success: true, message: "pong", timestamp: new Date().toISOString() });
actions.staffLogin = (p) => auth.staffLogin(p);
actions.staffLogout = (p) => auth.staffLogout(p);
actions.authStatus = async (p) => ({
  success: true,
  authRequired: await auth.authRequired(),
  valid: await auth.isValidSession(p.token)
});

const finance_ = auth.screenPassword("finance_password");
const master_ = auth.screenPassword("master_password");
const reports_ = auth.screenPassword("reports_password");
actions.saveFinancePassword = (p) => finance_.save(p);
actions.verifyFinancePassword = (p) => finance_.verify(p);
actions.saveMasterPassword = (p) => master_.save(p);
actions.verifyMasterPassword = (p) => master_.verify(p);
actions.saveReportsPassword = (p) => reports_.save(p);
actions.verifyReportsPassword = (p) => reports_.verify(p);

// The old debugging action named the sheet's columns. Here it names the
// table's, which is the same question asked of the thing that now holds the
// data.
actions.debugSheetHeaders = async (p) => {
  const table = String(p.table || p.sheet || "patients").replace(/[^a-z_]/gi, "");
  const r = await query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  return { success: true, table, headers: r.rows.map((x) => x.column_name), columns: r.rows };
};

// ── the list the app actually calls ──────────────────────────────────────
// Taken from Code.gs's router, so the two can be compared. If the app grows
// an action, it is added here and the startup check says it is missing.
const EXPECTED = [
  "batch", "staffLogin", "staffLogout", "authStatus", "ping", "debugSheetHeaders",
  "getNextUHID", "checkDuplicate", "saveRegistration", "patientLookup",
  "patientCompleteRegistration", "getPending", "getPatient", "getAllPatients",
  "searchPatients", "getTodaysBirthdays", "getFollowUps",
  "uploadPatientDocument", "getPatientDocuments", "deletePatientDocument",
  "getDocumentCategoriesList", "saveDocumentCategoriesList", "createDocumentPDF",
  "getPatientDocumentContent",
  "getCarePlan", "saveCarePlan", "getTreatmentPlan", "saveTreatmentPlan",
  "getTreatmentProgress", "getClinicalSheets", "saveClinicalSheets",
  "getDailyRegister", "saveToDailyRegister", "getClinicalRecords",
  "savePathology", "saveRadiology", "saveRadiograph", "saveLocalAnesthesia",
  "saveIntraOralScanning", "saveScaling", "saveMinorSurgery", "saveTMJoint",
  "saveRestoration", "saveOrthodontics", "saveOrthodonticsProgress", "saveDenture",
  "savePedo", "saveLabLog",
  "getAppointments", "saveAppointment", "updateAppointmentStatus", "updateAppointment",
  "deleteAppointment", "getReasonsList", "saveReasonsList", "getBlockedSlots",
  "saveBlockedSlot", "deleteBlockedSlot",
  "getProcedureLibrary", "saveProcedureLibrary", "startTreatmentCase", "getOpenCase",
  "getCaseState", "resolveStageOutcome", "appendCaseStage",
  "saveConsent", "getSignatures", "saveSignature",
  "getReceipts", "getRevenueByPatient", "saveReceipt", "getDailyCollection",
  "getPatientOutstanding", "getOutstandingList", "getFinanceSummary", "getProfitLoss",
  "getExpenses", "saveExpense", "deleteExpense",
  "getExpenseCategoriesList", "saveExpenseCategoriesList",
  "getTreatmentsMaster", "saveTreatmentsMaster", "getMedicinesMaster", "saveMedicinesMaster",
  "getImplantBrandsList", "saveImplantBrandsList",
  "getMedicineDosagesList", "saveMedicineDosagesList",
  "getMedicineFrequenciesList", "saveMedicineFrequenciesList",
  "getMedicineDurationsList", "saveMedicineDurationsList",
  "getMedicineInstructionsList", "saveMedicineInstructionsList",
  "getMedicineNotesList", "saveMedicineNotesList",
  "getClinicProfile", "saveClinicProfile", "savePrescription",
  "getDoctorDetailsList", "saveDoctorDetailsList", "getEmployeesList", "saveEmployeesList",
  "getPaymentModesList", "savePaymentModesList", "getPanelRates", "savePanelRates",
  "getPanelsList", "savePanelsList", "getChairsList", "saveChairsList",
  "getCrmData", "saveCrmCollection", "queueCrmLead", "getCrmLeadInbox", "markCrmLeadsTaken",
  "getClinicTimings", "saveClinicTimings", "getWorkingDays", "saveWorkingDays",
  "getClinicalNoteTemplates", "saveClinicalNoteTemplates",
  "getSettings", "saveSettings",
  "saveFinancePassword", "verifyFinancePassword", "saveMasterPassword",
  "verifyMasterPassword", "saveReportsPassword", "verifyReportsPassword",
  "generateSOAPNotes", "chatbotReply", "saveChatbotAppointment", "findAppointmentsByPhone"
];

// "batch" is handled by the router itself, not by an action.
function missingActions() {
  return EXPECTED.filter((a) => a !== "batch" && typeof actions[a] !== "function");
}

module.exports = { actions, EXPECTED, missingActions };
