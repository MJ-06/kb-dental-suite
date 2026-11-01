// "People without panel also in panel list."
//
// A contact's panel is recorded TWICE -- as the panel's name on the contact,
// and as the company that panel became -- and the two can disagree. The
// queue that carried a newly registered patient into the CRM left the
// company blank for a long time, so a patient can read "Deepa Tyagi CGHS"
// on screen and be filed under nothing at all. There is a maintenance
// script whose whole job is backfilling those.
//
// The list filtered on one of the two and showed the other. That is how a
// list of panel patients comes to hold people with no panel, and how
// somebody plainly on a panel reads as "Individual".
//
// So the rows, the count beside the button, the dropdown's numbers and the
// export are now one array, decided by one function.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : '')); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const crm = (() => {
  const m = /const CRM_B64\s*=\n/.exec(html);
  const a = m.index, b = html.indexOf(';\n', a);
  return Buffer.from((html.slice(a, b).match(/"[^"]*"/g) || [])
    .map(x => x.slice(1, -1)).join(''), 'base64').toString('utf8');
})();

// ── panelOf, lifted out and run ─────────────────────────────────────────
const A = crm.indexOf('  function panelOf(c, companies){');
const B = crm.indexOf('  function contactName(c){', A);
ok('panelOf was found', A > 0 && B > A, `${A}..${B}`);
const sandbox = { Object, String, Array, JSON };
vm.createContext(sandbox);
vm.runInContext(crm.slice(A, B) + '\n;globalThis.__panelOf = panelOf;', sandbox);
const panelOf = sandbox.__panelOf;

const COMPANIES = [
  { id: 'co_cghs', name: 'CGHS', industry: 'Panel' },
  { id: 'co_dgehs', name: 'DGEHS', industry: 'Panel' },
  { id: 'co_blank', name: '   ', industry: 'Panel' }
];
{
  eq('filed under the company', panelOf({ companyId: 'co_cghs' }, COMPANIES), 'CGHS');
  // The half that goes missing. This is the case the clinic is looking at.
  eq('or by the panel on the contact alone',
     panelOf({ companyId: '', panel: 'CGHS' }, COMPANIES), 'CGHS');
  eq('the company is believed first',
     panelOf({ companyId: 'co_dgehs', panel: 'CGHS' }, COMPANIES), 'DGEHS');
  eq('a company that no longer exists falls back to the panel',
     panelOf({ companyId: 'gone', panel: 'CGHS' }, COMPANIES), 'CGHS');
  eq('and to nothing when there is nothing', panelOf({ companyId: 'gone' }, COMPANIES), '');
  eq('a company with a blank name falls back too',
     panelOf({ companyId: 'co_blank', panel: 'CGHS' }, COMPANIES), 'CGHS');
  eq('whitespace is not a panel', panelOf({ panel: '   ' }, COMPANIES), '');
  eq('no panel is no panel', panelOf({ companyId: '', panel: '' }, COMPANIES), '');
  eq('nothing at all is not a crash', panelOf(null, COMPANIES), '');
  eq('and nor are no companies', panelOf({ panel: 'CGHS' }, undefined), 'CGHS');
}

// ── the filter itself, lifted out and run ───────────────────────────────
// Rebuilt from the source exactly: matchesPanel, matchesSearch, the array
// and the counts, so what runs here is what runs on screen.
const F = crm.indexOf('    function matchesPanel(c, want){');
const G = crm.indexOf("    panelNames.sort(", F);
ok('the filter was found', F > 0 && G > F, `${F}..${G}`);
const CONTACTS = [
  // On a panel, properly filed.
  { id: 'k1', firstName: 'Deepa', lastName: 'Tyagi', uhid: 'KB201', panel: 'CGHS', companyId: 'co_cghs', phone: '8700605496' },
  { id: 'k2', firstName: 'Lata', lastName: 'Sharma', uhid: 'KB202', panel: 'CGHS', companyId: 'co_cghs', phone: '9643362292' },
  // On a panel, company never filled in -- reads "Santosh CGHS" on screen.
  { id: 'k3', firstName: 'Santosh', uhid: 'KB203', panel: 'CGHS', companyId: '', phone: '9643895312' },
  { id: 'k4', firstName: 'Shankar', lastName: 'Lal', uhid: 'KB204', panel: 'CGHS', companyId: '', phone: '9643895312' },
  // On a different panel.
  { id: 'k5', firstName: 'Ram', uhid: 'KB205', panel: 'DGEHS', companyId: 'co_dgehs', phone: '9810000005' },
  // Nobody's panel. These are the three the clinic saw in the CGHS list.
  { id: 'k6', firstName: 'Umesh', lastName: 'Jain', uhid: 'KB206', panel: '', companyId: '', phone: '9810946460' },
  { id: 'k7', firstName: 'Saaransh', lastName: 'Kharbanda', uhid: 'KB207', panel: '', companyId: '', phone: '9999971007' },
  { id: 'k8', firstName: 'Numa', lastName: 'Samar', uhid: 'KB208', panel: '   ', companyId: '', phone: '7004835865' }
];
function screen(want, search) {
  const box = {
    Object, String, Array, JSON,
    st: { contacts: CONTACTS, companies: COMPANIES,
          contactCompany: want || '', contactSearch: search || '' },
    panelOf,
    sameName: (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(),
    contactName: c => {
      const nm = ((c.firstName || '') + (c.lastName ? ' ' + c.lastName : '')).trim();
      const p = String(c.panel || '').trim();
      return p ? (nm + ' ' + p) : nm;
    }
  };
  vm.createContext(box);
  vm.runInContext(crm.slice(F, G) +
    '\n;globalThis.__rows = filtered;' +
    '\n;globalThis.__counts = compCounts;' +
    '\n;globalThis.__names = panelNames;', box);
  return { rows: box.__rows, counts: box.__counts, names: box.__names };
}

// ── choosing CGHS shows the CGHS patients, and only them ────────────────
{
  const r = screen('CGHS');
  eq('four rows', r.rows.length, 4);
  eq('and they are the four on CGHS', r.rows.map(c => c.id), ['k1', 'k2', 'k3', 'k4']);
  // THE COMPLAINT. None of these may appear.
  for (const id of ['k6', 'k7', 'k8'])
    ok(id + ' has no panel and is not in the panel list', !r.rows.some(c => c.id === id));
  ok('somebody on another panel is not either', !r.rows.some(c => c.id === 'k5'));
  // The two whose company was never filled in are the point: they used to
  // be missing from this list while their own name said CGHS.
  ok('a patient whose company was never filled in is still on the list',
     r.rows.some(c => c.id === 'k3') && r.rows.some(c => c.id === 'k4'));
}
// ── the number beside the button is the number of rows ──────────────────
// They are the same array, so they cannot disagree -- which is exactly what
// the clinic was looking at when the count said four and the list showed
// seven.
for (const want of ['', 'CGHS', 'DGEHS', 'none', 'cghs', '  CGHS  ']) {
  const r = screen(want);
  const expect = want === '' ? CONTACTS.length
               : want === 'none' ? r.counts.none
               : r.counts[Object.keys(r.counts).filter(k =>
                   k.toLowerCase() === String(want).trim().toLowerCase())[0]];
  eq('"' + want + '": the dropdown number is the row count', r.rows.length, expect);
}
{
  const r = screen('');
  eq('the dropdown offers the panels people are actually on', r.names, ['CGHS', 'DGEHS']);
  eq('CGHS counts everyone on CGHS, however it was recorded', r.counts.CGHS, 4);
  eq('DGEHS counts its one', r.counts.DGEHS, 1);
  eq('and three are on no panel', r.counts.none, 3);
  eq('every contact is counted exactly once',
     r.counts.none + r.counts.CGHS + r.counts.DGEHS, CONTACTS.length);
}
{
  const r = screen('none');
  eq('"No panel" shows the three', r.rows.map(c => c.id), ['k6', 'k7', 'k8']);
  ok('and nobody on a panel', !r.rows.some(c => String(c.panel || '').trim() || c.companyId));
}
{
  // Case and spacing in a hand-typed panel must not split one panel in two.
  const r = screen('cghs');
  eq('the panel is matched without case', r.rows.length, 4);
}

// ── search and panel apply together ─────────────────────────────────────
{
  eq('searching within a panel', screen('CGHS', 'santosh').rows.map(c => c.id), ['k3']);
  eq('a search that leaves the panel finds nobody', screen('CGHS', 'umesh').rows.length, 0);
  eq('searching everybody still works', screen('', 'umesh').rows.map(c => c.id), ['k6']);
  eq('by phone', screen('', '9999971007').rows.map(c => c.id), ['k7']);
  eq('by UHID', screen('', 'kb204').rows.map(c => c.id), ['k4']);
  // The name on screen carries the panel, so searching it must work.
  eq('by the name as it is shown', screen('', 'shankar lal cghs').rows.map(c => c.id), ['k4']);
}

// ── the screen is built from that one array ─────────────────────────────
ok('the rows are the filtered array', /filtered\.length\?filtered\.map\(function\(c\)\{/.test(crm));
ok('the count beside the button is too',
   /filtered\.length\+' of '\+st\.contacts\.length/.test(crm));
ok('and so is the export', /\+filtered\.map\(function\(c\)\{/.test(crm));
ok('the dropdown is built from the same counts',
   /panelNames\.map\(function\(nm\)\{/.test(crm) &&
   /nm \+ ' \(' \+ \(compCounts\[nm\]\|\|0\) \+ '\)'/.test(crm));
// Filtering on the company id is what hid the patients whose company was
// never filled in.
ok('nothing filters on the company id any more',
   !/return c\.companyId===want;/.test(crm) && !/if\(want==='none'\) return !c\.companyId;/.test(crm));
ok('and nobody on a panel is labelled Individual',
   /panelOf\(c, st\.companies\)\|\|'Individual'/.test(crm) &&
   !/\)\|\|\{\}\)\.name\|\|'—':'Individual'/.test(crm));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
