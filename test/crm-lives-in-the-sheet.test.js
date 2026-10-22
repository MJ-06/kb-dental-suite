// The CRM kept everything — leads, contacts, follow-ups, payments — in one
// browser's local storage and made no backend call at all. A lead taken at
// the front desk was invisible on every other machine, and clearing site data
// threw the lot away with no copy anywhere. It is in the PMS book now.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
const GS = fs.readFileSync(path.join(REPO, "apps-script/out/Code.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

function crm() {
  const m = /const CRM_B64\s*=\s*([\s\S]*?);\n/.exec(HTML);
  const b64 = (m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join("");
  return Buffer.from(b64, "base64").toString("utf8");
}
const CRM = crm();

// ── the backend store, run for real ───────────────────────────────────────
function boot(tabs) {
  const sheets = {};
  const mk = (name, rows) => (sheets[name] = {
    rows: rows || [],
    getLastRow: () => sheets[name].rows.length,
    getDataRange: () => ({ getValues: () => sheets[name].rows }),
    clearContents: () => { sheets[name].rows = []; },
    getRange: () => ({ setValues: v => { sheets[name].rows = v; } }),
  });
  Object.keys(tabs || {}).forEach(n => mk(n, tabs[n]));
  const code = GS.slice(GS.indexOf("function parseList_("), GS.indexOf("function getDocumentCategoriesList(")) +
               GS.slice(GS.indexOf("var CRM_COLLECTIONS"), GS.indexOf("var CLINIC_TIMINGS_TAB"));
  const api = new Function("SpreadsheetApp",
    code + "\nreturn { getCrmData, saveCrmCollection, crmTab_ };")({
      getActiveSpreadsheet: () => ({
        getSheetByName: n => sheets[n] || null,
        insertSheet: n => mk(n, []),
      }),
    });
  return { sheets, api };
}

let e = boot({});
eq("an empty book answers with empty lists, not an error",
   e.api.getCrmData().data.leads, []);

e = boot({});
let res = e.api.saveCrmCollection({ collection: "leads", records: JSON.stringify([
  { id: "l1", title: "Crown enquiry", amount: 12000, stage: "s1", won: false },
  { id: "l2", title: "Implant enquiry", amount: 48000, stage: "s2", won: false, tags: ["urgent", "referral"] },
]) });
eq("a save reports how many it wrote", [res.success, res.count], [true, 2]);
eq("it writes one column per field, id first",
   e.sheets["CRM Leads"].rows[0], ["id", "title", "amount", "stage", "won", "tags"]);
eq("and one row per record",
   e.sheets["CRM Leads"].rows.length, 3);

// The round trip is what matters: what goes in must come back the same.
let back = e.api.getCrmData().data.leads;
eq("a lead comes back exactly as it went in",
   back[0], { id: "l1", title: "Crown enquiry", amount: 12000, stage: "s1", won: false });
eq("including a list stored inside it", back[1].tags, ["urgent", "referral"]);
eq("a field a record never had comes back absent, not as an empty string",
   back[0].tags, undefined);
ok("so the CRM is never handed an empty string where it expects a list",
   back.every(l => l.tags === undefined || Array.isArray(l.tags)));

// A note that merely starts with a brace is a note, not JSON.
e = boot({});
e.api.saveCrmCollection({ collection: "contacts", records: JSON.stringify([
  { id: "c1", name: "A Patient", note: "{not json" },
]) });
eq("text that only looks like JSON is left as text",
   e.api.getCrmData().data.contacts[0].note, "{not json");

eq("an unknown collection is refused",
   boot({}).api.saveCrmCollection({ collection: "secrets", records: "[]" }).success, false);
// The same rule as every other save: a payload that went missing must not be
// read as "delete them all".
res = boot({}).api.saveCrmCollection({ collection: "leads" });
eq("a missing payload is refused rather than emptying the tab", res.success, false);
eq("and one cut short in transit too",
   boot({}).api.saveCrmCollection({ collection: "leads", records: '[{"id":"l' }).success, false);
// Clearing a list deliberately is still allowed.
eq("an empty list is allowed", boot({}).api.saveCrmCollection({ collection: "leads", records: "[]" }).success, true);

ok("every collection the CRM holds has a home",
   ["pipelines","leads","contacts","companies","followups","products","activities","payments","sources"]
     .every(c => boot({}).api.saveCrmCollection({ collection: c, records: "[]" }).success));

// ── the CRM page ──────────────────────────────────────────────────────────
ok("it asks the app to load, rather than reading a browser only it can see",
   /function crmLoadAll\(\)\{ return crmAsk\(\{type:'KB_CRM_LOAD'\}/.test(CRM));
ok("and to save each collection", /function crmSaveOne\(collection, records\)/.test(CRM));
ok("every write goes up, because they all go through persist",
   /function persist\(key,stateKey,data\)\{[\s\S]{0,400}crmSaveOne\(key, data\)/.test(CRM));
ok("the activity log no longer writes straight to the browser",
   !/lsSet\(CK\.activities,list\)/.test(CRM) && /persist\('activities','activities',list\)/.test(CRM));
ok("local storage stays as a cache, so a lost connection is not a blank screen",
   /lsSet\(CK\[key\],data\)/.test(CRM));
ok("a write that does not land says so", /Not saved to the clinic book/.test(CRM));
ok("and a read that fails says so rather than looking like \"no leads yet\"",
   /Could not reach the clinic book/.test(CRM));
ok("the state of the sync is on screen, not only in the console",
   /var syncEl = st\.syncErr/.test(CRM) && /syncEl,/.test(CRM));

// Migration, and the direction that must never reverse.
ok("a first run copies this browser's lists up", /First run — /.test(CRM));
ok("but only when the book is genuinely empty",
   /if\(empty && mine\.length\)\{/.test(CRM));
ok("an unreadable book never overwrites what is here",
   /if\(!\(r && r\.ok && r\.data\)\)\{[\s\S]{0,260}syncState:'local'/.test(CRM));

// ── the app in between ────────────────────────────────────────────────────
const mod = HTML.slice(HTML.indexOf("function CRMModule()"),
                       HTML.indexOf("function CRMModule()") + 3000);
ok("the app answers the CRM's load", /d\.type === "KB_CRM_LOAD"/.test(mod) && /api\("getCrmData"\)/.test(mod));
ok("and its saves", /d\.type === "KB_CRM_SAVE"/.test(mod) && /api\("saveCrmCollection"/.test(mod));
ok("a failed read is reported, not swallowed into an empty CRM",
   /ok: false,[\s\S]{0,120}data: null/.test(mod));
ok("the listener is removed when the screen closes",
   /removeEventListener\("message", onMessage\)/.test(mod));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
