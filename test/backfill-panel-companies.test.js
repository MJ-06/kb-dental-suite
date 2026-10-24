// The CRM files a panel patient under their panel as a company -- that is
// what separates the CGHS and DGEHS patients from the cash patients instead
// of showing every one of them as "Individual". The queue that carries a
// newly registered patient into the CRM left the company blank, so everyone
// registered between that queue arriving and the fix landed with none.
//
// This backfills those. It writes into the live CRM tabs, so it is not
// checked by reading it -- it is RUN, against a fake Sheets API, and the
// cells it touched are inspected afterwards.
const fs = require("fs");
const path = require("path");
const GS = fs.readFileSync(path.resolve(__dirname, "../apps-script/maintenance/backfill-panel-companies.gs"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

function book(tabs) {
  const sheets = {};
  const mk = (name, grid) => {
    const g = (grid || []).map(r => r.slice());
    return sheets[name] = {
      grid: g,
      getLastRow: () => g.length,
      getLastColumn: () => g.reduce((n, r) => Math.max(n, r.length), 0),
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
  return { sheets,
    ss: { getId: () => "MAIN", getSheetByName: n => sheets[n] || null, insertSheet: n => mk(n, []) } };
}

// The register, as Code.gs hands it over: regAllRows_ merges BOTH books into
// one table, so the script sees the empanelled book's patients too.
const RHEAD = ["Timestamp", "Registration ID", "Full Name", "Panel", "Panel Category", "Card ID"];
function register(rows) {
  return [RHEAD].concat(rows || []);
}
// The real findRegColumn_, so header matching is the app's, not a stand-in.
const CODE_GS = fs.readFileSync(path.resolve(__dirname, "../apps-script/out/Code.gs"), "utf8");
const findRegColumn_ = new Function(
  CODE_GS.slice(CODE_GS.indexOf("function findRegColumn_("),
                CODE_GS.indexOf("\n}", CODE_GS.indexOf("function findRegColumn_(")) + 2) +
  "\nreturn findRegColumn_;")();

function run(bk, which, confirm, reg) {
  const log = [];
  const fn = new Function("SpreadsheetApp", "Logger", "WHICH", "SET_CONFIRM",
    "regAllRows_", "findRegColumn_",
    GS.replace('var CONFIRM = "";', "var CONFIRM = SET_CONFIRM;") +
    "\nif (WHICH === 'report') reportPanelCompanies(); else backfillPanelCompanies();");
  fn({ getActiveSpreadsheet: () => bk.ss, flush() {} },
     { log: (...a) => log.push(String(a[0]).replace(/%s/g, () => String(a.splice(1, 1)[0]))) },
     which, confirm || "",
     reg === null ? undefined : () => (reg || register([])),
     reg === null ? undefined : findRegColumn_);
  return log.join("\n");
}
const tab = (bk, n) => (bk.sheets[n] || { grid: [] }).grid;
const colOf = (bk, n, h) => tab(bk, n)[0].indexOf(h);

// The CRM writes a tab's headers as the union of its records' keys, id first.
//
// This is the shape that actually matters: the contacts were created by the
// FIRST import, before the panel fields were carried across, and an import
// skips a contact it already has -- so their panel cell is blank however many
// times Import Patients is run. The register is where the answer is.
const CHEAD = ["id", "firstName", "lastName", "phone", "uhid", "companyId"];
const base = () => book({
  "CRM Contacts": [
    CHEAD,
    ["c1", "Meera", "Das", "9811000001", "KB0001", "CO_CGHS"],   // already filed
    ["c2", "Rohit", "Khanna", "9811000002", "KB0002", ""],       // CGHS, unfiled
    ["c3", "Asha", "Verma", "9811000003", "KB0003", ""],         // DGEHS, unfiled
    ["c4", "Vikram", "Rao", "9811000004", "KB0004", ""]          // private
  ],
  "CRM Companies": [
    ["id", "name", "industry", "createdAt"],
    ["CO_CGHS", "CGHS", "Panel", "2026-01-01T00:00:00Z"]
  ]
});
const REG = () => register([
  ["2026-01-01", "KB0001", "Meera Das", "CGHS", "Serving", "CG-1"],
  ["2026-01-02", "KB0002", "Rohit Khanna", "CGHS", "Serving", "CG-2"],
  ["2026-01-03", "KB0003", "Asha Verma", "DGEHS", "", "DG-9"],
  ["2026-01-04", "KB0004", "Vikram Rao", "", "", ""]
]);

// ── the fault this had to be rewritten for ───────────────────────────────
// Reading the panel off the contact found nothing, because it is not there.
ok("no contact in this fixture carries a panel at all",
   CHEAD.indexOf("panel") < 0);

// ── it only reads until told twice ───────────────────────────────────────
let bk = base();
let out = run(bk, "report", "", REG());
eq("the report changes nothing", tab(bk, "CRM Contacts")[2][5], "");
ok("it says how many the register puts on a panel", /on a panel: 3/.test(out), out);
ok("and finds the ones filed nowhere, from the register not the contact",
   /On a panel but filed nowhere:     2/.test(out), out);
ok("marking where the panel was read from", /panel read from the register/.test(out), out);
ok("counting the one already filed", /Already filed under a company:    1/.test(out), out);
ok("and the private patient", /no panel, left alone:   1/.test(out), out);
ok("it tells you to close the CRM first", /CLOSE THE CRM/.test(out), out);

bk = base();
out = run(bk, "backfill", "", REG());
eq("running it without CONFIRM changes nothing", tab(bk, "CRM Contacts")[2][5], "");
ok("and says so rather than looking like it worked", /CONFIRM is not set/.test(out), out);

// ── the backfill ─────────────────────────────────────────────────────────
bk = base();
out = run(bk, "backfill", "YES", REG());
const cc = colOf(bk, "CRM Contacts", "companyId");
eq("a CGHS patient goes under the CGHS company that already existed",
   tab(bk, "CRM Contacts")[2][cc], "CO_CGHS");
const dg = tab(bk, "CRM Companies").slice(1).filter(r => r[1] === "DGEHS")[0];
ok("a panel with no company yet gets one", !!dg, JSON.stringify(tab(bk, "CRM Companies")));
eq("marked as a panel, not an ordinary company", dg[2], "Panel");
eq("and the patient on it is filed there", tab(bk, "CRM Contacts")[3][cc], dg[0]);
eq("a contact already filed is left exactly as it was",
   tab(bk, "CRM Contacts")[1][cc], "CO_CGHS");
eq("a private patient is still under no company", tab(bk, "CRM Contacts")[4][cc], "");
eq("no company is invented for the private patient", tab(bk, "CRM Companies").length, 3);

// The panel is written onto the contact too, so the register stops being the
// only thing that knows.
const pc = colOf(bk, "CRM Contacts", "panel");
ok("a panel column is added to the contacts", pc > 0, tab(bk, "CRM Contacts")[0]);
eq("and the panel written onto the patient", tab(bk, "CRM Contacts")[2][pc], "CGHS");
eq("with the category", tab(bk, "CRM Contacts")[2][colOf(bk, "CRM Contacts", "panelCategory")], "Serving");
eq("and the card number", tab(bk, "CRM Contacts")[2][colOf(bk, "CRM Contacts", "cardId")], "CG-2");
// Nothing was written into that cell at all -- the fake grid leaves a short
// row where Sheets would hand back "", and either way it is empty.
ok("the private patient is given no panel", !tab(bk, "CRM Contacts")[4][pc],
   JSON.stringify(tab(bk, "CRM Contacts")[4]));

eq("nothing else in any contact row moved",
   tab(bk, "CRM Contacts").map(r => r.slice(0, 5)),
   base().sheets["CRM Contacts"].grid.map(r => r.slice(0, 5)));
ok("it reports what it did", /Filed 2 patient\(s\) under their panel\./.test(out), out);
ok("and names the company it made", /Made 1 panel company\(ies\): DGEHS/.test(out), out);

// ── running it again ─────────────────────────────────────────────────────
out = run(bk, "backfill", "YES", REG());
ok("a second run finds nothing left to do", /Nothing to do/.test(out), out);
eq("and makes no duplicate company", tab(bk, "CRM Companies").length, 3);

// ── a contact whose panel IS on the record is believed ───────────────────
// Added since the fix: the register need not be consulted for them.
bk = book({
  "CRM Contacts": [["id", "firstName", "uhid", "panel", "companyId"],
                   ["c1", "New", "KB9", "ECHS", ""]],
  "CRM Companies": [["id", "name", "industry", "createdAt"]]
});
run(bk, "backfill", "YES", register([]));
eq("a contact carrying its own panel is filed from that",
   tab(bk, "CRM Companies")[1][1], "ECHS");

// ── the same panel spelled differently is one company ────────────────────
bk = book({
  "CRM Contacts": [CHEAD, ["c1", "A", "A", "", "KB1", ""],
                          ["c2", "B", "B", "", "KB2", ""],
                          ["c3", "C", "C", "", "KB3", ""]],
  "CRM Companies": [["id", "name", "industry", "createdAt"], ["CO_X", "CGHS", "Panel", ""]]
});
run(bk, "backfill", "YES", register([
  ["", "KB1", "A A", "cghs", "", ""], ["", "KB2", "B B", "CGHS", "", ""],
  ["", "KB3", "C C", " Cghs ", "", ""]]));
eq("three spellings of one panel all reach the one existing company",
   tab(bk, "CRM Contacts").slice(1).map(r => r[5]), ["CO_X", "CO_X", "CO_X"]);
eq("and no new company is made", tab(bk, "CRM Companies").length, 2);

bk = book({
  "CRM Contacts": [CHEAD, ["c1", "A", "A", "", "KB1", ""], ["c2", "B", "B", "", "KB2", ""]],
  "CRM Companies": [["id", "name", "industry", "createdAt"]]
});
run(bk, "backfill", "YES", register([
  ["", "KB1", "A A", "ECHS", "", ""], ["", "KB2", "B B", "echs", "", ""]]));
eq("a brand-new panel spelled two ways still makes only one company",
   tab(bk, "CRM Companies").length, 2);
const ids = tab(bk, "CRM Contacts").slice(1).map(r => r[5]);
eq("and both patients go under it", ids[0], ids[1]);
ok("under an id shaped like the CRM's own", /^c[a-z0-9]+$/.test(String(ids[0])), ids[0]);

// ── a re-registered patient ──────────────────────────────────────────────
// NABH re-collection writes a second row. A blank panel on the later row is
// somebody not filling the field in again, not the patient leaving the panel.
bk = book({
  "CRM Contacts": [CHEAD, ["c1", "A", "A", "", "KB5", ""]],
  "CRM Companies": [["id", "name", "industry", "createdAt"]]
});
run(bk, "backfill", "YES", register([
  ["2019-01-01", "KB5", "A A", "CGHS", "Serving", "CG-5"],
  ["2026-01-01", "KB5", "A A", "", "", ""]]));
eq("a later row with a blank panel does not lose the panel",
   tab(bk, "CRM Companies").length, 2);

// ── a companies tab that does not exist yet ──────────────────────────────
bk = book({ "CRM Contacts": [CHEAD, ["c1", "A", "A", "", "KB1", ""]] });
run(bk, "backfill", "YES", register([["", "KB1", "A A", "CGHS", "", ""]]));
eq("a CRM Companies tab is made if the CRM has not made one",
   tab(bk, "CRM Companies")[0], ["id", "name", "industry", "createdAt"]);
eq("and the panel is in it", tab(bk, "CRM Companies")[1][1], "CGHS");

// ── nothing to work with ─────────────────────────────────────────────────
ok("a book with no CRM says so instead of failing",
   /No CRM Contacts tab/.test(run(book({}), "report", "", REG())));
ok("an empty contacts tab says it is empty",
   /no contacts in the CRM yet/.test(run(book({ "CRM Contacts": [CHEAD] }), "report", "", REG())));
ok("a register with no Panel column at all says so",
   /no Panel column/.test(run(base(), "report", "",
     [["Timestamp", "Registration ID", "Full Name"], ["", "KB0002", "Rohit"]])));
ok("pasted away from Code.gs, it says so rather than finding no panels",
   /beside Code\.gs/.test(run(base(), "report", "", null)));

// A patient the register does not know is left alone, not guessed at.
bk = base();
run(bk, "backfill", "YES", register([["", "KB0002", "Rohit Khanna", "CGHS", "", ""]]));
eq("a contact the register has no panel for is left under no company",
   tab(bk, "CRM Contacts")[3][cc], "");

// ── the order it writes in ───────────────────────────────────────────────
// Companies before contacts: a run that stops in between leaves contacts
// unfiled, which running it again finishes. The other order would leave
// contacts pointing at a company that does not exist.
ok("companies are written before the contacts that point at them",
   GS.indexOf("var made = 0;") < GS.indexOf('p.contacts.headers.indexOf("companyId")'));
ok("it refuses to run until it is confirmed", /CONFIRM\).trim\(\).toUpperCase\(\) !== "YES"/.test(GS));
ok("it is for the main book, where the CRM lives", /MAIN PMS book/.test(GS));
ok("and it warns that the CRM overwrites these tabs wholesale",
   /saves a list by writing[\s\S]*whole copy back/.test(GS));
ok("it reads both books, so the empanelled book's patients count",
   /both books are read/i.test(GS));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
