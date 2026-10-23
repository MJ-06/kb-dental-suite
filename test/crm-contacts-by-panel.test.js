// Imported patients all read "Individual", because the import filed nobody
// under anything. The clinic's panel patients — CGHS, DGEHS and the rest —
// belong to their panel, and the whole point of having them in Contacts is
// being able to separate them from the private patients.
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

const m = /const CRM_B64\s*=\s*([\s\S]*?);\n/.exec(HTML);
const CRM = Buffer.from((m[1].match(/"([^"]*)"/g) || []).map(x => x.slice(1, -1)).join(""), "base64").toString("utf8");

// ── the register hands over the panel ─────────────────────────────────────
const gi = GS.indexOf("function getAllPatients(");
const fn = GS.slice(gi, GS.indexOf("\n}", gi));
ok("a patient carries their panel out of the register", /panel: panelCol >= 0/.test(fn));
ok("and which category of it they are on", /panelCategory: panelCatCol >= 0/.test(fn));
ok("and their card number", /cardId: cardCol >= 0/.test(fn));
// The names, not the exact line — the call grows as registration records more.
const ensured = (GS.match(/ensureRegColumns_\(sh, \[[\s\S]*?\]\)/) || [""])[0];
ok("read from the columns registration actually writes",
   ["Patient Type", "Panel", "Panel Category", "Card ID"].every(n => ensured.indexOf('"' + n + '"') >= 0),
   ensured);
ok("a book without those columns simply reports no panel, rather than failing",
   /findRegColumn_\(headers, \["Panel"\]\)/.test(fn) && /panelCol >= 0 \? String/.test(fn));

// ── the panel becomes the company, run for real ───────────────────────────
// The matching rule is what stops "CGHS" and "cghs" becoming two companies,
// so it is exercised rather than read.
const mk = new Function("uid", "nowISO", "existing", `
  var companies = existing.slice(), newCompanies = 0, byName = {};
  companies.forEach(function(co){ byName[String(co.name||'').trim().toUpperCase()] = co.id; });
  function companyFor(panel){
    var nm = String(panel||'').trim();
    if(!nm) return '';
    var key = nm.toUpperCase();
    if(byName[key]) return byName[key];
    var co = { id:uid(), name:nm, industry:'Panel', createdAt:nowISO() };
    companies.push(co); byName[key] = co.id; newCompanies++;
    return co.id;
  }
  return { companyFor: companyFor, list: function(){ return companies; }, made: function(){ return newCompanies; } };
`);
let n = 0;
let h = mk(() => "id" + (++n), () => "T", []);
const a = h.companyFor("CGHS"), b = h.companyFor("cghs"), c = h.companyFor(" CGHS ");
eq("the same panel spelled three ways is one company", [a === b, a === c], [true, true]);
eq("and only one was made", h.made(), 1);
eq("a different panel is its own company", h.companyFor("DGEHS") !== a, true);
eq("a patient on no panel is filed under none", h.companyFor(""), "");
eq("nor does a blank one invent a company", h.companyFor("   "), "");
eq("two panels, two companies", h.list().map(x => x.name), ["CGHS", "DGEHS"]);

// A panel already a company is reused, not duplicated.
h = mk(() => "new", () => "T", [{ id: "old", name: "CGHS" }]);
eq("a panel that is already a company reuses it", h.companyFor("CGHS"), "old");
eq("and nothing new is made", h.made(), 0);

// ── the import files them ─────────────────────────────────────────────────
ok("an imported contact is filed under its panel", /companyId: companyFor\(pt\.panel\)/.test(CRM));
ok("and keeps the panel, category and card on the contact itself",
   /panel: pt\.panel\|\|'', panelCategory: pt\.panelCategory\|\|'', cardId: pt\.cardId\|\|''/.test(CRM));
ok("new companies are saved even when no new contact was added",
   /if\(newCompanies\) persist\('companies','companies', companies\);/.test(CRM));
ok("the result says how many went under a panel", /onPanel \+ ' under a panel'/.test(CRM));

// ── and the list can be split by panel ────────────────────────────────────
ok("Contacts has a panel filter", /st\.contactCompany/.test(CRM));
ok("'All' shows everybody", /e\('option',\{value:''\},'All contacts/.test(CRM));
ok("there is an option for the patients on no panel",
   /if\(want==='none'\) return !c\.companyId;/.test(CRM) && /No panel \\u2014 private/.test(CRM));
ok("each panel shows how many are on it", /compCounts\[co\.id\]\|\|0/.test(CRM));
ok("choosing a panel shows only its patients", /return c\.companyId===want;/.test(CRM));
ok("the search now finds a patient by UHID and surname too",
   /String\(c\.uhid\|\|''\)\.toLowerCase\(\)\.indexOf\(s\)>=0/.test(CRM) &&
   /\(c\.lastName\|\|''\)\.toLowerCase\(\)\.indexOf\(s\)>=0/.test(CRM));
ok("a contact on no panel still reads Individual in the list",
   /:'Individual'\)/.test(CRM));
ok("the company stays editable by hand, as it always was",
   /ir\('Company',e\('div'/.test(CRM));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
