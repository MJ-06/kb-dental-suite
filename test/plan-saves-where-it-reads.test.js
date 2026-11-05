// "The endorsement saved did not show in the record section where it had to
//  be clicked for further process."
//
// It saved. getTreatmentPlan returns the LAST row for a patient — it scans
// backwards — and saveTreatmentPlan updated the FIRST. A patient with more
// than one row in the Treatment Plans tab therefore had their plan written
// to one row and read back from another: the save reported success, the
// screen that reloaded showed the older plan, and the endorsement never
// reached Records.
//
// A write that is never read is invisible to any test that only exercises
// one of them, which is how this survived. So both are run here, against
// the same fake sheet, in the order the clinic uses them.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; } else {
    fail++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : ''));
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));

const src = gs.slice(gs.indexOf('function getTreatmentPlan(p) {'),
                     gs.indexOf('// ════════════════════════════════════════════════════════════\n// CGHS BILLS'));
ok('the plan functions were found', src.length > 400, src.length);

const HEAD = ["UHID", "Patient Name", "Date", "Rows", "Estimate", "Saved At"];
const make = (rows) => {
  const sheet = {
    _rows: [HEAD.slice()].concat(rows.map(r => r.slice())),
    getLastRow() { return this._rows.length; },
    getDataRange() { const r = this._rows; return { getValues: () => r.map(x => x.slice()) }; },
    getRange(row, col, n, width) {
      const self = this;
      return { setValues: (vals) => { self._rows[row - 1] = vals[0].slice(); } };
    },
    appendRow(r) { this._rows.push(r.slice()); }
  };
  const ctx = {
    getSheet: () => sheet,
    safeJSON: (v) => typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v),
    safeParseJSON: (v) => { try { return JSON.parse(v); } catch (e) { return null; } },
    Date, Number, String, JSON
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, sheet };
};

// ── the case that broke: two rows for one patient ───────────────────────
// This is an ordinary state. Every earlier code path that appended rather
// than updated leaves one behind, and the tab keeps them.
let { ctx, sheet } = make([
  ['AL1010', 'Santosh', '01-11-2026', '[{"procedure":"old"}]', '{}', 'older'],
  ['AL1010', 'Santosh', '02-11-2026', '[{"procedure":"newer"}]', '{}', 'newer']
]);
ctx.saveTreatmentPlan({
  uhid: 'AL1010', patientName: 'Santosh', date: '04-11-2026',
  rows: '[{"procedure":"Flap Surgery","selected":true,"endAdded":true,"cghsCode":"DP007"}]',
  estimate: '{}'
});
const back = ctx.getTreatmentPlan({ uhid: 'AL1010' });
eq('what was just saved is what comes back', back.rows[0].procedure, 'Flap Surgery');
eq('and it carries the endorsement marks Records looks for',
   [back.rows[0].selected, back.rows[0].endAdded, back.rows[0].cghsCode],
   [true, true, 'DP007']);
eq('no row was added — the patient still has two', sheet._rows.length, 3);
eq('and the untouched one was left alone',
   JSON.parse(sheet._rows[1][3])[0].procedure, 'old');

// ── saving twice keeps hitting the same row ─────────────────────────────
ctx.saveTreatmentPlan({ uhid: 'AL1010', patientName: 'Santosh', date: '05-11-2026',
                        rows: '[{"procedure":"second save"}]', estimate: '{}' });
eq('a second save lands on the same row, not a new one', sheet._rows.length, 3);
eq('and reads back as itself',
   ctx.getTreatmentPlan({ uhid: 'AL1010' }).rows[0].procedure, 'second save');

// ── the ordinary cases still work ───────────────────────────────────────
const fresh = make([]);
fresh.ctx.saveTreatmentPlan({ uhid: 'AL2020', patientName: 'Asha', date: '04-11-2026',
                              rows: '[{"procedure":"first"}]', estimate: '{}' });
eq('a patient with no plan gets one', fresh.sheet._rows.length, 2);
eq('and it reads back', fresh.ctx.getTreatmentPlan({ uhid: 'AL2020' }).rows[0].procedure, 'first');
eq('a patient who has never been saved reads as empty, not as an error',
   fresh.ctx.getTreatmentPlan({ uhid: 'NOBODY' }), { success: true, rows: null, estimate: null });

const other = make([['AL1', 'A', 'd', '[]', '{}', '']]);
other.ctx.saveTreatmentPlan({ uhid: 'AL2', patientName: 'B', date: 'd',
                              rows: '[{"procedure":"b"}]', estimate: '{}' });
eq('another patient’s plan is not overwritten',
   other.ctx.getTreatmentPlan({ uhid: 'AL1' }).rows, []);
eq('and the new one is its own row', other.sheet._rows.length, 3);

// UHIDs are matched the way they are everywhere else in this file.
const cased = make([['al1010', 'S', 'd', '[]', '{}', '']]);
cased.ctx.saveTreatmentPlan({ uhid: 'AL1010', patientName: 'S', date: 'd',
                             rows: '[{"procedure":"x"}]', estimate: '{}' });
eq('a UHID in the other case is the same patient, not a new row', cased.sheet._rows.length, 2);

// ── the two have to agree, in the source, on which row that is ──────────
ok('the save scans the same way the read does',
   /\/\/ BACKWARDS, because getTreatmentPlan reads backwards/.test(gs) &&
   /for \(var i = data\.length - 1; i >= 1; i--\) \{\n    if \(String\(data\[i\]\[0\]\)\.trim\(\)\.toUpperCase\(\) === uhid\) \{\n      sh\.getRange/.test(gs));

const required = (/const KB_BACKEND_BUILD_REQUIRED = "([^"]+)"/.exec(
  fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')) || [])[1];
const build = (/var BACKEND_BUILD = "([^"]+)"/.exec(gs) || [])[1];
ok('the fixed backend is there to deploy', build >= '2026-11-04a', build);
ok('and the app never asks for a build Code.gs does not have', required <= build,
   required + ' vs ' + build);

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
