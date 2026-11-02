// "In Patient in Master rename the flag as Safety Flags, and insert the
//  screenshot style."
//
// Master -> Patient -> Flags was a placeholder. It is now Safety Flags, laid
// out the way the clinic asked: one box with "Type new entry here", an Add
// button, then "Available entries:" numbered Sr / Name with a Delete apiece.
//
// A safety flag is what the staff need to know BEFORE the patient sits down
// -- apprehensive, on psychiatric treatment. The five from the screenshot
// are what a tab nobody has filled in starts with, and the clinic edits from
// there; they are not fixed in code.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── renamed, and no longer a placeholder ────────────────────────────────
ok('the tab is called Safety Flags', /\{ id:"flags",          label:"Safety Flags" \}/.test(html));
ok('and is not a placeholder any more', !/id:"flags",\s+label:"Flags", placeholder:true/.test(html));
ok('it is under Patient, where it was',
   /\{ id:"patient", label:"Patient", subtabs:\[[\s\S]{0,200}id:"flags"/.test(html));
// One screen serves every list Master keeps this way; the heading, the
// blurb and the word for an empty list are passed in.
ok('and it is wired to the shared screen',
   /flags: \(\) => React\.createElement\(EntryListEditor, \{\n      title:"Safety Flags", noun:"flags",/.test(html));

// ── the clinic book keeps the list ──────────────────────────────────────
ok('the sheet has a tab of its own', /var SAFETY_FLAGS_SHEET = "Safety Flags";/.test(gs));
ok('a tab nobody filled in starts with the usual five',
   /DEFAULT_SAFETY_FLAGS = \[[\s\S]{0,200}"Apprehensive"[\s\S]{0,200}"Psychiatric Treatment"/.test(gs));
for (const f of ['Apprehensive', 'Mentally Challenged', 'Neurological Issue',
                 'Physically Challenged', 'Psychiatric Treatment'])
  ok('"' + f + '" is one of them', gs.indexOf('"' + f + '"') > 0);
ok('reading is routed', /case "getSafetyFlagsList":         return getSafetyFlagsList\(\);/.test(gs));
ok('and writing', /case "saveSafetyFlagsList":        return saveSafetyFlagsList\(p\);/.test(gs));
ok('a payload cut short in transit is refused, like the other lists',
   /parseList_\(p\.flags, "safety flags"\)/.test(gs));
ok('Master fetches it with everything else', /"getSafetyFlagsList", "getOccupationsList"/.test(html));
// The batch and the destructure have to stay in step, or every list after
// the one that moved is read from the wrong answer.
ok('and takes it off the same destructure, in the same order',
   /,wd,ct,sf,oc,rs,pt\]\) =>/.test(html));
ok('an older backend without it is survivable', /if \(sf && sf\.success\) setSafetyFlags\(sf\.flags \|\| \[\]\);/.test(html));
ok('saving goes through the usual path',
   /persist\("saveSafetyFlagsList", \{ flags: JSON\.stringify\(arr\) \}/.test(html));

// ── the screen, rendered and driven ─────────────────────────────────────
const A = html.indexOf('function EntryListEditor({ title, blurb, noun, items, onAdd, onRemove }) {');
const B = html.indexOf('// When the day runs, and how long a slot is.', A);
ok('the screen was found', A > 0 && B > A, `${A}..${B}`);
const SRC = html.slice(A, B);
const DEPS = `
  const T = "#0078B4", BORDER = "#e5e5e0", BGS = "#f5f5f0";
  const inp = { padding:"8px", border:"1px solid #e5e5e0", borderRadius:6, fontSize:13, fontFamily:"inherit" };
  window.__added = []; window.__removed = [];
`;
const FIVE = ['Apprehensive', 'Mentally Challenged', 'Neurological Issue',
              'Physically Challenged', 'Psychiatric Treatment'];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: DEPS });
  await page.addScriptTag({ content: SRC });

  async function mount(items) {
    await page.evaluate(list => {
      window.__added = []; window.__removed = [];
      const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
      root.render(null);
      window.__items = list;
    }, items);
    await page.waitForTimeout(40);
    await page.evaluate(() => {
      window.__root.render(React.createElement(EntryListEditor, {
        title: 'Safety Flags', noun: 'flags',
        blurb: 'What the staff need to know before the patient sits down.',
        items: window.__items,
        onAdd: v => window.__added.push(v),
        onRemove: i => window.__removed.push(i) }));
    });
    await page.waitForTimeout(70);
  }

  await mount(FIVE);
  const text = await page.evaluate(() => document.body.innerText);
  ok('it drew', text.length > 40, text.slice(0, 100));
  ok('headed Safety Flags', /Safety Flags/.test(text));
  ok('with "Available entries:"', /Available entries:/.test(text));
  ok('the box says what to do', !!(await page.locator('input[placeholder="Type new entry here"]').count()));
  ok('there is an Add button', !!(await page.getByRole('button', { name: 'Add' }).count()));

  // The list, numbered, with a Delete apiece — the screenshot's shape.
  eq('every entry is listed', await page.getByRole('button', { name: 'Delete' }).count(), 5);
  const rows = await page.evaluate(() => document.body.innerText);
  for (let i = 0; i < FIVE.length; i++)
    ok('"' + FIVE[i] + '" is row ' + (i + 1),
       new RegExp('\\b' + (i + 1) + '\\n' + FIVE[i].replace(/ /g, '\\s')).test(rows), rows.slice(0, 300));
  ok('the columns are Sr and Name', /Sr\nName/.test(rows), rows.slice(0, 200));

  // ── adding ────────────────────────────────────────────────────────────
  await page.locator('input[placeholder="Type new entry here"]').fill('Latex Allergy');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.waitForTimeout(60);
  eq('Add passes the entry up', await page.evaluate(() => window.__added), ['Latex Allergy']);
  eq('and the box is cleared for the next one',
     await page.locator('input[placeholder="Type new entry here"]').inputValue(), '');

  // Enter does the same thing, because somebody typing a list will use it.
  await mount(FIVE);
  await page.locator('input[placeholder="Type new entry here"]').fill('Wheelchair User');
  await page.locator('input[placeholder="Type new entry here"]').press('Enter');
  await page.waitForTimeout(60);
  eq('Enter adds it too', await page.evaluate(() => window.__added), ['Wheelchair User']);

  // ── what must not be added ────────────────────────────────────────────
  // Nothing to add means the button cannot be pressed, rather than being
  // pressed and quietly doing nothing.
  await mount(FIVE);
  ok('an empty box leaves Add disabled',
     await page.getByRole('button', { name: 'Add' }).isDisabled());
  await page.locator('input[placeholder="Type new entry here"]').fill('   ');
  await page.waitForTimeout(50);
  ok('and so does whitespace',
     await page.getByRole('button', { name: 'Add' }).isDisabled());
  await page.locator('input[placeholder="Type new entry here"]').press('Enter');
  await page.waitForTimeout(50);
  eq('Enter on a blank box adds nothing either',
     await page.evaluate(() => window.__added), []);
  await page.locator('input[placeholder="Type new entry here"]').fill('Something');
  await page.waitForTimeout(50);
  ok('typing enables it', !(await page.getByRole('button', { name: 'Add' }).isDisabled()));

  // The same flag twice is somebody typing it again, not a second flag.
  await page.locator('input[placeholder="Type new entry here"]').fill('apprehensive');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.waitForTimeout(60);
  eq('one already on the list is refused', await page.evaluate(() => window.__added), []);
  ok('whatever the case it was typed in',
     /is already on the list/.test(await page.evaluate(() => document.body.innerText)));
  // ...and the warning goes once they start typing something else.
  await page.locator('input[placeholder="Type new entry here"]').fill('Apprehensive x');
  await page.waitForTimeout(60);
  ok('the warning clears when they type again',
     !/is already on the list/.test(await page.evaluate(() => document.body.innerText)));

  // ── deleting ──────────────────────────────────────────────────────────
  await mount(FIVE);
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Delete' }).nth(2).click();
  await page.waitForTimeout(60);
  eq('Delete removes the row it is on', await page.evaluate(() => window.__removed), [2]);
  // A misclick on a short list is otherwise silent, so it asks first.
  await mount(FIVE);
  let asked = '';
  page.once('dialog', d => { asked = d.message(); d.dismiss(); });
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await page.waitForTimeout(60);
  ok('it asks first, and names which', /Apprehensive/.test(asked), asked);
  eq('and saying no removes nothing', await page.evaluate(() => window.__removed), []);

  // ── an empty list ─────────────────────────────────────────────────────
  await mount([]);
  const empty = await page.evaluate(() => document.body.innerText);
  ok('an empty list says so, and names what is missing', /No flags yet/.test(empty), empty);
  ok('and still offers the box', !!(await page.locator('input[placeholder="Type new entry here"]').count()));

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
