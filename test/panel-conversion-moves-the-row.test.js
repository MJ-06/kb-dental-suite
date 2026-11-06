// "We have got old patients ... they were CGHS patients ... since now we
//  have CGHS panel I updated their record to panel patients and in front end
//  it is showing all the data entered in Panel but when I am opening the
//  google sheet I am not seeing that patient in empanelled sheet."
//
// saveRegistration updates a patient where they ALREADY live, whichever book
// that is. That rule is what stops the iPad form — which knows nothing about
// panels — writing a second row for a panel patient into the main book and
// splitting one patient across two. Right for an edit; wrong for a
// conversion. An old patient marked onto a panel kept their row in the main
// book, so the panel columns were saved (which is why the app showed them)
// and the panel book never heard of them.
//
// The move is run here against fake sheets, because the two things that can
// go wrong — losing the patient, and filing a value under the wrong column —
// are invisible to any test that only reads the source.
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

const src = gs.slice(gs.indexOf('function moveRegRowToPanelBook_('),
                     gs.indexOf('function regSheetFor_(isPanel) {'))
  // The real widener, not a stand-in: the move writes into a book that may be
  // narrower than the row, and a test that fakes that away tests nothing.
  + gs.slice(gs.indexOf('function ensureGridWidth_(sh, needed) {'),
             gs.indexOf('// Every patient marked onto a panel whose row is still in the main book.'));
ok('the mover was found', src.indexOf('function moveRegRowToPanelBook_(') === 0
   && src.indexOf('function ensureGridWidth_') > 0, src.length);

function sheet(rows, ssId) {
  return {
    _rows: rows.map(r => r.slice()),
    // Both books call their tab Registrations and in both it is the first
    // one, so both carry sheet id 0. Only the spreadsheet tells them apart.
    _ss: ssId || 'MAIN',
    getSheetId() { return 0; },
    getParent() { const id = this._ss; return { getId: () => id }; },
    // Wide enough for these registers. The narrow book -- the one that made
    // the move throw in the clinic -- is panel-book-grid-and-sweep's job.
    _max: 60,
    getMaxColumns() { return this._max; },
    insertColumnsAfter(after, how) { this._max += how; },
    getLastRow() { return this._rows.length; },
    getLastColumn() { return this._rows.length ? this._rows[0].length : 0; },
    getDataRange() { const r = this._rows; return { getValues: () => r.map(x => x.slice()) }; },
    getRange(row, col, n, width) {
      const self = this;
      return {
        getValues: () => [self._rows[row - 1].slice(col - 1, col - 1 + width)],
        setValues: (vals) => {
          while (self._rows.length < row) self._rows.push([]);
          const r = self._rows[row - 1];
          vals[0].forEach((v, i) => { r[col - 1 + i] = v; });
        }
      };
    },
    appendRow(r) { this._rows.push(r.slice()); },
    deleteRow(n) { this._rows.splice(n - 1, 1); }
  };
}

function run(main, panel, rowNum, sameBook) {
  const ctx = {
    SS_ID: sameBook ? 'PANEL' : 'MAIN',
    PANEL_PMS_SHEET_ID: 'PANEL',
    regSheetFor_: () => panel,
    regCacheClear_: () => {},
    // the real one, so a drifted header really is matched by name
    findRegColumn_: (headers, names) => {
      for (const n of names) {
        const i = headers.findIndex(h => String(h).trim().toLowerCase() === String(n).trim().toLowerCase());
        if (i >= 0) return i;
      }
      return -1;
    },
    ensureRegColumns_: (sh, names) => {
      const h = sh._rows[0];
      names.forEach(n => {
        if (!h.some(x => String(x).trim().toLowerCase() === String(n).trim().toLowerCase())) h.push(n);
      });
    },
    String, Logger: { log() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.go = moveRegRowToPanelBook_;', ctx);
  return ctx.go(main, rowNum);
}

// ── the books have drifted, which is the whole danger ───────────────────
// The panel book carries columns the main one does not, and in a different
// order. A positional copy would file a card number under a blood group.
const MAIN_H = ['UHID', 'Full Name', 'Blood Group', 'Patient Type', 'Panel', 'Card ID'];
const PANEL_H = ['UHID', 'Panel', 'Card ID', 'Panel Category', 'Full Name', 'Blood Group'];

let main = sheet([MAIN_H,
  ['AL1009', 'Older Patient', 'A+', 'Normal', '', ''],
  ['AL1010', 'Santosh', 'B+', 'Panel', 'CGHS', '20542260'],
  ['AL1011', 'Someone Else', 'O+', 'Normal', '', '']], 'MAIN');
let panel = sheet([PANEL_H, ['AL2001', 'CGHS', '9', 'Pensioner', 'Existing Panel', 'AB+']], 'PANEL');

let res = run(main, panel, 3);
eq('the row is reported as moved', res, { moved: true });
eq('the patient is gone from the main book',
   main._rows.map(r => r[0]), ['UHID', 'AL1009', 'AL1011']);
eq('and the patients on either side of them are untouched',
   [main._rows[1][1], main._rows[2][1]], ['Older Patient', 'Someone Else']);
eq('the patient already in the panel book is still there', panel._rows[1][0], 'AL2001');

const moved = panel._rows[2];
const at = (name) => moved[PANEL_H.indexOf(name)];
eq('every value lands under its own heading, not its old position',
   [at('UHID'), at('Full Name'), at('Blood Group'), at('Panel'), at('Card ID')],
   ['AL1010', 'Santosh', 'B+', 'CGHS', '20542260']);
eq('a column the panel book did not have is added rather than dropped',
   panel._rows[0].indexOf('Patient Type') >= 0, true);
eq('and carries its value', moved[panel._rows[0].indexOf('Patient Type')], 'Panel');

// ── nothing silly when there is nothing to do ───────────────────────────
main = sheet([MAIN_H, ['AL1010', 'Santosh', 'B+', 'Panel', 'CGHS', '1']], 'MAIN');
panel = sheet([PANEL_H], 'PANEL');
eq('on the panel instance itself there is nowhere to move to',
   run(main, panel, 2, true).moved, false);
eq('and the row stays where it is', main._rows.length, 2);

main = sheet([MAIN_H, ['AL1010', 'Santosh', 'B+', 'Panel', 'CGHS', '1']], 'PANEL');
eq('a patient already in the panel book is not moved into it again',
   run(main, main, 2).moved, false);
// The bug this missed the first time: two books, same tab name, same sheet
// id, different spreadsheets. Told apart by sheet id, nothing ever moved.
const a = sheet([MAIN_H, ['AL1010', 'Santosh', 'B+', 'Panel', 'CGHS', '1']], 'MAIN');
const b = sheet([PANEL_H], 'PANEL');
eq('two books whose tabs share a sheet id are still two books',
   run(a, b, 2).moved, true);
eq('and the patient really arrives', b._rows.length, 2);

// An empty panel book takes the main book's headings rather than starting
// with none and silently dropping everything.
main = sheet([MAIN_H, ['AL1010', 'Santosh', 'B+', 'Panel', 'CGHS', '20542260']], 'MAIN');
panel = sheet([], 'PANEL');
res = run(main, panel, 2);
eq('an empty panel book is given headings', panel._rows[0], MAIN_H);
eq('and the patient arrives whole', panel._rows[1],
   ['AL1010', 'Santosh', 'B+', 'Panel', 'CGHS', '20542260']);
eq('the move is reported', res.moved, true);

// ── the order it does things in ─────────────────────────────────────────
// Appended first, deleted second. The other way round loses the patient if
// the append fails, and there is no getting them back.
ok('the row is appended before it is deleted',
   src.indexOf('dest.appendRow(out);') < src.indexOf('fromSheet.deleteRow(rowNum);'));

// ── and saveRegistration actually calls it ──────────────────────────────
ok('a conversion triggers the move',
   /if \(isPanel && existingRow > 0\) \{\s*try \{\s*var mv = moveRegRowToPanelBook_\(sh, existingRow\);\s*movedToPanel = !!\(mv && mv\.moved\);/.test(gs));
// A failed move must not look like a failed save: the details ARE saved.
ok('a move that fails does not fail the save',
   /Logger\.log\("Panel book move failed for "/.test(gs) &&
   /return \{ success: true, uhid: p\.uhid, movedToPanelBook: movedToPanel,/.test(gs));
// A move that did not happen said so only in a log nobody reads. The reason
// comes back with the save now; panel-book-grid-and-sweep covers the rest.
ok('and says why it did not move', /panelMoveNote: panelMoveNote/.test(gs));
// A brand-new panel patient is routed to the panel book already; moving
// them again would be a second row.
ok('only an existing row is moved, never a fresh one',
   /isPanel && existingRow > 0/.test(gs));

const build = (/var BACKEND_BUILD = "([^"]+)"/.exec(gs) || [])[1];
ok('the fixed backend is there to deploy', build >= '2026-11-06a', build);
// Sheet ids do not identify a spreadsheet, and reaching for one here is
// what stopped the first attempt working at all.
ok('the books are told apart by spreadsheet, not by sheet id',
   /dest\.getParent\(\)\.getId\(\) === fromSheet\.getParent\(\)\.getId\(\)/.test(src) &&
   !/\.getSheetId\(\)/.test(src), src.slice(0, 400));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
