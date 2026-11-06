// "it has updated on frontend but still not updating the sheets at the backend"
//
// Two things are tested here, and they are the two halves of that report.
//
// 1. A Google sheet is a FIXED GRID. Writing one column past its right-hand
//    edge does not widen it, it throws. A new sheet is 26 columns wide and
//    the main register carries more than that, so moving a row into the panel
//    book had to widen it first -- and did not. The throw was swallowed by
//    the try/catch around the move, logged where nobody reads logs, and the
//    save reported success. The front end was right and the sheet never
//    changed, which is exactly what was reported.
//
// 2. The hook on save only ever catches a conversion as it is made. The
//    clinic had years of CGHS patients on file before the panel existed, and
//    "in times to come there will be more patients like this" -- so there is
//    a sweep, and it is run here rather than read.
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

const cut = (from, to) => {
  const a = gs.indexOf(from), b = gs.indexOf(to);
  if (a < 0 || b < 0 || b <= a) throw new Error('could not cut ' + from + ' .. ' + to);
  return gs.slice(a, b);
};
// The real code, from the mover down to the end of the sweep.
const src = cut('function moveRegRowToPanelBook_(', 'function getSheet(name) {');
ok('the code under test was found', src.indexOf('function sweepPanelBook') > 0, src.length);

// ── a sheet that behaves like a real one ────────────────────────────────
// The grid has a width, and reaching past it throws the way Apps Script
// does. Without this the bug is invisible: an array in a test grows for
// free, and a spreadsheet does not.
function sheet(rows, ssId, maxColumns) {
  const s = {
    _rows: rows.map(r => r.slice()),
    _ss: ssId || 'MAIN',
    _max: maxColumns === undefined ? 26 : maxColumns,
    getSheetId() { return 0; },
    getParent() { const id = s._ss; return { getId: () => id }; },
    getMaxColumns() { return s._max; },
    insertColumnsAfter(after, how) {
      if (after !== s._max) throw new Error('insertColumnsAfter(' + after + ') but the sheet is ' + s._max + ' wide');
      s._max += how;
      s._inserts = (s._inserts || 0) + how;
    },
    getLastRow() { return s._rows.length; },
    getLastColumn() {
      let n = 0;
      s._rows.forEach(r => { for (let i = 0; i < r.length; i++) if (String(r[i] || '') !== '') n = Math.max(n, i + 1); });
      return Math.min(n, s._max);
    },
    getDataRange() { return { getValues: () => s._rows.map(x => x.slice()) }; },
    getRange(row, col, n, width) {
      if (col + width - 1 > s._max) {
        throw new Error('Those columns are out of bounds. The sheet is ' + s._max + ' columns wide.');
      }
      return {
        getValues: () => [(s._rows[row - 1] || []).slice(col - 1, col - 1 + width)],
        setValues: (vals) => {
          while (s._rows.length < row) s._rows.push([]);
          const r = s._rows[row - 1];
          vals[0].forEach((v, i) => { r[col - 1 + i] = v; });
        }
      };
    },
    appendRow(r) {
      if (r.length > s._max) {
        throw new Error('The number of columns in the data does not match the number in the range.');
      }
      s._rows.push(r.slice());
    },
    deleteRow(n) { s._rows.splice(n - 1, 1); }
  };
  return s;
}

function sandbox(main, panel, here) {
  const ctx = {
    SS_ID: here === 'panel' ? 'PANEL' : 'MAIN',
    PANEL_PMS_SHEET_ID: 'PANEL',
    BACKEND_BUILD: 'test',
    getSheet: () => main,
    // regSheetFor_ comes from the real source, so the panel book is reached
    // the way it is in production: opened by id.
    SpreadsheetApp: {
      openById: (id) => ({ getId: () => id, getSheetByName: () => panel, insertSheet: () => panel })
    },
    regCacheClear_: () => {},
    findRegColumn_: (headers, names) => {
      for (const n of names) {
        const i = headers.findIndex(h => String(h).trim().toLowerCase() === String(n).trim().toLowerCase());
        if (i >= 0) return i;
      }
      return -1;
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    String, Math, Logger: { log() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.move = moveRegRowToPanelBook_; this.audit = auditPanelBook;'
    + ' this.sweep = sweepPanelBook; this.widen = ensureGridWidth_; this.cols = ensureRegColumns_;', ctx);
  return ctx;
}

// ── 1. the grid ─────────────────────────────────────────────────────────
// The main register as it really is: more than 26 headings.
const MAIN_H = ['Timestamp','UHID','Full Name','Gender','Date of Birth','Blood Group','Occupation',
  'Marital Status','Complete Address','Mobile No.','WhatsApp No.','Email','Emergency Person',
  'Emergency Number','Conditions','Medicines','Allergies','How did you know','Chief complaint',
  'Are you in Pain?','Pain level','Relation with Person','Patient Type','Panel','Panel Category',
  'Card ID','Referred By Type','Mobile 2','Safety Flags'];
ok('the main register really is wider than a new sheet', MAIN_H.length > 26, MAIN_H.length);

const row = (uhid, name, type, panelName) => {
  const r = MAIN_H.map(() => '');
  r[MAIN_H.indexOf('UHID')] = uhid;
  r[MAIN_H.indexOf('Full Name')] = name;
  r[MAIN_H.indexOf('Patient Type')] = type;
  r[MAIN_H.indexOf('Panel')] = panelName;
  r[MAIN_H.indexOf('Card ID')] = '20542260';
  return r;
};

{
  // A panel book that was created at 26 columns and never widened — the
  // state every one of these books starts in.
  const main = sheet([MAIN_H, row('AL1010', 'Santosh', 'Panel', 'CGHS')], 'MAIN', MAIN_H.length);
  const panel = sheet([MAIN_H.slice(0, 26)], 'PANEL', 26);
  const ctx = sandbox(main, panel);

  let res, threw = null;
  try { res = ctx.move(main, 2); } catch (e) { threw = e.message; }
  ok('a panel book narrower than the row does not throw', threw === null, threw);
  eq('and the row is moved', res, { moved: true });
  eq('the main register no longer holds them', main._rows.length, 1);
  eq('the panel book does', panel._rows.length, 2);
  ok('the panel book was widened to fit, not written past its edge',
     panel.getMaxColumns() >= MAIN_H.length, panel.getMaxColumns());

  const dh = panel._rows[0];
  const at = (n) => panel._rows[1][dh.indexOf(n)];
  eq('and every value is under its own heading',
     [at('UHID'), at('Full Name'), at('Panel'), at('Card ID')],
     ['AL1010', 'Santosh', 'CGHS', '20542260']);
}

{
  // An empty panel book: the headings themselves are wider than the grid.
  const main = sheet([MAIN_H, row('AL1010', 'Santosh', 'Panel', 'CGHS')], 'MAIN', MAIN_H.length);
  const panel = sheet([], 'PANEL', 26);
  const ctx = sandbox(main, panel);
  let threw = null, res;
  try { res = ctx.move(main, 2); } catch (e) { threw = e.message; }
  ok('an empty 26-column panel book is widened for the headings', threw === null, threw);
  eq('the move is reported', res, { moved: true });
  eq('the headings arrive whole', panel._rows[0].length, MAIN_H.length);
}

{
  // ensureRegColumns_ is the same trap, and the one that runs on EVERY save.
  const sh = sheet([['UHID', 'Full Name', 'Blood Group']], 'MAIN', 3);
  const ctx = sandbox(sh, sh);
  let threw = null;
  try { ctx.cols(sh, ['Patient Type', 'Panel', 'Panel Category', 'Card ID']); } catch (e) { threw = e.message; }
  ok('adding a column to a full-width sheet widens it instead of throwing', threw === null, threw);
  eq('and the columns are there',
     sh._rows[0], ['UHID', 'Full Name', 'Blood Group', 'Patient Type', 'Panel', 'Panel Category', 'Card ID']);

  // Only by what is short. A sheet is not quietly given a hundred columns.
  const sh2 = sheet([['UHID', 'Full Name']], 'MAIN', 10);
  const ctx2 = sandbox(sh2, sh2);
  ctx2.cols(sh2, ['Panel']);
  eq('a sheet with room is not widened at all', sh2.getMaxColumns(), 10);
  eq('nothing was inserted', sh2._inserts, undefined);
}

// ── 2. the sweep ────────────────────────────────────────────────────────
{
  const main = sheet([MAIN_H,
    row('AL1001', 'Older Patient', 'Normal', ''),
    row('AL1010', 'Santosh', 'Panel', 'CGHS'),
    row('AL1011', 'Cash Patient', 'Normal', ''),
    row('AL1012', 'Meena', 'Panel', 'DGEHS'),
    row('AL1013', 'Never Marked', '', 'CGHS')], 'MAIN', MAIN_H.length);
  const panel = sheet([MAIN_H.slice(0, 26)], 'PANEL', 26);
  const ctx = sandbox(main, panel);

  const seen = ctx.audit({});
  eq('the audit changes nothing', main._rows.length, 6);
  eq('it finds everyone marked onto a panel, and nobody else',
     seen.stranded.map(x => x.uhid).sort(), ['AL1010', 'AL1012', 'AL1013']);
  eq('and says which book it is looking at', seen.here, 'main');

  const res = ctx.sweep({});
  eq('all three are moved', [res.success, res.found, res.moved, res.left], [true, 3, 3, []]);
  eq('the cash patients are left where they are',
     main._rows.slice(1).map(r => r[MAIN_H.indexOf('UHID')]), ['AL1001', 'AL1011']);
  eq('and the panel book has them all',
     panel._rows.slice(1).map(r => r[panel._rows[0].indexOf('UHID')]).sort(),
     ['AL1010', 'AL1012', 'AL1013']);

  // Deleting a row shifts every row beneath it. Walked the wrong way round,
  // the sweep moves the wrong patients — and nothing in the result would say
  // so, which is why the names are checked and not just the count.
  eq('nobody arrived twice and nobody was left behind', panel._rows.length, 4);

  const again = ctx.sweep({});
  eq('run a second time there is nothing to do', [again.found, again.moved], [0, 0]);
}

{
  // Explicitly marked Normal, with a panel name left over from before. That
  // was somebody's decision and the sweep does not overrule it.
  const main = sheet([MAIN_H, row('AL1014', 'Paying Cash', 'Normal', 'CGHS')], 'MAIN', MAIN_H.length);
  const panel = sheet([MAIN_H.slice(0, 26)], 'PANEL', 26);
  const ctx = sandbox(main, panel);
  eq('a patient marked Normal is left alone, panel name or not', ctx.sweep({}).found, 0);
  eq('and stays in the main register', main._rows.length, 2);
}

{
  // From the empanelled app there is nowhere to move anything to, and it
  // must say so rather than appear to work.
  const main = sheet([MAIN_H, row('AL1010', 'Santosh', 'Panel', 'CGHS')], 'PANEL', MAIN_H.length);
  const ctx = sandbox(main, main, 'panel');
  const res = ctx.sweep({});
  eq('the sweep refuses on the empanelled instance', res.success, false);
  ok('and says where to run it', /main clinic app/i.test(res.error || ''), res.error);
  eq('the audit says the same', ctx.audit({}).here, 'panel');
  eq('nothing was touched', main._rows.length, 2);
}

{
  // One patient failing must not stop the rest. The reason comes back with
  // the name, because "it did not work" has cost two rounds already.
  const main = sheet([MAIN_H,
    row('AL1010', 'Santosh', 'Panel', 'CGHS'),
    row('AL1012', 'Meena', 'Panel', 'DGEHS')], 'MAIN', MAIN_H.length);
  const panel = sheet([MAIN_H.slice(0, 26)], 'PANEL', 26);
  const ctx = sandbox(main, panel);
  const realAppend = panel.appendRow;
  let first = true;
  panel.appendRow = function (r) {
    if (first) { first = false; throw new Error('Service unavailable: Spreadsheets'); }
    return realAppend.call(panel, r);
  };
  const res = ctx.sweep({});
  eq('the other patient still moves', res.moved, 1);
  eq('and the one that failed is named with its reason', res.left.length, 1);
  ok('by name', /Santosh|Meena/.test(res.left[0]), res.left[0]);
  ok('with the error itself', /Service unavailable/.test(res.left[0]), res.left[0]);
  eq('a patient whose move failed is still in the main register', main._rows.length, 2);
}

// ── the save says what became of the move ───────────────────────────────
ok('the reason is carried back to whoever pressed Save',
   /panelMoveNote: panelMoveNote/.test(gs) &&
   /return \{ success: true, uhid: p\.uhid, movedToPanelBook: movedToPanel,/.test(gs));
ok('and the backend names itself, so a stale deployment can be seen',
   /build: BACKEND_BUILD \};/.test(gs));
ok('both actions are routed',
   /case "auditPanelBook":\s+return auditPanelBook\(p\);/.test(gs) &&
   /case "sweepPanelBook":\s+return sweepPanelBook\(p\);/.test(gs));
// The sweep deletes rows, so it may not run beside another write.
ok('the sweep takes the script lock', /function sweepPanelBook[\s\S]{0,400}LockService\.getScriptLock/.test(gs));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
