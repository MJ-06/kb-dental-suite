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

// ── the import rule, pulled out and run ───────────────────────────────────
const body = CODE.slice(CODE.indexOf("function importPatientsAsContacts()"),
                        CODE.indexOf("function crmSaveOne("));
const inner = body.slice(body.indexOf("crmAllPatients().then(function(r){"));

// The pieces the rule needs, standing in for the screen around it.
function runImport(patients, state) {
  const st = Object.assign({ contacts: [], companies: [], leads: [], pipelines: [] }, state || {});
  const saved = {};
  let n = 0;
  const sandbox = {
    st,
    uid: () => "id" + (++n),
    nowISO: () => "2026-10-23T00:00:00.000Z",
    persist: (key, _s, data) => { saved[key] = data; },
    upd: patch => { saved._msg = patch.importMsg !== undefined ? patch.importMsg : saved._msg; },
    crmAllPatients: () => Promise.resolve({ ok: true, patients })
  };
  // The body as written, with its one outer call made resolvable.
  const src = inner.slice(0, inner.lastIndexOf("});"));
  const fn = new Function("st", "uid", "nowISO", "persist", "upd", "r",
    src.replace("crmAllPatients().then(function(r){", "").trim());
  fn(sandbox.st, sandbox.uid, sandbox.nowISO, sandbox.persist, sandbox.upd,
     { ok: true, patients });
  return saved;
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

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
