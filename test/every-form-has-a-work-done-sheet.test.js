// Only four forms had a work-done sheet. The other fourteen showed nothing —
// not because of anything about those forms, but because the record view
// fetches a patient's past rows only for forms listed in CS_RECORD_TAB, and
// they were not in it. Everything else — the A4 layout, the four-to-a-sheet
// paging, the print button — was already general.
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

const TABS = new Function(
  HTML.slice(HTML.indexOf("const CS_RECORD_TAB = {"),
             HTML.indexOf("};", HTML.indexOf("const CS_RECORD_TAB = {")) + 2) +
  "\nreturn CS_RECORD_TAB;")();

// The forms the app actually offers, read out of the form list itself so a
// new form cannot be added without this test noticing it has no sheet.
const formsBlock = HTML.slice(HTML.indexOf("const FORMS = ["));
const FORM_IDS = [...formsBlock.slice(0, formsBlock.indexOf("\n  ];")).matchAll(/\bid:"(\w+)",\s*label:"/g)]
  .map(m => m[1]);

eq("every form in the app is accounted for", FORM_IDS.length, 18);
const without = FORM_IDS.filter(id => !TABS[id]);
eq("and every one of them has a work-done sheet", without, []);

// The tab each form writes into, taken from the form's own save message, is
// the tab its sheet must read. A mismatch here is a silently empty sheet.
const SAVE_TABS = {};
for (const m of HTML.matchAll(/saveAction:'(\w+)', *tabName:'([^']+)'/g)) SAVE_TABS[m[1]] = m[2];
const ACTION_OF = {
  scaling: "saveScaling", minorSurgery: "saveMinorSurgery", tmJoint: "saveTMJoint",
  intraOral: "saveIntraOralScanning", orthodontics: "saveOrthodontics",
  orthoProgress: "saveOrthodonticsProgress", denture: "saveDenture",
  restoration: "saveRestoration", pedo: "savePedo", pathology: "savePathology",
  radiology: "saveRadiology", radiograph: "saveRadiograph",
  localAnesthesia: "saveLocalAnesthesia", labLog: "saveLabLog",
};
const wrongTab = Object.keys(ACTION_OF).filter(id => {
  const saved = SAVE_TABS[ACTION_OF[id]];
  return saved && TABS[id] && TABS[id].tab !== saved;
});
eq("each sheet reads the same tab its form writes to", wrongTab, []);

// Every column named must actually be written by the backend, or the row
// prints blank forever and nobody can tell why.
const backendCols = (action) => {
  const i = GS.indexOf("function " + action + "(p)");
  if (i < 0) return null;
  const body = GS.slice(i, GS.indexOf("\n}", i));
  return (body.match(/"([^"]+)":/g) || []).map(x => x.slice(1, -2));
};
const badCol = [], badDate = [];
Object.keys(ACTION_OF).forEach(id => {
  const cols = backendCols(ACTION_OF[id]);
  if (!cols) return;
  const cfg = TABS[id];
  if (cfg.col && cols.indexOf(cfg.col) < 0) badCol.push(id + ":" + cfg.col);
  // Timestamp is written by saveClinicalRecord for every tab, not by the
  // per-form saver, so it is always available.
  if (cfg.date !== "Timestamp" && cols.indexOf(cfg.date) < 0) badDate.push(id + ":" + cfg.date);
});
eq("every site column exists in the sheet the form writes", badCol, []);
eq("every date column exists in the sheet the form writes", badDate, []);
ok("and Timestamp really is written for every tab",
   /var hdrs = \["Timestamp"\]\.concat/.test(GS));

// Scaling and TM Joint record the mouth, not a tooth.
eq("a form with no site has no site column configured",
   ["scaling", "tmJoint", "orthoProgress"].filter(id => TABS[id].col), []);
ok("and the printed sheet skips that row rather than ruling an empty one",
   /if \(tabCfg\.col\) body \+= line\(tabCfg\.col/.test(HTML));
ok("as does the on-screen one",
   /tabCfg\.col \? r\(tabCfg\.col, row => row\[tabCfg\.col\], true\) : null/.test(HTML));

// It is a work-done sheet now, on every form, as the clinic calls it.
ok("the printed page is titled a work-done sheet",
   /crPage\(\(tabCfg\.tab \|\| ""\) \+ " Work Done Sheet"/.test(HTML));
ok("and so is the one built from a form's own record",
   /crPage\(\(sheetType \|\| ""\) \+ " Work Done Sheet"/.test(HTML));
ok("the button says so too", !/Print Clinical Record/.test(HTML) && /Print Work Done Sheet/.test(HTML));

// The shape the clinic asked for, unchanged from RCT.
ok("four to a sheet, as the paper pad has", /CS_COLS_PER_SHEET/.test(HTML));
ok("drawn on A4", /size:A4/.test(HTML) || /@page/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
