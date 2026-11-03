// "Insert the following under Referral Source, and add an edit tab along
//  with delete."
//
// The clinic's own thirteen sources, and renaming in place on every one of
// these screens.
//
// Renaming matters more than it looks. Without it a typo on a list people
// pick FROM has to be deleted and typed again — and on a list already in
// use that orphans every record naming the old spelling. "Refered by
// External Dr." was exactly that, which is why it is corrected here rather
// than shipped and then deleted.
//
// And the clinic's tab already held the six this shipped with. A tab still
// holding exactly those has never been curated, so it is replaced wholesale;
// one that differs by so much as an entry has been edited by somebody and is
// left alone. That also makes it run once without a marker — afterwards it
// no longer matches.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the list the clinic asked for ───────────────────────────────────────
const WANT = [
  "Instagram", "Facebook", "Website", "Referred by old patient", "Family/Friends",
  "Walk in", "Referred by Internal Dr.", "Referred by External Dr.", "Practo",
  "Referred by Family Friend", "Referred by Internal Staff", "Known", "Just Dial"
];
const listed = (() => {
  const a = gs.indexOf('var DEFAULT_REFERRAL_SOURCES = [');
  const b = gs.indexOf('];', a);
  return (gs.slice(a, b).match(/"([^"]+)"/g) || []).map(x => x.slice(1, -1));
})();
eq('all thirteen, in the order given', listed, WANT);
// Said out loud rather than quietly: their note read "Refered by External
// Dr." and "Referred by Internal Staff " with a trailing space.
ok('the misspelling is corrected, not carried into a dropdown',
   listed.indexOf("Referred by External Dr.") >= 0 && listed.indexOf("Refered by External Dr.") < 0);
ok('and nothing carries a trailing space', listed.every(x => x === x.trim()), listed.join('|'));

// ── replacing a tab nobody has touched ──────────────────────────────────
{
  const a = gs.indexOf('function sameListIgnoringCase_(a, b) {');
  const b = gs.indexOf('\n}', a) + 2;
  const box = { String, Array };
  vm.createContext(box);
  vm.runInContext(gs.slice(a, b) + '\n;globalThis.__same = sameListIgnoringCase_;', box);
  const LEGACY = ["An Existing Patient", "Website", "Word of Mouth",
                  "Sign Board", "Social Media", "Google"];
  ok('the six it shipped with are recognised', box.__same(LEGACY, LEGACY));
  ok('whatever order they are in', box.__same(LEGACY.slice().reverse(), LEGACY));
  ok('and whatever case or spacing', box.__same(LEGACY.map(x => '  ' + x.toUpperCase() + ' '), LEGACY));
  ok('one entry added means somebody has curated it',
     !box.__same(LEGACY.concat(['Practo']), LEGACY));
  ok('one removed, likewise', !box.__same(LEGACY.slice(1), LEGACY));
  ok('one renamed, likewise', !box.__same(['Walk in'].concat(LEGACY.slice(1)), LEGACY));
  ok('and the clinic’s own thirteen are not mistaken for them', !box.__same(WANT, LEGACY));
  for (const junk of [null, undefined, []])
    ok('nothing is not the six: ' + JSON.stringify(junk), !box.__same(junk, LEGACY));
}
ok('an untouched tab is rewritten with the clinic’s list',
   /if \(sameListIgnoringCase_\(items, LEGACY_REFERRAL_SOURCES\)\) \{[\s\S]{0,200}DEFAULT_REFERRAL_SOURCES\.forEach/.test(gs));
ok('and what it reports back is what it just wrote',
   /items = DEFAULT_REFERRAL_SOURCES\.slice\(\);/.test(gs));

// ── Edit, on every one of these lists ───────────────────────────────────
for (const tab of ['referralSource', 'patientType', 'flags', 'occupation'])
  ok(tab + ' can be renamed',
     new RegExp(tab + ': \\(\\) => React\\.createElement\\(EntryListEditor, \\{[\\s\\S]{0,700}onEdit:\\(i,v\\)=>').test(html));

const A = html.indexOf('function EntryListEditor({ title, blurb, noun, items, onAdd, onRemove, onEdit }) {');
const B = html.indexOf('// When the day runs, and how long a slot is.', A);
ok('the shared screen was found', A > 0 && B > A, `${A}..${B}`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const T = "#0078B4", BORDER = "#e5e5e0", BGS = "#f5f5f0";
    const MASTER_LIST_WIDTH = ${(/const MASTER_LIST_WIDTH = (\d+);/.exec(html) || [])[1]};
    const inp = { padding:"8px", border:"1px solid #e5e5e0", borderRadius:6, fontSize:13, fontFamily:"inherit" };
  ` });
  await page.addScriptTag({ content: html.slice(A, B) });

  const ITEMS = ['Instagram', 'Facebook', 'Walk in'];
  async function mount(items) {
    await page.evaluate(i => {
      window.__edited = []; window.__removed = []; window.__added = [];
      const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
      root.render(null); window.__i = i;
    }, items);
    await page.waitForTimeout(30);
    await page.evaluate(() => {
      window.__root.render(React.createElement(EntryListEditor, {
        title: 'Referral Source', noun: 'referral sources', blurb: 'b', items: window.__i,
        onAdd: v => window.__added.push(v),
        onRemove: i => window.__removed.push(i),
        onEdit: (i, v) => window.__edited.push([i, v]) }));
    });
    await page.waitForTimeout(60);
  }
  const editBox = () => page.locator('table input, input').last();

  // ── renaming ──────────────────────────────────────────────────────────
  await mount(ITEMS);
  eq('every row has an Edit', await page.getByRole('button', { name: 'Edit' }).count(), 3);
  eq('and a Delete', await page.getByRole('button', { name: 'Delete' }).count(), 3);
  await page.getByRole('button', { name: 'Edit' }).nth(1).click();
  await page.waitForTimeout(50);
  eq('only the row being renamed turns into a box',
     await page.getByRole('button', { name: 'Edit' }).count(), 2);
  eq('and it offers Save and Cancel',
     [await page.getByRole('button', { name: 'Save' }).count(),
      await page.getByRole('button', { name: 'Cancel' }).count()], [1, 1]);
  await editBox().fill('Facebook Ads');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(60);
  eq('saving renames that row', await page.evaluate(() => window.__edited), [[1, 'Facebook Ads']]);
  eq('and nothing is deleted on the way', await page.evaluate(() => window.__removed), []);

  // Enter saves, Escape abandons — anybody fixing a typo will reach for both.
  await mount(ITEMS);
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await editBox().fill('Insta');
  await editBox().press('Enter');
  await page.waitForTimeout(60);
  eq('Enter saves it', await page.evaluate(() => window.__edited), [[0, 'Insta']]);

  await mount(ITEMS);
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await editBox().fill('Insta');
  await editBox().press('Escape');
  await page.waitForTimeout(60);
  eq('Escape changes nothing', await page.evaluate(() => window.__edited), []);
  eq('and puts the row back', await page.getByRole('button', { name: 'Edit' }).count(), 3);

  await mount(ITEMS);
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await editBox().fill('Insta');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(60);
  eq('Cancel changes nothing either', await page.evaluate(() => window.__edited), []);

  // ── what a rename must refuse ─────────────────────────────────────────
  await mount(ITEMS);
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await editBox().fill('facebook');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(60);
  eq('renaming onto another entry is refused', await page.evaluate(() => window.__edited), []);
  ok('and says why', /is already on the list/.test(await page.evaluate(() => document.body.innerText)));
  await editBox().fill('   ');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(60);
  eq('an empty name is refused', await page.evaluate(() => window.__edited), []);
  ok('and says so', /needs a name/.test(await page.evaluate(() => document.body.innerText)));

  // Its own name is not a duplicate of itself, and saving it unchanged
  // must not write the whole list back to the sheet for nothing.
  await mount(ITEMS);
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(60);
  eq('saving a row unchanged writes nothing', await page.evaluate(() => window.__edited), []);
  eq('and simply closes the row', await page.getByRole('button', { name: 'Edit' }).count(), 3);

  // Adding is unaffected by any of this.
  await mount(ITEMS);
  await page.locator('input[placeholder="Type new entry here"]').fill('Practo');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.waitForTimeout(60);
  eq('adding still works', await page.evaluate(() => window.__added), ['Practo']);

  ok('nothing threw', errors.length === 0, errors.join(' // '));
  await browser.close();

  let pass = 0, fail = 0;
  for (const c of checks) {
    if (c.ok) pass++;
    else {
      fail++;
      console.log('  FAIL  ' + c.name +
        (c.got !== undefined ? '\n          got ' + JSON.stringify(c.got) : '') +
        (c.want !== undefined ? ', wanted ' + JSON.stringify(c.want) : ''));
    }
  }
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  CRASH  ' + ((e && e.stack) || e)); process.exit(1); });
