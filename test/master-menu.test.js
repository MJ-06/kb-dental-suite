// "the Notes tab in master should be moved to Clinical configuration I leave
//  it on you if shifting as a group or 3 different tabs which are under notes"
//
// Three subtabs, not a group nested inside one. This menu is two deep
// everywhere else, and a third level for three items would cost a click on
// the most-used screen in Master to tidy the one above it.
//
// A menu is data, so the thing that goes wrong when it is rearranged is not
// the menu: it is a subtab that no longer has a screen behind it, or a
// screen with nothing left that opens it, or a message on some other page
// still telling staff to go where the tab used to be. None of those shows
// up by looking at the menu.
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

const MENU = vm.runInNewContext(
  html.slice(html.indexOf('const MASTER_STRUCTURE = ['),
             html.indexOf('\n];', html.indexOf('const MASTER_STRUCTURE = [')) + 3)
  + '\nMASTER_STRUCTURE');
ok('the menu was read', MENU.length > 5, MENU.length);

const group = (id) => MENU.find(t => t.id === id);
const subs = (id) => (group(id).subtabs || []).map(s => s.id);

// ── the move ────────────────────────────────────────────────────────────
eq('there is no Notes category any more', group("notes"), undefined);
ok('and nothing else is called Notes',
   !MENU.some(t => String(t.label).toLowerCase() === "notes"),
   JSON.stringify(MENU.map(t => t.label)));
eq('the three lists are under Clinical Configuration, in order, with the brands',
   subs("clinicalConfig"), ["templates", "medInstructions", "medNotes", "implantBrands"]);
// The category opens on its first subtab, so what comes first is a choice.
eq('it opens on the clinical note templates, not the implant brands',
   group("clinicalConfig").subtabs[0].id, "templates");
// Two levels, as everywhere else. A subtab holding subtabs would be a third.
ok('no subtab has subtabs of its own',
   MENU.every(t => (t.subtabs || []).every(s => !s.subtabs)),
   JSON.stringify(MENU.find(t => (t.subtabs || []).some(s => s.subtabs))));

// "Instructions" is patient advice -- oral hygiene, diet, follow-up -- not
// how to take a drug. Under a heading that said Notes the bare word carried;
// beside Clinical Note Templates and Implant Brands it does not.
eq('the instruction list says whose instructions they are',
   group("clinicalConfig").subtabs.find(s => s.id === "medInstructions").label,
   "Patient Instructions");
ok('and it really is patient advice, which is why it sits here',
   /const INSTRUCTION_CATEGORIES = \["Oral Hygiene"/.test(html));

// ── nothing was displaced on the way ────────────────────────────────────
eq('the other categories are where they were',
   MENU.map(t => t.id),
   ["organization", "clinic", "schedule", "patient", "clinicalConfig", "prescriptions",
    "accounts", "security", "sales"]);
eq('the prescription lists are untouched',
   subs("prescriptions"), ["drugCategories", "medicines", "medDosages",
                           "medFrequencies", "medDurations"]);
eq('Security and the Sales Tracker still stand alone',
   [group("security").subtabs, group("sales").subtabs], [null, null]);

// ── every subtab still has a screen, and every screen an opener ─────────
// The real risk of moving a tab by hand: an id typed slightly differently
// renders nothing at all, and the page shows an empty panel rather than an
// error.
const CONTENT = html.slice(html.indexOf('  const CONTENT = {'),
                           html.indexOf('\n  };', html.indexOf('  const CONTENT = {')));
const rendered = [...CONTENT.matchAll(/\n    (\w+): \(\) =>/g)].map(m => m[1]);
ok('the screens were read', rendered.length > 20, rendered.length);

const wanted = [];
MENU.forEach(t => {
  // A category with no subtabs is its own screen, opened by the top button.
  if (!t.subtabs) { wanted.push(t.id); return; }
  t.subtabs.forEach(s => { if (!s.placeholder) wanted.push(s.id); });
});
const missing = wanted.filter(id => rendered.indexOf(id) < 0);
eq('every subtab the menu offers has a screen behind it', missing, []);
const orphaned = rendered.filter(id => wanted.indexOf(id) < 0);
eq('and no screen is left with nothing to open it', orphaned, []);

// A placeholder is deliberate: it says it is coming rather than opening blank.
eq('the two placeholders are still marked as such',
   MENU.flatMap(t => (t.subtabs || []).filter(s => s.placeholder).map(s => s.id)),
   ["drugCategories", "accountHeads"]);

// ── and nothing still sends staff to the old place ──────────────────────
// A message naming a path is a path that has to exist. This one is on the
// CGHS prescription, three screens away from the menu that changed.
ok('nothing points at Master > Notes any more',
   !/Master \\u2192 Notes/.test(html) && !/Master → Notes/.test(html),
   (html.match(/Master → Notes[^"]{0,60}/) || [])[0]);
ok('the prescription sends them to the category the templates are in',
   /add them in Master \\u2192 Clinical Configuration \\u2192 Clinical Note Templates/.test(html)
   || /add them in Master → Clinical Configuration → Clinical Note Templates/.test(html));
// Every Master path named on screen must name a category that exists.
{
  const labels = MENU.map(t => String(t.label).toLowerCase());
  const named = [...html.matchAll(/Master (?:\\u2192|→) ([A-Za-z][A-Za-z /&]*?) (?:\\u2192|→)/g)]
    .map(m => m[1].trim());
  const unknown = [...new Set(named)].filter(c => labels.indexOf(c.toLowerCase()) < 0);
  eq('every Master path on screen names a category that exists', unknown, []);
}

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
