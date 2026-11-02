// A list save used to clear the tab and THEN look at what it had been given.
// If the payload never arrived, or arrived cut short, JSON.parse threw, the
// list came out empty — and the tab had already been emptied. Every doctor,
// every employee, gone, with { success: true } sent back, so the app had
// nothing to show and the loss only surfaced at the next refresh.
//
// The payloads travel in the URL, so this gets likelier as the lists fill up:
// fine while the masters were nearly empty, and not fine once the staff were
// in. The guard is what stops a lost request being read as "delete
// everything"; the POST transport is what stops the request being lost.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const GS = fs.readFileSync(path.join(REPO, "apps-script/out/Code.gs"), "utf8");
const HTML = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

// ── the guard itself, run for real ─────────────────────────────────────────
const parseList_ = new Function(
  GS.slice(GS.indexOf("function parseList_("), GS.indexOf("\n}", GS.indexOf("function parseList_(")) + 2) +
  "\nreturn parseList_;")();

eq("a real list goes through", parseList_('[{"name":"Dr A"}]', "doctor list"), [{ name: "Dr A" }]);
eq("an already-parsed array goes through", parseList_([1, 2], "x"), [1, 2]);
eq("an empty list is allowed — removing the last row is legitimate",
   parseList_("[]", "doctor list"), []);
ok("a missing payload is refused", !!parseList_(undefined, "doctor list").__bad);
ok("an empty string is refused, not read as an empty list",
   !!parseList_("", "doctor list").__bad);
ok("and it says the list never reached the sheet",
   /never reached the sheet/.test(parseList_(undefined, "doctor list").__bad));
ok("a payload cut short in transit is refused",
   !!parseList_('[{"name":"Dr A"},{"na', "doctor list").__bad);
ok("and says so, with how much arrived",
   /cut short in transit/.test(parseList_('[{"name":"Dr A"},{"na', "doctor list").__bad) &&
   /21 characters/.test(parseList_('[{"name":"Dr A"},{"na', "doctor list").__bad));
ok("something that is not a list at all is refused",
   !!parseList_('{"name":"Dr A"}', "doctor list").__bad);

// ── every destructive save is behind it ────────────────────────────────────
const savers = [
  "saveDoctorDetailsList", "saveEmployeesList", "savePanelsList", "saveChairsList",
  "saveImplantBrandsList", "saveTreatmentsMaster", "saveMedicinesMaster",
  "saveClinicalNoteTemplates", "savePaymentModesList", "saveProcedureLibrary",
  "saveReasonsList", "saveExpenseCategoriesList", "saveDocumentCategoriesList",
  "savePanelRates", "saveMedicineDosagesList", "saveMedicineFrequenciesList",
  "saveMedicineDurationsList", "saveMedicineInstructionsList", "saveMedicineNotesList",
];
const bodyOf = n => {
  const i = GS.indexOf("function " + n + "(p) {");
  return i < 0 ? null : GS.slice(i, GS.indexOf("\n}", i));
};
const missing = savers.filter(n => { const b = bodyOf(n); return !b || b.indexOf("parseList_(") < 0; });
eq("every list save parses before it touches the sheet", missing, []);

const wipesFirst = savers.filter(n => {
  const b = bodyOf(n);
  if (!b) return true;
  const clear = b.indexOf("clearContents()");
  const guard = b.indexOf("parseList_(");
  return clear >= 0 && guard > clear;      // guard must come first
});
eq("none of them clears the tab before the payload is checked", wipesFirst, []);

const silent = savers.filter(n => (bodyOf(n) || "").indexOf("success: false") < 0);
eq("and each one reports the refusal instead of claiming success", silent, []);

// The clinic profile is an object rather than a list, but the same rule holds.
const prof = bodyOf("saveClinicProfile") || "";
ok("the clinic profile is not emptied over a lost payload",
   /never reached the sheet/.test(prof) &&
   prof.indexOf("clearContents()") > prof.indexOf("success: false"));

// ── the transport that caused it ───────────────────────────────────────────
const api = HTML.slice(HTML.indexOf("async function apiDirect"),
                       HTML.indexOf("// Every read the app makes goes through here"));
ok("a long payload goes in a POST body, not the URL", /const long = query\.length > 1800;/.test(api));
ok("sent as text/plain, so there is no CORS preflight to fail",
   /"Content-Type": "text\/plain;charset=utf-8"/.test(api));
ok("the body carries the action and the data", /JSON\.stringify\(Object\.assign\(\{ action \}, data/.test(api));
// The token still travels with a long write, but no longer always in the
// body: against the clinic's own server it goes in a header, so it stays out
// of access logs and browser history. Which one is used for which backend is
// proven by running it, in backend-address-is-configuration.test.js; what
// matters here is only that a long write still carries it.
ok("and the session token", /token: tok|token: getSessionToken\(\)/.test(api));
ok("a short request still goes exactly as it did", /: await fetch\(url[,)]/.test(api));
ok("the retry rule is untouched — a write still only retries on 404",
   /if \(!isRead && e\.status !== 404\) break;/.test(api));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
