// "in endorsement if we are adding more than one tooth in teeth number it
//  should calculate number of units and put them in unit box but if it is
//  arch, full mouth, Quadrant it should be counted as 1 unit."
//
// The units box is what the panel is billed on, and it was being typed by
// hand next to a tooth box that already said the answer. Two teeth, two
// units. A whole arch is one unit however many teeth it covers -- the panel
// pays for the arch, not for sixteen teeth -- and so is a quadrant and the
// full mouth.
//
// unitsFromTeeth is run here, not read: an off-by-one in a claim is money.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
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

const cut = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));
const ctx = { String, Number };
vm.createContext(ctx);
vm.runInContext(cut('const TOOTH_REGIONS = [', 'const LOWER_T =')
  + '\nthis.units = unitsFromTeeth; this.regions = TOOTH_REGIONS;', ctx);
const u = ctx.units;

// ── teeth ───────────────────────────────────────────────────────────────
eq('one tooth is one unit', u('16'), 1);
eq('a crown on 16 and 26 is two units', u('16, 26'), 2);
eq('three teeth, three units', u('16, 26, 36'), 3);
// A bridge is picked as a range and arrives as its teeth: 13-16 is four units.
eq('a four-unit bridge counts four', u('13, 14, 15, 16'), 4);
eq('spacing typed by hand does not change the count', u('16,26 ,  36'), 3);
eq('a trailing comma is not a tooth', u('16, 26,'), 2);

// ── regions ─────────────────────────────────────────────────────────────
// Every region the grid can produce, taken from the grid's own list rather
// than retyped here: a region added later must not quietly start counting
// as sixteen units.
ctx.regions.forEach(r => {
  eq(r.value + ' is one unit', u(r.value), 1);
});
eq('all seven regions were checked', ctx.regions.length, 7);
eq('and the case it is typed in does not matter', u('full mouth'), 1);

// ── nothing, and nonsense ───────────────────────────────────────────────
eq('a line with no tooth is still one unit', u(''), 1);
eq('as is a blank one', u('   '), 1);
eq('undefined is one unit, not zero', u(undefined), 1);
eq('null too', u(null), 1);
// Never zero. A zero-unit line bills nothing and reads as an error on a
// claim that is otherwise correct.
['', '  ', ',', ', ,', undefined, null, 'Full Mouth', '16'].forEach(v => {
  ok('never zero units, for ' + JSON.stringify(v), u(v) >= 1, u(v));
});

// ── and it is wired to both endorsement screens ─────────────────────────
// Treatment Plan Document 3 and Records stage 1 are two separate screens
// over the same plan. A rule on one of them is a rule the clinic cannot
// rely on.
const wired = (fn) => {
  const body = cut(fn, '\n  const ');
  return /qty: unitsFromTeeth\(/.test(body);
};
ok('picking a tooth on the Treatment Plan sets the units',
   wired('const endClickTooth = (t) => {'));
ok('and picking a range does', wired('const endClickRange = (span) => {'));
ok('and picking a region does', wired('const endClickRegion = (v) => {'));
ok('picking a tooth in Records sets the units', wired('const onTooth = (t) => {'));
ok('and picking a range does', wired('const onRange = (span) => {'));
ok('and picking a region does', wired('const onRegion = (v) => {'));

// The units box stays typeable. A number entered by hand is somebody's
// decision -- a procedure billed per visit, a part-claim -- and only the
// teeth changing recomputes it.
ok('the units box can still be typed in',
   /setRowField\(x\.at, "qty", e\.target\.value\.replace\(\/\[\^0-9\]\/g, ""\)\)/.test(html));
ok('and nothing recomputes it on every render',
   !/qty: unitsFromTeeth\(x\.r\.tooth\)/.test(html) &&
   !/const qty = unitsFromTeeth/.test(html));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
