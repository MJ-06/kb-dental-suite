// Registration cannot write CRM Leads itself. The CRM saves a collection by
// clearing the tab and writing its whole list back, so a lead appended from
// outside while the CRM is open would be wiped by its next save. The desk
// appends to an inbox the CRM never rewrites wholesale, and the CRM drains it.
// One writer per tab.
//
// These are the sheet-side halves, run against a fake Sheets API.
const fs = require("fs");
const path = require("path");
const GS = fs.readFileSync(path.resolve(__dirname, "../apps-script/out/Code.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

// A spreadsheet just real enough for these three functions.
function book(tabs) {
  const sheets = {};
  const mk = (name, grid) => {
    const g = (grid || []).map(r => r.slice());
    const width = () => g.reduce((n, r) => Math.max(n, r.length), 0);
    return sheets[name] = {
      grid: g,
      getLastRow: () => g.length,
      getLastColumn: () => width(),
      getDataRange: () => ({ getValues: () => g.map(r => r.slice()) }),
      appendRow: row => g.push(row.slice()),
      getRange(r, c, nR, nC) {
        return {
          getValues: () => {
            const out = [];
            for (let i = r; i < r + (nR || 1); i++) {
              const line = [];
              for (let j = c; j < c + (nC || 1); j++) line.push((g[i - 1] || [])[j - 1] || "");
              out.push(line);
            }
            return out;
          },
          setValue(v) { while (!g[r - 1]) g.push([]); while (g[r - 1].length < c) g[r - 1].push(""); g[r - 1][c - 1] = v; },
          setValues(vals) {
            vals.forEach((line, ri) => {
              const i = r - 1 + ri;
              while (!g[i]) g.push([]);
              while (g[i].length < c - 1 + line.length) g[i].push("");
              line.forEach((v, ci) => { g[i][c - 1 + ci] = v; });
            });
          }
        };
      }
    };
  };
  Object.keys(tabs || {}).forEach(n => mk(n, tabs[n]));
  return {
    sheets,
    ss: {
      getId: () => "BOOK",
      getSheetByName: n => sheets[n] || null,
      insertSheet: n => mk(n, [])
    }
  };
}

// The real functions, with only the Apps Script globals stubbed.
const NEED = ["CRM_LEAD_INBOX_TAB", "CRM_LEAD_INBOX_HEADERS", "crmLeadInboxSheet_",
              "crmLeadInboxRows_", "queueCrmLead", "markCrmLeadsTaken"];
function slice(name) {
  const marks = ["var " + name + " =", "function " + name + "("];
  for (const m of marks) {
    const i = GS.indexOf(m);
    if (i < 0) continue;
    if (m.charAt(0) === "v") return GS.slice(i, GS.indexOf(";\n", i) + 1);
    return GS.slice(i, GS.indexOf("\n}", i) + 2);
  }
  throw new Error("not found: " + name);
}
const SRC = NEED.map(slice).join("\n");
NEED.forEach(n => ok("Code.gs still defines " + n, SRC.indexOf(n) >= 0));
// parseList_ is the guard that refuses a truncated payload rather than acting
// on half of it; markCrmLeadsTaken leans on it, so the real one comes too.
const PARSE = slice("parseList_");

function run(bk, fn, arg) {
  const api = new Function("SpreadsheetApp", "Utilities", "__fn", "__arg",
    PARSE + "\n" + SRC + "\nreturn ({queueCrmLead:queueCrmLead, markCrmLeadsTaken:markCrmLeadsTaken, rows:crmLeadInboxRows_})[__fn](__arg);");
  return api({ getActiveSpreadsheet: () => bk.ss, flush() {} }, {}, fn, arg);
}
const inbox = bk => (bk.sheets["CRM Lead Inbox"] || { grid: [] }).grid;

// ── queueing ──────────────────────────────────────────────────────────────
let bk = book({});
let r = run(bk, "queueCrmLead", { uhid: "KB0001", name: "Asha Verma", mobile: "9811000001" });
ok("a patient can be queued into a book that has no inbox yet", r.success && r.queued, JSON.stringify(r));
eq("the tab is created with its headings", inbox(bk)[0][0], "id");
eq("and the patient is the one row under them", inbox(bk).length, 2);
const head = inbox(bk)[0], row = inbox(bk)[1];
const col = n => head.indexOf(n);
eq("carrying their UHID", row[col("uhid")], "KB0001");
eq("their name", row[col("name")], "Asha Verma");
eq("their number", row[col("mobile")], "9811000001");
eq("and nothing in takenAt until the CRM has had it", row[col("takenAt")], "");
ok("stamped with when it was queued", /^\d{4}-/.test(String(row[col("createdAt")])), row[col("createdAt")]);
ok("and given an id the CRM can stamp back", !!String(row[col("id")]).trim());

// ── the referrer rides along ─────────────────────────────────────────────
bk = book({});
run(bk, "queueCrmLead", { uhid: "KB0002", name: "B C", referredBy: "Dr Mehra", referredByType: "Doctor" });
eq("the referrer's name is queued", inbox(bk)[1][col("referredBy")], "Dr Mehra");
eq("and their kind, which is what the source report needs",
   inbox(bk)[1][col("referredByType")], "Doctor");

bk = book({});
run(bk, "queueCrmLead", { uhid: "KB0003", name: "D E", panel: "CGHS", panelCategory: "Serving", cardId: "C-1" });
eq("a panel patient's panel is queued too", inbox(bk)[1][col("panel")], "CGHS");

// ── queued once ──────────────────────────────────────────────────────────
bk = book({});
run(bk, "queueCrmLead", { uhid: "KB0004", name: "F G" });
r = run(bk, "queueCrmLead", { uhid: "KB0004", name: "F G" });
eq("the same patient is not queued twice", inbox(bk).length, 2);
ok("and the second attempt says so rather than failing", r.success && !r.queued, JSON.stringify(r));

// A patient re-registered after a long gap is the same person coming back.
// NABH asks for their details afresh; it does not make them a new patient.
bk = book({ "CRM Lead Inbox": [
  ["id", "uhid", "name", "mobile", "panel", "panelCategory", "cardId", "referredBy", "referredByType", "createdAt", "takenAt"],
  ["li1", "KB0005", "H I", "", "", "", "", "", "", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]
] });
r = run(bk, "queueCrmLead", { uhid: "KB0005", name: "H I" });
ok("a patient already taken is not queued again by a re-registration",
   r.success && !r.queued, JSON.stringify(r));
eq("so nothing is added", inbox(bk).length, 2);

// ── nothing to queue ─────────────────────────────────────────────────────
bk = book({});
r = run(bk, "queueCrmLead", { uhid: "", name: "" });
ok("a row with neither a UHID nor a name is refused", !r.success, JSON.stringify(r));
bk = book({});
r = run(bk, "queueCrmLead", { uhid: "", name: "Walk In" });
ok("but a name with no UHID is still worth queueing", r.success && r.queued);

// ── stamping taken ───────────────────────────────────────────────────────
bk = book({ "CRM Lead Inbox": [
  ["id", "uhid", "name", "mobile", "panel", "panelCategory", "cardId", "referredBy", "referredByType", "createdAt", "takenAt"],
  ["li1", "KB1001", "J K", "", "", "", "", "", "", "2026-01-01T00:00:00Z", ""],
  ["li2", "KB1002", "L M", "", "", "", "", "", "", "2026-01-01T00:00:00Z", ""],
  ["li3", "KB1003", "N O", "", "", "", "", "", "", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]
] });
r = run(bk, "markCrmLeadsTaken", { ids: JSON.stringify(["li1"]) });
eq("only the entry named is stamped", r.marked, 1);
ok("and it now carries a time", /^\d{4}-/.test(String(inbox(bk)[1][10])), inbox(bk)[1][10]);
eq("the one not named is left for next time", inbox(bk)[2][10], "");
eq("and one already taken is not re-stamped",
   inbox(bk)[3][10], "2026-01-02T00:00:00Z");

r = run(bk, "markCrmLeadsTaken", { ids: JSON.stringify([]) });
ok("stamping nothing is not an error", r.success && r.marked === 0, JSON.stringify(r));
r = run(bk, "markCrmLeadsTaken", { ids: "not json at all" });
ok("a payload that did not arrive whole is refused, not acted on half",
   !r.success, JSON.stringify(r));

// ── what the CRM is handed ───────────────────────────────────────────────
const gcd = GS.slice(GS.indexOf("function getCrmData()"), GS.indexOf("\n}", GS.indexOf("function getCrmData()")));
const waiting = slice("crmLeadsWaiting_");
ok("the queue rides on the load the CRM already makes, so opening it is one call",
   /leadInbox: crmLeadsWaiting_\(\)/.test(gcd), gcd);
ok("only the entries nobody has turned into a lead yet",
   /if \(String\(r\.takenAt \|\| ""\)\.trim\(\)\) return;/.test(waiting));
ok("and an unreadable inbox does not stop the CRM loading everything else",
   /catch \(e\) \{\s*waiting = \[\];/.test(waiting), waiting.slice(-300));

// Asked for again every minute while the screen is open, so it is its own
// action: reloading all nine collections on a timer to find out whether one
// patient walked in would not be quick on a clinic's register.
ok("the waiting list can be read on its own, without the rest",
   /function getCrmLeadInbox\(\)/.test(GS));
ok("and it is routed", /case "getCrmLeadInbox":\s+return getCrmLeadInbox\(\);/.test(GS));
ok("reading just the waiting list touches no other collection",
   slice("getCrmLeadInbox").indexOf("CRM_COLLECTIONS") < 0);

// ── reachable from the app ───────────────────────────────────────────────
ok("queueCrmLead is routed", /case "queueCrmLead":\s+return queueCrmLead\(p\);/.test(GS));
ok("markCrmLeadsTaken is routed", /case "markCrmLeadsTaken":\s+return markCrmLeadsTaken\(p\);/.test(GS));
ok("neither is public — they touch patient data",
   GS.slice(GS.indexOf("var PUBLIC_ACTIONS"), GS.indexOf("function authRequired_"))
     .indexOf("CrmLead") < 0);

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
