// "Now make a placeholder after Patient named Clinical Configuration."
//
// Held open with nothing under it yet. The one thing to get right is that
// an empty category must not open to a blank page: Master draws its second
// row from currentTop.subtabs and its content from the chosen subtab, so a
// category with neither would have shown a heading and then nothing at all,
// which reads as broken rather than as not built.
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : '')); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// ── where it sits ───────────────────────────────────────────────────────
const struct = (() => {
  const a = html.indexOf('const MASTER_STRUCTURE = [');
  const b = html.indexOf('\n];', a);
  return html.slice(a, b);
})();
ok('the Master structure was found', struct.length > 200, struct.slice(0, 60));

// Only the top-level ids: each category opens on its own line.
const tops = (struct.match(/^  \{ id:"(\w+)"/gm) || []).map(x => x.replace(/^  \{ id:"/, '').slice(0, -1));
ok('the categories were read', tops.length >= 5, tops.join(','));
ok('Clinical Configuration is there', tops.indexOf('clinicalConfig') >= 0, tops.join(','));
eq('and it comes straight after Patient',
   tops[tops.indexOf('patient') + 1], 'clinicalConfig');
ok('it is named as asked',
   /\{ id:"clinicalConfig", label:"Clinical Configuration", placeholder:true \},/.test(html));
ok('and it holds nothing yet', !/id:"clinicalConfig"[^}]*subtabs/.test(html));

// ── and it does not open blank ──────────────────────────────────────────
ok('an empty category draws the not-built notice',
   /\(currentTop\.placeholder \|\| !\(currentTop\.subtabs && currentTop\.subtabs\.length\)\)\s*\n\s*\? React\.createElement\(MasterPlaceholder, \{ label: currentTop\.label \}\)/.test(html));
ok('the notice says what it is waiting on',
   /" isn't built yet — coming in a follow-up update\."/.test(html));
// The second row is already guarded, so no empty strip of buttons is drawn.
ok('and no empty sub-tab row is drawn', /currentTop\.subtabs && React\.createElement\("div"/.test(html));
// Choosing it must not leave the old category's sub-tab selected underneath.
ok('choosing it clears the sub-tab',
   /const selectTop = \(t\) => \{ setTopTab\(t\.id\); setSubTab\(t\.subtabs \? t\.subtabs\[0\]\.id : null\); \};/.test(html));

// The categories that DO have sub-tabs must be unaffected by the new branch.
for (const id of ['clinic', 'schedule', 'patient', 'prescriptions'])
  ok(id + ' still has its sub-tabs', new RegExp('id:"' + id + '"[^\\n]*subtabs:\\[').test(struct));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
