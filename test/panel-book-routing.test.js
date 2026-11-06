// Panel patients are registered and billed in their own book. Everything else
// about them — the UHID sequence, search, the patient list, birthdays, the
// duplicate check — is shared with every other patient, because they are the
// same patients seen in the same chairs.
//
// This runs the real Code.gs functions against two fake books and holds the
// routing to the rules it was built on:
//
//   * A new panel registration lands in the panel book, a normal one does not.
//   * An existing UHID is updated where it already lives, whichever book that
//     is — the iPad form knows nothing about panels and must not split one
//     patient across two books or create a second row.
//   * UHIDs are one sequence across both books, so two patients registered the
//     same minute in different books can never collide.
//   * Every reader sees both books, or a panel patient becomes invisible.
//   * If the panel book cannot be opened, the clinic still works.

const fs = require('fs');
const path = require('path');
const GS = fs.readFileSync(path.resolve(__dirname, '../apps-script/out/Code.gs'), 'utf8');
const PMS = '1DtoZ3MNFq2Enr-ClAjENWFzk8SF2dYN9e1nGf7tAJC4';
const PANEL = '1yg9Umwwkxao-RUwxXuycjG7CVXjRAQUmMvMHa_l6sjo';

const checks = [];
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail, want: 'truthy' });

class FakeSheet {
  constructor(book, name, rows) { this.book = book; this.name = name; this.rows = rows || []; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getDataRange() { const s = this; return { getValues: () => s.rows.map(r => r.slice()) }; }
  getRange(r, c, nr, nc) {
    const sheet = this; nr = nr || 1; nc = nc || 1;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sheet.rows[r - 1 + i] || [], vals = [];
          for (let j = 0; j < nc; j++) vals.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]);
          out.push(vals);
        }
        return out;
      },
      setValues(vals) {
        for (let i = 0; i < nr; i++) {
          while (sheet.rows.length < r + i) sheet.rows.push([]);
          for (let j = 0; j < nc; j++) sheet.rows[r - 1 + i][c - 1 + j] = vals[i][j];
        }
      },
    };
  }
  appendRow(v) { this.rows.push(v.slice()); }
  // A real sheet is a fixed grid and has to be widened before it can be
  // written past its edge. This fake starts wide enough for the registers
  // used here; panel-book-grid-and-sweep is where the narrow case is tested.
  getMaxColumns() { return this._max === undefined ? 60 : this._max; }
  insertColumnsAfter(after, how) { this._max = this.getMaxColumns() + how; }
}
class FakeBook {
  constructor(id) { this.id = id; this.sheets = []; }
  getId() { return this.id; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(this, n, []); this.sheets.push(s); return s; }
  add(n, rows) { const s = new FakeSheet(this, n, rows); this.sheets.push(s); return s; }
}

function slice(from, to) {
  const a = GS.indexOf(from), b = GS.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('could not slice ' + from);
  return GS.slice(a, b);
}
const routing = slice('var PANEL_PMS_SHEET_ID', 'function getSheet(name) {');
const findCol = slice('function findRegColumn_(headers, candidates) {', '\n// ');
const uhid = slice('function uhidYearCode_(year) {', '// Finds a Registrations-sheet column');
const save = slice('function saveRegistration(p) {', '// ── Patient-facing registration completion');
const search = slice('function searchPatients(p) {', '\nfunction ');

const HEAD = ['Timestamp', 'UHID', 'Full Name', 'Date of Birth', 'Mobile No.', 'What is your chief complaint?'];

function boot(opts) {
  opts = opts || {};
  const books = { [PMS]: new FakeBook(PMS) };
  if (!opts.noPanelBook) books[PANEL] = new FakeBook(PANEL);
  books[PMS].add('Registrations', [HEAD.slice()]);
  if (books[PANEL]) {
    books[PANEL].add('Registrations', [HEAD.concat(['Patient Type', 'Panel', 'Panel Category', 'Card ID'])]);
  }
  const logged = [];
  const opens = [];
  const env = {
    books, logged, opens,
    SpreadsheetApp: {
      openById: id => { opens.push(id); if (!books[id]) throw new Error('no such file ' + id); return books[id]; },
      getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'Asia/Kolkata' }),
    },
    Logger: { log: (...a) => logged.push(a.join(' ')) },
    // The save names the backend it ran on, so a stale deployment is visible.
    BACKEND_BUILD: 'test',
    Utilities: { formatDate: (d, tz, f) => (f === 'yyyy' ? '2026' : '10') },
    getSheet: n => books[PMS].getSheetByName(n) || books[PMS].insertSheet(n),
    SS_ID: opts.ssId || PMS,
    removePending: () => {},
    safeJSON: v => (typeof v === 'string' ? v : JSON.stringify(v)),
    formatDOB: v => String(v || ''),
    calcAge: () => '',
  };
  const names = Object.keys(env).filter(k => k !== 'books' && k !== 'logged' && k !== 'opens');
  env.api = new Function(...names,
    routing + '\n' + findCol + '\n' + uhid + '\n' + save + '\n' + search +
    '\nreturn { saveRegistration, getNextUHID, searchPatients, regAllRows_, regSheets_, regCacheClear_, regRow_: typeof regRow_ === "function" ? regRow_ : null };'
  )(...names.map(n => env[n]));
  return env;
}
const rowsOf = (e, book) => e.books[book].getSheetByName('Registrations').rows;

// ── a new registration goes to the book its type says ──────────────────────
{
  const e = boot();
  e.api.saveRegistration({ uhid: 'AL1001', name: 'Normal Patient', mobile: '9000000001' });
  e.api.saveRegistration({ uhid: 'AL1002', name: 'Panel Patient', mobile: '9000000002',
    patientType: 'Panel', panel: 'CGHS', panelCategory: 'Pensioner', cardId: 'C-77' });
  eq('a normal registration stays in the main book', rowsOf(e, PMS).length, 2);
  const p = rowsOf(e, PANEL);
  ok('and the normal patient is not in the panel book',
     JSON.stringify(p).indexOf('Normal Patient') === -1, JSON.stringify(p));
  ok('nor the panel patient in the main book',
     JSON.stringify(rowsOf(e, PMS)).indexOf('Panel Patient') === -1, JSON.stringify(rowsOf(e, PMS)));
  eq('a panel registration lands in the panel book', p.length, 2);
  ok('with the panel on it', p[1].indexOf('CGHS') >= 0, p[1]);
  ok('the card holder category', p[1].indexOf('Pensioner') >= 0, p[1]);
  ok('and the card number', p[1].indexOf('C-77') >= 0, p[1]);
}

// ── the iPad form must not split a patient across two books ────────────────
{
  const e = boot();
  e.api.saveRegistration({ uhid: 'AL1002', name: 'Panel Patient', mobile: '9000000002',
    patientType: 'Panel', panel: 'CGHS', panelCategory: 'Serving', cardId: 'C-77' });
  // The iPad form is opened from a link. It sends no panel fields at all.
  e.api.saveRegistration({ uhid: 'AL1002', name: 'Panel Patient', mobile: '9000000002',
    dob: '1980-01-01', complaint: 'Tooth pain' });
  eq('completing the form does not add a row to the main book', rowsOf(e, PMS).length, 1);
  eq('nor a second row in the panel book', rowsOf(e, PANEL).length, 2);
  const r = rowsOf(e, PANEL)[1];
  ok('the new detail is saved', r.indexOf('Tooth pain') >= 0, r);
  ok('and the claim details survive it', r.indexOf('CGHS') >= 0 && r.indexOf('C-77') >= 0, r);
}

// ── one UHID sequence across both books ────────────────────────────────────
{
  const e = boot();
  e.api.saveRegistration({ uhid: 'AL1001', name: 'A', patientType: 'Panel', panel: 'CGHS' });
  const next = e.api.getNextUHID();
  ok('the sequence counts the panel book too', next.uhid === 'AL1002', next.uhid);
  e.api.saveRegistration({ uhid: next.uhid, name: 'B' });
  const after = e.api.getNextUHID();
  ok('and keeps counting across both', after.uhid === 'AL1003', after.uhid);
}

// ── a panel patient must be findable like anyone else ──────────────────────
{
  const e = boot();
  e.api.saveRegistration({ uhid: 'AL1009', name: 'Panel Person', mobile: '9811111111',
    patientType: 'Panel', panel: 'DGEHS', panelCategory: 'Serving', cardId: 'D-1' });
  const res = e.api.searchPatients({ query: 'Panel Person' });
  ok('search finds a patient in the panel book', res.success && res.patients.length === 1,
     JSON.stringify(res).slice(0, 160));
  const all = e.api.regAllRows_();
  ok('and the merged table carries the panel columns',
     all[0].indexOf('Card ID') >= 0, all[0]);
}

// ── the panel book is never required ───────────────────────────────────────
{
  const e = boot({ noPanelBook: true });
  eq('an unreachable panel book leaves one sheet to read', e.api.regSheets_().length, 1);
  e.api.saveRegistration({ uhid: 'AL1001', name: 'Normal', mobile: '9000000001' });
  eq('and a normal registration still saves', rowsOf(e, PMS).length, 2);
  ok('with the reason written to the log',
     e.logged.join(' ').indexOf('Panel book unreachable') >= 0, e.logged.join(' '));
}

// ── inside the panel book itself, nothing reaches out ──────────────────────
{
  const e = boot({ ssId: PANEL });
  eq('the panel book reads only itself', e.api.regSheets_().length, 1);
}

// ── the cost of reading both books ─────────────────────────────────────────
// Opening the panel book is a round trip and reading both sheets is two more.
// The batched read runs several actions inside ONE request, so without a cache
// a single refresh paid that over and over — which is exactly what made the app
// slower after the routing went in.
{
  const e = boot();
  e.api.saveRegistration({ uhid: 'AL1001', name: 'A', mobile: '9000000001' });
  const before = e.opens.length;
  e.api.getNextUHID();
  e.api.searchPatients({ query: 'A' });
  e.api.regAllRows_();
  e.api.regAllRows_();
  eq('four reads in one request open the panel book once', e.opens.length - before, 1);
}

// A cache that outlived a write would answer the next read with a row that is
// no longer there, or miss one that is.
{
  const e = boot();
  e.api.searchPatients({ query: 'anyone' });            // fills the cache
  e.api.saveRegistration({ uhid: 'AL1002', name: 'Late Arrival', mobile: '9000000002' });
  const res = e.api.searchPatients({ query: 'Late Arrival' });
  ok('a patient saved mid-request is found by the next read',
     res.success && res.patients.length === 1, JSON.stringify(res).slice(0, 160));
}

let pass = 0, fail = 0;
checks.forEach(c => {
  if (c.ok) { pass++; console.log('  PASS  ' + c.name); }
  else { fail++; console.log('  FAIL  ' + c.name + '\n          got ' + JSON.stringify(c.got) + ', want ' + JSON.stringify(c.want)); }
});
console.log('==============================================================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('==============================================================================');
process.exit(fail ? 1 : 0);
