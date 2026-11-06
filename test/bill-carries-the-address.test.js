// "in Billing of Panel Patients I need the address also"
//
// The bill already had an Address line. It printed blank, and that is the
// whole bug: it read pat.address, and `pat` on the CGHS screens is the
// globally selected patient -- which is sometimes the whole registration and
// sometimes a UHID and a name, depending on which screen selected them. The
// day sheet, a warning and half a dozen lists all set it from what they had.
//
// So the record is topped up from the register, and the address is kept WITH
// the bill: a patient who moves house must not change a bill that has
// already gone to the panel.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
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

// ── the screens ─────────────────────────────────────────────────────────
ok('the bill prints an Address line',
   /kv\("Address", pat\.address \|\| pat\.Address \|\| ""\)/.test(html));
ok('a reprint from Finance prints it too',
   /kv\("Address", b\.address \|\| ""\)/.test(html));
ok('and the bill is saved with it',
   /address: pat\.address \|\| pat\.Address \|\| "",/.test(html));

// The three stages are handed the topped-up record, not the thin one.
ok('the CGHS screens top the patient up from the register',
   /api\("getPatient", \{ uhid \}\)\.then\(res => \{\s*if \(!dropped && res && res\.success && res\.patient\) setFull\(res\.patient\);/.test(html));
ok('the bill is given that record', /CghsBill, \{ pat: pat,/.test(html));
ok('and so is the prescription', /CghsPrescription, \{ pat: pat, lines: e\.approved \}/.test(html));
ok('neither is handed the raw selection any more',
   !/CghsBill, \{ pat: globalPat/.test(html) && !/CghsPrescription, \{ pat: globalPat/.test(html));

// ── the merge, run rather than read ─────────────────────────────────────
// This is the part with a way to go wrong: a blank from the register
// wiping a name the search screen already had.
{
  const src = html.slice(html.indexOf('  const pat = React.useMemo(() => {'),
                         html.indexOf('  if (!globalPat || !globalPat.uhid) {'));
  ok('the merge was found', src.length > 100, src.length);
  const ctx = { String, Object, React: { useMemo: (f) => f() } };
  vm.createContext(ctx);
  // Each call gets its own scope, or the second redeclares `pat`.
  const make = vm.runInContext('(function (globalPat, full) {\n' + src + '\nreturn pat; })', ctx);
  const run = (globalPat, full) => make(globalPat, full);

  eq('with nothing from the register the selection stands',
     run({ uhid: 'AL1010', name: 'Santosh' }, null), { uhid: 'AL1010', name: 'Santosh' });
  eq('the register fills in what the selection never had',
     run({ uhid: 'AL1010', name: 'Santosh' },
         { uhid: 'AL1010', name: 'Santosh Kumar', address: 'B-12, Lajpat Nagar, New Delhi' }),
     { uhid: 'AL1010', name: 'Santosh Kumar', address: 'B-12, Lajpat Nagar, New Delhi' });
  {
    // Compared field by field: the order the keys land in is not the point.
    const got = run({ uhid: 'AL1010', name: 'Santosh', mobile: '9811000000' },
                    { uhid: 'AL1010', name: '', address: 'B-12', mobile: '   ' });
    eq('a blank name from the register does not wipe the one on screen', got.name, 'Santosh');
    eq('nor a blank mobile', got.mobile, '9811000000');
    eq('and the address still arrives', got.address, 'B-12');
  }
}

// ── the register keeps it ───────────────────────────────────────────────
ok('Address is a column of the bill register',
   /"Saved At",[\s\S]{0,400}"Address"\]/.test(gs));
// Appended, never inserted: every column before it is read by position.
{
  // Scoped to this declaration: "Saved At" is a heading in other sheets too.
  const decl = gs.slice(gs.indexOf('var CGHS_BILL_HEADERS = ['),
                        gs.indexOf('];', gs.indexOf('var CGHS_BILL_HEADERS = [')));
  ok('and it is the LAST column, so no bill already written shifts',
     decl.indexOf('"Saved At"') >= 0 && decl.indexOf('"Saved At"') < decl.indexOf('"Address"')
     && decl.lastIndexOf('"') === decl.lastIndexOf('"Address"') + '"Address'.length, decl);
}
ok('the bill row carries it', /safeJSON\(p\.lines\), new Date\(\)\.toISOString\(\), p\.address \|\| ""/.test(gs));
ok('and it is read back', /address: String\(data\[i\]\[10\] \|\| ""\)/.test(gs));
ok('a sheet written by an earlier build has the heading added, not assumed',
   /ensureGridWidth_\(sh, CGHS_BILL_HEADERS\.length\);\s*sh\.getRange\(1, 1, 1, CGHS_BILL_HEADERS\.length\)\.setValues\(\[CGHS_BILL_HEADERS\]\);/.test(gs));

// ── old bills ───────────────────────────────────────────────────────────
// Bills written before this still reprint with an address, from the
// register, rather than with a blank line.
{
  const src = gs.slice(gs.indexOf('function regAddressFor_(uhid) {'),
                       gs.indexOf('// Every CGHS bill, or one patient\'s.'));
  ok('there is a fallback for bills written before this', src.length > 200, src.length);
  const DATA = [
    ['UHID', 'Full Name', 'Complete Address', 'Timestamp'],
    ['AL1010', 'Santosh', 'B-12, Lajpat Nagar', '2024-01-01T00:00:00Z'],
    ['AL1010', 'Santosh', 'C-9, Saket', '2026-01-01T00:00:00Z'],
    ['AL1011', 'Meena', '', '2025-01-01T00:00:00Z']
  ];
  let reads = 0;
  const ctx = {
    String, Number, Date, isNaN,
    regAllRows_: () => { reads++; return DATA; },
    findRegColumn_: (headers, names) => {
      for (const n of names) {
        const i = headers.findIndex(h => String(h).trim().toLowerCase() === String(n).trim().toLowerCase());
        if (i >= 0) return i;
      }
      return -1;
    },
    regLatestByUhid_: (data, col) => {
      const best = {};
      for (let i = 1; i < data.length; i++) best[String(data[i][col]).toUpperCase()] = { row: i };
      return best;
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.addr = regAddressFor_;', ctx);
  eq('the address on file is found', ctx.addr('AL1010'), 'C-9, Saket');
  eq('the LATEST registration wins, not the first', ctx.addr('al1010'), 'C-9, Saket');
  eq('a patient with no address gives nothing, not undefined', ctx.addr('AL1011'), '');
  eq('an unknown patient gives nothing', ctx.addr('AL9999'), '');
  eq('no UHID asks nothing of the register', ctx.addr(''), '');
  ok('and the register is only consulted when there is a UHID to look up',
     reads === 4, reads);
}
// A stored address is used as it is; the register is only a fallback.
ok('a bill that has an address does not go looking for another',
   /String\(data\[i\]\[10\] \|\| ""\) \|\| regAddressFor_\(/.test(gs));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
