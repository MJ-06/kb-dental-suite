// Every patient new to the practice should turn up in the CRM as a lead at
// the consultation stage, because that is what a new patient IS: somebody who
// has come in and whose treatment is not yet decided. Before this they landed
// in Contacts and nowhere else, so nothing prompted anyone to follow them up.
//
// Only patients ADDED by an import get one. The existing two and a half
// thousand have been through this already, and a lead apiece would bury the
// board on the day it was switched on.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

const a = html.indexOf("const CRM_B64 =");
const CRM = Buffer.from((html.slice(a, html.indexOf(";\n", a)).match(/"([^"]*)"/g) || [])
  .map(s => s.slice(1, -1)).join(""), "base64").toString("utf8");
// My own comments would otherwise satisfy assertions about the code.
const CODE = CRM.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/^\s*\/\/.*$/gm, "");

// ── the rules, pulled out and run ─────────────────────────────────────────
// Which pipeline and stage, and how a referrer becomes a source, are shared
// by the import and by the patients the desk queues. Both are run here
// against the one copy, so the two paths cannot be checked apart.
const SHARED = CODE.slice(CODE.indexOf("function consultPipeline("),
                          CODE.indexOf("function crmSaveOne("));
// To the import function's own close, not to the next named function -- the
// shared helpers sit between them now.
const IMPORT = (() => {
  const a = CODE.indexOf("function importPatientsAsContacts()");
  return CODE.slice(a, CODE.indexOf("\n  }", a) + 4);
})();
const DRAIN = CODE.slice(CODE.indexOf("function drainLeadInbox("),
                         CODE.indexOf("function toast("));

// The pieces the rules need, standing in for the screen around them.
function sandbox(state, extra) {
  const st = Object.assign({ contacts: [], companies: [], leads: [], pipelines: [] }, state || {});
  const saved = {};
  let n = 0;
  const args = {
    st,
    uid: () => "id" + (++n),
    nowISO: () => "2026-10-23T00:00:00.000Z",
    persist: (key, _s, data) => { saved[key] = data; },
    upd: patch => { if (patch.importMsg !== undefined) saved._msg = patch.importMsg; },
    toast: (msg) => { saved._toast = msg; },
    // Stubbed one level below crmMarkInboxTaken, so the real one runs and the
    // message it actually sends is what gets inspected.
    crmAsk: (msg) => { saved._sent = msg; saved._taken = msg.ids; return Promise.resolve({ ok: true }); }
  };
  return { st, saved, args: Object.assign(args, extra || {}) };
}

function runImport(patients, state) {
  const s = sandbox(state);
  const inner = IMPORT.slice(IMPORT.indexOf("crmAllPatients().then(function(r){"));
  const src = inner.slice(0, inner.lastIndexOf("});"))
    .replace("crmAllPatients().then(function(r){", "").trim();
  const keys = Object.keys(s.args);
  new Function(...keys, "r", SHARED + "\n" + src)(
    ...keys.map(k => s.args[k]), { ok: true, patients });
  return s.saved;
}

// The desk's queue, drained the way a CRM load drains it.
function runDrain(inbox, state) {
  const s = sandbox(state);
  const keys = Object.keys(s.args);
  new Function(...keys, "__inbox", "__loaded",
    SHARED + "\n" + DRAIN + "\nreturn drainLeadInbox(__inbox, __loaded);")(
    ...keys.map(k => s.args[k]), inbox, state || {});
  return s.saved;
}

const PIPE = {
  id: "p_dental", name: "Dental Clinic Service Pipeline",
  stages: [
    { id: "s1", name: "Initial Contact", type: "open" },
    { id: "s2", name: "Consultation Scheduled", type: "open" },
    { id: "s4", name: "Treatment Completed", type: "close" }
  ]
};

// ── a new patient gets a consultation lead ────────────────────────────────
let out = runImport(
  [{ uhid: "KB1001", name: "Ramesh Chandra", mobile: "9811000001" }],
  { pipelines: [PIPE] });
ok("the patient is added as a contact", (out.contacts || []).length === 1);
ok("and a lead is opened for them", (out.leads || []).length === 1, JSON.stringify(out.leads));
const lead = (out.leads || [])[0] || {};
eq("at the consultation stage, not the first stage", lead.stageId, "s2");
eq("on the clinic's pipeline", lead.pipelineId, "p_dental");
eq("carrying their UHID, so it is the same person everywhere", lead.uhid, "KB1001");
eq("and their name, so the board is readable", lead.patientName, "Ramesh Chandra");
ok("titled for what it is", /Consultation/.test(lead.title) && /Ramesh Chandra/.test(lead.title), lead.title);
eq("open, not closed", lead.status, "open");
eq("joined to the contact it was made from", lead.contactId, (out.contacts[0] || {}).id);
ok("the lead and the contact are not the same record", lead.id !== out.contacts[0].id);
eq("with the fields a lead is expected to have", 
   [Array.isArray(lead.notes), typeof lead.customFields, lead.amount, lead.productQty],
   [true, "object", "", "1"]);
ok("and the desk is told", /lead\(s\)/.test(out._msg || ""), out._msg);

// ── it is the stage's NAME that decides, not its id ───────────────────────
// The stages are the clinic's to rename and reorder.
out = runImport([{ uhid: "KB1002", name: "A B", mobile: "9811000002" }], {
  pipelines: [{ id: "p", name: "P", stages: [
    { id: "x9", name: "Enquiry", type: "open" },
    { id: "x3", name: "Consultation booked", type: "open" }] }]
});
eq("a renamed, reordered consultation stage is still found", out.leads[0].stageId, "x3");

out = runImport([{ uhid: "KB1003", name: "C D", mobile: "9811000003" }], {
  pipelines: [{ id: "p", name: "P", stages: [
    { id: "y1", name: "Enquiry", type: "open" },
    { id: "y2", name: "Done", type: "close" }] }]
});
eq("a pipeline with no consultation stage falls back to the first open one",
   out.leads[0].stageId, "y1");

out = runImport([{ uhid: "KB1004", name: "E F", mobile: "9811000004" }], { pipelines: [] });
ok("with no pipeline at all, the contact is still added", (out.contacts || []).length === 1);
ok("and no lead is invented", !(out.leads || []).length);
ok("and the desk is told why rather than left guessing",
   /no pipeline/.test(out._msg || ""), out._msg);

// ── only the NEW ones ─────────────────────────────────────────────────────
out = runImport([
  { uhid: "KB2001", name: "Already Here", mobile: "9811002001" },
  { uhid: "KB2002", name: "Brand New", mobile: "9811002002" }
], { pipelines: [PIPE], contacts: [{ id: "old1", firstName: "Already", lastName: "Here", uhid: "KB2001" }] });
// One already here, one new: the contact list ends at two, not three.
eq("a patient already in the CRM is not added again",
   (out.contacts || []).map(c => c.uhid), ["KB2001", "KB2002"]);
eq("and gets no second lead", (out.leads || []).map(l => l.uhid), ["KB2002"]);

// Running the import twice must not double the board.
const first = runImport([{ uhid: "KB3001", name: "Once Only", mobile: "9811003001" }], { pipelines: [PIPE] });
const second = runImport([{ uhid: "KB3001", name: "Once Only", mobile: "9811003001" }],
  { pipelines: [PIPE], contacts: first.contacts, leads: first.leads });
ok("importing again opens nothing further", !(second.leads || []).length,
   JSON.stringify(second.leads));

// ── the referrer comes across as the source ───────────────────────────────
const sourceOf = (pt) => runImport([Object.assign({ uhid: "KB4000", name: "S T", mobile: "9811004000" }, pt)],
  { pipelines: [PIPE] }).leads[0].source;
eq("a patient's referral", sourceOf({ referredByType: "Patient", referredBy: "Sunita" }),
   "Word of Mouth / Referral");
eq("a doctor's", sourceOf({ referredByType: "Doctor", referredBy: "Dr Mehra" }), "Doctor Referral");
eq("a staff member's, which the user asked for by name",
   sourceOf({ referredByType: "Staff", referredBy: "Reception" }), "Staff Referral");
eq("the PR people's, likewise", sourceOf({ referredByType: "PR / Marketing", referredBy: "Agency" }),
   "PR / Marketing");
eq("somebody who is none of those", sourceOf({ referredByType: "Other", referredBy: "X" }), "Referral");
eq("and a patient nobody classified is not credited to anyone",
   sourceOf({}), "Patient register");

const withRef = runImport(
  [{ uhid: "KB5001", name: "U V", mobile: "9811005001", referredByType: "Doctor", referredBy: "Dr Mehra" }],
  { pipelines: [PIPE] });
eq("the referrer's name is kept on the lead, not just their kind",
   [withRef.leads[0].referredBy, withRef.leads[0].referredByType], ["Dr Mehra", "Doctor"]);
eq("and on the contact too", 
   [withRef.contacts[0].referredBy, withRef.contacts[0].referredByType], ["Dr Mehra", "Doctor"]);
eq("the contact's source matches the lead's, so the two reports agree",
   withRef.contacts[0].source, withRef.leads[0].source);

// ── the panel behaviour it already had must survive ───────────────────────
out = runImport([{ uhid: "KB6001", name: "W X", mobile: "9811006001", panel: "CGHS" }],
  { pipelines: [PIPE] });
ok("a panel patient still becomes a company", (out.companies || []).length === 1,
   JSON.stringify(out.companies));
ok("and is still filed under it", !!out.contacts[0].companyId);
ok("while also getting their consultation lead", (out.leads || []).length === 1);


// ── registering a patient is what opens the lead, not a button ────────────
// The whole point. Before this, a lead only appeared when somebody
// remembered to press Import Patients, so "every new patient" was not true.

// The desk queues; it does not write CRM Leads itself. Saving a collection
// clears the tab and writes the whole list back, so a lead added from
// outside while the CRM is open would be wiped by its next save.
ok("the desk queues a lead when a patient is registered",
   /function queueConsultationLead\(patient\)/.test(html));
ok("from the quick registration",
   /queueConsultationLead\(\{\s*uhid: newUhid/.test(html));
ok("and from the full form",
   /if \(!isEditing\) queueConsultationLead\(/.test(html));
ok("but not when an existing record is merely being corrected",
   /!isEditing/.test(html.slice(html.indexOf("queueConsultationLead({\n        uhid, name: P.name")  - 200,
                                html.indexOf("queueConsultationLead({\n        uhid, name: P.name"))));
ok("the queueing never blocks or fails the registration",
   /Promise\.resolve\(api\("queueCrmLead", patient\)\)\.catch/.test(html));
ok("the queue rides on the load the CRM already makes",
   /leadInbox: \(r && r\.leadInbox\) \|\| \[\]/.test(html));

const PIPE2 = PIPE;
const QUEUED = { id: "li1", uhid: "KB7001", name: "Priya Nair", mobile: "9811007001" };

let d = runDrain([QUEUED], { pipelines: [PIPE2] });
eq("a queued patient becomes a lead with no button pressed",
   (d.leads || []).map(l => l.uhid), ["KB7001"]);
eq("at the consultation stage", d.leads[0].stageId, "s2");
ok("and a contact is made for them, since registration gets there first",
   (d.contacts || []).length === 1, JSON.stringify(d.contacts));
eq("the lead points at that contact", d.leads[0].contactId, d.contacts[0].id);
ok("the screen says so", /Consultation/.test(d._toast || ""), d._toast);
eq("and the queue entry is stamped taken", d._taken, ["li1"]);
eq("over the message the host listens for", d._sent.type, "KB_CRM_INBOX_TAKEN");

// Stamping only after the leads are written: a failure leaves them queued.
const order = [];
(() => {
  const s = sandbox({ pipelines: [PIPE2] });
  s.args.persist = (k, _x, v) => { order.push("persist:" + k); };
  s.args.crmAsk = () => { order.push("taken"); return Promise.resolve({ ok: true }); };
  const keys = Object.keys(s.args);
  new Function(...keys, "__inbox", "__loaded",
    SHARED + "\n" + DRAIN + "\nreturn drainLeadInbox(__inbox, __loaded);")(
    ...keys.map(k => s.args[k]), [QUEUED], { pipelines: [PIPE2] });
})();
eq("the leads are written before the queue is stamped, not after",
   order[order.length - 1], "taken");

// ── it must not double up with the import ────────────────────────────────
d = runDrain([QUEUED], {
  pipelines: [PIPE2],
  leads: [{ id: "L1", uhid: "KB7001", stageId: "s2" }],
  contacts: [{ id: "C1", uhid: "KB7001" }]
});
ok("a patient an import already gave a lead does not get a second one",
   !(d.leads || []).length, JSON.stringify(d.leads));
ok("nor a second contact", !(d.contacts || []).length);
eq("and is still stamped taken, so it stops being looked at", d._taken, ["li1"]);

d = runDrain([QUEUED, { id: "li2", uhid: "KB7001", name: "Priya Nair" }], { pipelines: [PIPE2] });
eq("the same patient queued twice gets one lead", (d.leads || []).length, 1);
eq("and both entries are cleared", d._taken, ["li1", "li2"]);

// An existing contact is reused rather than duplicated.
d = runDrain([QUEUED], { pipelines: [PIPE2], contacts: [{ id: "C9", uhid: "KB7001" }] });
ok("an existing contact is reused", !(d.contacts || []).length);
eq("and the lead points at it", d.leads[0].contactId, "C9");

// ── nowhere to put them ──────────────────────────────────────────────────
d = runDrain([QUEUED], { pipelines: [] });
ok("with no pipeline the patient stays queued rather than being lost",
   !(d.leads || []).length && !d._taken, JSON.stringify(d._taken));

d = runDrain([], { pipelines: [PIPE2] });
ok("an empty queue does nothing at all", !d._taken && !(d.leads || []).length);

// ── the referrer survives the queue ──────────────────────────────────────
d = runDrain([{ id: "li3", uhid: "KB7002", name: "R S", referredByType: "Staff", referredBy: "Reception" }],
             { pipelines: [PIPE2] });
eq("a staff referral is credited to staff", d.leads[0].source, "Staff Referral");
eq("with the name kept", d.leads[0].referredBy, "Reception");
eq("the contact agrees with the lead", d.contacts[0].source, "Staff Referral");

// Both paths must produce the same source for the same referral.
const viaImport = runImport([{ uhid: "KB8001", name: "T U", referredByType: "Doctor", referredBy: "Dr A" }],
                            { pipelines: [PIPE2] }).leads[0];
const viaDesk = runDrain([{ id: "li4", uhid: "KB8002", name: "V W", referredByType: "Doctor", referredBy: "Dr A" }],
                         { pipelines: [PIPE2] }).leads[0];
eq("a referral means the same thing whichever way the patient reached the CRM",
   [viaDesk.source, viaDesk.stageId], [viaImport.source, viaImport.stageId]);


// ── a panel patient must not land as "Individual" ────────────────────────
// The point of the panel field on the registration form: CGHS and DGEHS
// patients are separable from the cash patients in the CRM. The drain used
// to set companyId:'' outright, so every panel patient registered at the
// desk showed under Company as Individual -- the one thing it exists to stop.
let pd = runDrain([{ id: "li9", uhid: "KB9100", name: "Meera Das", panel: "CGHS",
                     panelCategory: "Serving", cardId: "CG-77" }], { pipelines: [PIPE2] });
eq("the panel becomes a company", (pd.companies || []).map(c => c.name), ["CGHS"]);
eq("marked as a panel, not an ordinary company", pd.companies[0].industry, "Panel");
ok("and the patient is filed under it, not left as an individual",
   pd.contacts[0].companyId === pd.companies[0].id,
   JSON.stringify({ on: pd.contacts[0].companyId, co: pd.companies[0].id }));
eq("the panel, category and card stay on the contact as well",
   [pd.contacts[0].panel, pd.contacts[0].panelCategory, pd.contacts[0].cardId],
   ["CGHS", "Serving", "CG-77"]);

// A panel the CRM already knows is reused, not duplicated.
pd = runDrain([{ id: "li10", uhid: "KB9101", name: "T Iyer", panel: "cghs" }],
              { pipelines: [PIPE2], companies: [{ id: "CO1", name: "CGHS", industry: "Panel" }] });
ok("a panel already on file is reused however it is typed", !(pd.companies || []).length,
   JSON.stringify(pd.companies));
eq("and the patient goes under the existing one", pd.contacts[0].companyId, "CO1");

// Two panel patients in one drain share the one company.
pd = runDrain([{ id: "li11", uhid: "KB9102", name: "A A", panel: "DGEHS" },
               { id: "li12", uhid: "KB9103", name: "B B", panel: "DGEHS" }], { pipelines: [PIPE2] });
eq("two patients on one panel make one company", (pd.companies || []).length, 1);
eq("and both go under it",
   pd.contacts.map(c => c.companyId), [pd.companies[0].id, pd.companies[0].id]);

// A private patient has no company, which is what makes the split mean
// something.
pd = runDrain([{ id: "li13", uhid: "KB9104", name: "C C" }], { pipelines: [PIPE2] });
eq("a private patient is filed under no company", pd.contacts[0].companyId, "");
ok("and no company is invented for them", !(pd.companies || []).length);

// The import path must still behave the same way.
const pi = runImport([{ uhid: "KB9200", name: "D D", panel: "CGHS" }], { pipelines: [PIPE2] });
eq("the import files a panel patient the same way",
   pi.contacts[0].companyId, (pi.companies || []).filter(c => c.name === "CGHS")[0].id);

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
