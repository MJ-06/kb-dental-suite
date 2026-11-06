// "Keep it under Finance with a tab CGHS Bills where we can generate the
//  bill number automatically and searched according to UHID."
//
// A bill number is the one thing on the sheet that cannot be worked out
// again later. Two bills carrying the same number is a rejected claim and a
// question from the panel, so the number is handed out by the server under
// a lock — never by the browser, where two people billing at the same
// counter at the same moment would both be told "0001".
//
// The allocation is Apps Script, so it is run here as plain JavaScript
// against a fake sheet: the arithmetic and the locking are what matter, and
// neither can be checked by reading the diff.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; } else {
    fail++;
    console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : ''));
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));

// ── the allocation, run ─────────────────────────────────────────────────
const cut = (from, to) => gs.slice(gs.indexOf(from), gs.indexOf(to, gs.indexOf(from)));
const src = cut('var CGHS_BILLS_SHEET = "CGHS Bills";',
                '// ════════════════════════════════════════════════════════════\n// TREATMENT PROGRESS');
ok('the bill code was found', src.length > 800, src.length);

const makeSheet = (rows) => ({
  _rows: rows.slice(),
  getLastRow() { return this._rows.length; },
  // A sheet left by an earlier build is a column short of the headings, and
  // the heading is added rather than assumed -- so it has to be readable and
  // writable here, not just appendable.
  getLastColumn() { return this._rows.reduce((m, r) => Math.max(m, r.length), 0); },
  getMaxColumns() { return Math.max(26, this.getLastColumn()); },
  insertColumnsAfter() {},
  getDataRange() { const r = this._rows; return { getValues: () => r.map(x => x.slice()) }; },
  getRange(row, col, nr, nc) {
    const sh = this;
    return {
      getValues: () => [(sh._rows[row - 1] || []).slice(col - 1, col - 1 + nc)],
      setValues: (vals) => {
        while (sh._rows.length < row) sh._rows.push([]);
        vals[0].forEach((v, i) => { sh._rows[row - 1][col - 1 + i] = v; });
      }
    };
  },
  appendRow(r) { this._rows.push(r.slice()); }
});

const run = (rows, locked) => {
  const sheet = makeSheet(rows);
  const log = { locks: 0, releases: 0 };
  const ctx = {
    getSheet: () => sheet,
    safeJSON: (v) => typeof v === 'string' ? v : JSON.stringify(v || null),
    safeParseJSON: (v) => { try { return JSON.parse(v); } catch (e) { return null; } },
    LockService: { getScriptLock: () => ({
      waitLock(ms) { log.locks++; if (locked) throw new Error('timeout'); },
      releaseLock() { log.releases++; }
    }) },
    // A bill written before the address was kept with it is topped up from
    // the register. There is no register here, and an empty one is the
    // honest case: these bills were written by an earlier build.
    regAllRows_: () => [],
    regLatestByUhid_: () => ({}),
    findRegColumn_: () => -1,
    ensureGridWidth_: () => {},
    Date, Number, String, isNaN, JSON
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, sheet, log };
};

// A fresh month starts at 0001, and the series runs on from there.
let { ctx, sheet, log } = run([]);
const first = ctx.saveCghsBill({ uhid: 'AL1010', patientName: 'Santosh', billDate: '2026-11-04', amount: 795 });
eq('the first bill of a month is 0001', first, { success: true, billNo: '2026110001' });
const second = ctx.saveCghsBill({ uhid: 'AL1011', patientName: 'Asha', billDate: '2026-11-04', amount: 450 });
eq('the next one is 0002', second.billNo, '2026110002');
ok('the header row was written once',
   sheet._rows[0][0] === 'Bill No' && sheet._rows.length === 3, JSON.stringify(sheet._rows.map(r => r[0])));
ok('the number is taken under a lock, and the lock is let go',
   log.locks === 2 && log.releases === 2, JSON.stringify(log));

// ── the address the panel asked for ─────────────────────────────────────
// A sheet written before the address was kept is a column short. Writing
// into a column that does not exist loses the value silently, so the
// heading is added first -- and the bills already in the sheet keep theirs.
{
  const OLD = ["Bill No", "Bill Date", "UHID", "Patient", "Panel",
               "Card ID", "Panel Category", "Amount", "Lines", "Saved At"];
  // Copied in: the sheet writes into its heading row, and OLD is what the
  // sheet looked like BEFORE that.
  const r = run([OLD.slice(), ['2026110001', '2026-11-04', 'AL1009', 'Earlier', 'CGHS', '1', '', 500, 'null', '']]);
  const res = r.ctx.saveCghsBill({ uhid: 'AL1010', patientName: 'Santosh', billDate: '2026-11-05',
    amount: 795, address: 'B-12, Lajpat Nagar, New Delhi' });
  eq('the bill is still issued', res.billNo, '2026110002');
  eq('the heading is added', r.sheet._rows[0][10], 'Address');
  eq('nothing else in the heading row moved', r.sheet._rows[0].slice(0, 10), OLD);
  eq('the bill already in the sheet is untouched', r.sheet._rows[1][0], '2026110001');
  eq('and the address lands under its own heading',
     r.sheet._rows[2][r.sheet._rows[0].indexOf('Address')], 'B-12, Lajpat Nagar, New Delhi');
  // Asked for again, nothing is rewritten: the sheet is already wide enough.
  r.ctx.saveCghsBill({ uhid: 'AL1011', patientName: 'Asha', billDate: '2026-11-05', amount: 450, address: 'C-9' });
  eq('a second bill does not rewrite the heading row', r.sheet._rows[0][10], 'Address');
  eq('and is simply appended', r.sheet._rows.length, 4);
}

// The series belongs to the BILL's month, not to today: a bill written on
// the 2nd for last month's work belongs to last month's series.
const next = ctx.saveCghsBill({ uhid: 'AL1012', billDate: '2026-12-01', amount: 100 });
eq('a bill in the next month starts that month at 0001', next.billNo, '2026120001');
const back = ctx.saveCghsBill({ uhid: 'AL1013', billDate: '2026-11-30', amount: 100 });
eq('and one dated back into November continues November', back.billNo, '2026110003');

// Reading an existing register must not restart the series.
const resumed = run([
  ['Bill No', 'Bill Date', 'UHID', 'Patient', 'Panel', 'Card ID', 'Panel Category', 'Amount', 'Lines', 'Saved At'],
  ['2026110001', '2026-11-04', 'AL1', 'A', 'CGHS', '1', 'P', 100, '[]', ''],
  ['2026110007', '2026-11-04', 'AL2', 'B', 'CGHS', '2', 'P', 200, '[]', '']
]);
eq('it carries on from the highest number already issued, not the count',
   resumed.ctx.saveCghsBill({ uhid: 'AL3', billDate: '2026-11-05', amount: 50 }).billNo, '2026110008');

// A bill with no UHID cannot be found again, so it is refused.
eq('a bill with no patient is refused',
   resumed.ctx.saveCghsBill({ billDate: '2026-11-05', amount: 50 }).success, false);

// If the lock cannot be taken, nothing is written: a number half-issued is
// worse than none.
const busy = run([], true);
const refused = busy.ctx.saveCghsBill({ uhid: 'AL1', billDate: '2026-11-04', amount: 10 });
eq('a busy register refuses rather than guessing a number', refused.success, false);
eq('and writes nothing', busy.sheet._rows.length, 0);

// ── reading them back ───────────────────────────────────────────────────
const reg = run([
  ['Bill No', 'Bill Date', 'UHID', 'Patient', 'Panel', 'Card ID', 'Panel Category', 'Amount', 'Lines', 'Saved At'],
  ['2026110001', '2026-11-04', 'AL1010', 'Santosh', 'CGHS', '20542260', 'CGHS PENSIONER', 795,
   '[{"code":"DP007","procedure":"Flap","tooth":"16","qty":1,"rate":450,"amount":450}]', 'x'],
  ['2026110002', '2026-11-04', 'AL1011', 'Asha', 'CGHS', '9', 'CGHS SERVING', 450, '[]', 'y']
]);
const all = reg.ctx.getCghsBills({});
eq('every bill comes back, newest first', all.bills.map(b => b.billNo), ['2026110002', '2026110001']);
const mine = reg.ctx.getCghsBills({ uhid: 'al1010' });
eq('and one patient\'s can be asked for, whatever the case of their UHID',
   mine.bills.map(b => b.billNo), ['2026110001']);
eq('the lines come back as lines, not as text',
   mine.bills[0].lines[0].code, 'DP007');
eq('and the amount as a number', mine.bills[0].amount, 795);
eq('an empty register is empty, not an error', run([]).ctx.getCghsBills({}), { success: true, bills: [] });

// ── the screen that reads it ────────────────────────────────────────────
ok('Finance has a CGHS Bills tab', /\{ id:"cghsbills",\s+label:"[^"]*CGHS Bills" \}/.test(html));
ok('and it renders the register', /tab === "cghsbills" && React\.createElement\(FinanceCghsBillsTab/.test(html));
ok('the bill stage asks the server for its number',
   /api\("saveCghsBill", \{/.test(html));
ok('a number that was issued cannot be edited afterwards',
   /readOnly: issued/.test(html));
ok('and an old backend does not stop the clinic billing',
   /You can type the number yourself and print/.test(html));
// A bill that has gone to the panel must not change because the plan did.
ok('a reprint comes from what was saved, not from the plan',
   /Reprinted from what was saved, not rebuilt from the plan/.test(html));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
