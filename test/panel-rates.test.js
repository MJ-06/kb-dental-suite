// A panel bills by ITS OWN code. CGHS calls an RCT on a single-rooted tooth
// DP030; the clinic calls it something else entirely. Mapping the two would
// mean a translation table that goes wrong the day either side renames
// anything, and a wrong code is a rejected claim — so the panel's list is kept
// whole and separate, and billing picks from it by code.
//
// This runs the real functions against a fake sheet.
const fs = require("fs");
const GS = fs.readFileSync(__dirname + "/../apps-script/out/Code.gs", "utf8");
const checks = [];
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail, want: "truthy" });

class FakeSheet {
  constructor(rows) { this.rows = rows || []; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; }
  clearContents() { this.rows = []; }
  appendRow(v) { this.rows.push(v.slice()); }
  getRange(r, c, nr, nc) {
    const s = this;
    return {
      getValues() { return s.rows.slice(r - 1, r - 1 + nr).map(x => x.slice(c - 1, c - 1 + nc)); },
      setValues(vals) {
        for (let i = 0; i < vals.length; i++) {
          while (s.rows.length < r + i) s.rows.push([]);
          for (let j = 0; j < vals[i].length; j++) s.rows[r - 1 + i][c - 1 + j] = vals[i][j];
        }
      },
    };
  }
}

function slice(from, to) {
  const a = GS.indexOf(from), b = GS.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error("could not slice " + from);
  return GS.slice(a, b);
}
// savePanelRates now refuses a payload that never arrived rather than
// clearing the tab over it, so it needs the shared guard in scope.
const code = slice("function parseList_(", "function getDocumentCategoriesList(") +
             slice("var PANEL_RATES_TAB", "function getPanelsList() {");

function boot(rows) {
  const sheet = new FakeSheet(rows ? rows.slice() : []);
  const props = {};
  const api = new Function("getSheet", "PropertiesService",
    code + "\nreturn { getPanelRates, savePanelRates };")(
    () => sheet,
    { getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; } }) });
  return { api, sheet, props };
}

const RATE = (code, proc, rate) =>
  ({ code: code, procedure: proc, rate: rate, classification: "Dental Procedure" });

// ── an import, read back ────────────────────────────────────────────────────
{
  const e = boot();
  const res = e.api.savePanelRates({ panel: "CGHS", rates: JSON.stringify([
    RATE("DP030", "RCT-Single Rooted tooth", 2000),
    RATE("DP031", "RCT Multiple root and/ canal tooth", 3000),
  ]) });
  ok("an import saves", res.success === true);
  eq("both rows are stored", res.saved, 2);
  const back = e.api.getPanelRates({ panel: "CGHS" });
  eq("and both come back", back.rates.length, 2);
  eq("with the panel's own code", back.rates[0].code, "DP030");
  eq("the panel's own wording", back.rates[0].procedure, "RCT-Single Rooted tooth");
  eq("and the NABH rate, which is what the clinic bills at", back.rates[0].rate, 2000);
}

// ── one panel's import must not wipe another's ─────────────────────────────
{
  const e = boot();
  e.api.savePanelRates({ panel: "CGHS",  rates: JSON.stringify([RATE("DP030", "RCT", 2000)]) });
  e.api.savePanelRates({ panel: "DGEHS", rates: JSON.stringify([RATE("D-1", "RCT", 1800)]) });
  eq("CGHS survives the DGEHS import", e.api.getPanelRates({ panel: "CGHS" }).rates.length, 1);
  eq("and DGEHS is there too", e.api.getPanelRates({ panel: "DGEHS" }).rates.length, 1);

  // Re-importing one panel replaces that panel only.
  e.api.savePanelRates({ panel: "CGHS", rates: JSON.stringify([
    RATE("DP030", "RCT", 2100), RATE("DP031", "RCT multi", 3000)]) });
  eq("a re-import replaces that panel's rates", e.api.getPanelRates({ panel: "CGHS" }).rates.length, 2);
  eq("and still leaves the other panel alone", e.api.getPanelRates({ panel: "DGEHS" }).rates.length, 1);
  eq("the revised rate is the one stored",
     e.api.getPanelRates({ panel: "CGHS" }).rates[0].rate, 2100);
}

// ── a rate with no code cannot be claimed, so it is not stored ─────────────
{
  const e = boot();
  const res = e.api.savePanelRates({ panel: "CGHS", rates: JSON.stringify([
    RATE("DP030", "RCT", 2000),
    { code: "", procedure: "Something with no code", rate: 500 },
  ]) });
  eq("a row without a code is dropped", e.api.getPanelRates({ panel: "CGHS" }).rates.length, 1);
  ok("and the save still succeeds", res.success === true);
}

{
  const e = boot();
  const res = e.api.savePanelRates({ rates: JSON.stringify([RATE("DP030", "RCT", 2000)]) });
  ok("an import with no panel is refused", res.success === false, JSON.stringify(res));
}

let pass = 0, fail = 0;
checks.forEach(c => {
  if (c.ok) { pass++; console.log("  PASS  " + c.name); }
  else { fail++; console.log("  FAIL  " + c.name + "\n          got " + JSON.stringify(c.got) + ", want " + JSON.stringify(c.want)); }
});
console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("==============================================================================");
process.exit(fail ? 1 : 0);
