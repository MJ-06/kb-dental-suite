// "Same way I want the Occupation placeholder, so that we can select in the
//  Registration."
//
// Master -> Patient -> Occupation was a placeholder. It is now the same
// screen as Safety Flags -- literally the same component, with its heading
// and blurb passed in -- and Registration's Occupation box is a dropdown of
// that list instead of a free-text field.
//
// Why a list at all: "Govt. Service", "Government service" and "Govt
// service" are one occupation typed three ways, and no report can add them
// up.
//
// Two things the dropdown must not do, both of which a <select> does by
// default and neither of which anybody would notice:
//
//   1. BLOCK THE DESK. Occupation is a required field. A dropdown with
//      nothing in it -- the list still loading, or a backend that does not
//      serve it -- would stop a patient being registered at all. So until
//      there is a list, the box stays the box it always was.
//
//   2. CHANGE ANYBODY. A <select> whose value is not among its options
//      shows the FIRST option instead. Opening an old patient whose
//      occupation is not on the list and pressing Save would quietly file
//      them as something else.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the tab, and the clinic book behind it ──────────────────────────────
ok('Occupation is no longer a placeholder',
   /\{ id:"occupation",     label:"Occupation" \},/.test(html) &&
   !/id:"occupation",     label:"Occupation", placeholder:true/.test(html));
ok('it uses the same screen as Safety Flags',
   /occupation: \(\) => React\.createElement\(EntryListEditor, \{\n      title:"Occupation", noun:"occupations",/.test(html));
ok('the sheet has a tab of its own', /var OCCUPATIONS_SHEET = "Occupations";/.test(gs));
ok('a tab nobody filled in starts with the usual ones',
   /DEFAULT_OCCUPATIONS = \[[\s\S]{0,260}"Business"[\s\S]{0,260}"Other"/.test(gs));
ok('reading is routed', /case "getOccupationsList":         return getOccupationsList\(\);/.test(gs));
ok('and writing', /case "saveOccupationsList":        return saveOccupationsList\(p\);/.test(gs));
ok('a payload cut short in transit is refused',
   /parseList_\(p\.occupations, "occupations"\)/.test(gs));
ok('Master fetches it', /"getSafetyFlagsList", "getOccupationsList"/.test(html));
ok('and reads it back', /if \(oc && oc\.success\) setOccupations\(oc\.occupations \|\| \[\]\);/.test(html));
ok('and saves it', /persist\("saveOccupationsList", \{ occupations: JSON\.stringify\(arr\) \}/.test(html));
ok('Registration reads the list once per page and shares it',
   /let _occupationsCache = null;/.test(html) && /const occupationOptions = useOccupations\(\);/.test(html));

// ── the Occupation field, rendered and driven ───────────────────────────
// Lifted out as its own little component so the real markup is exercised
// rather than a copy of it.
const FROM = html.indexOf('  // Picked from the clinic\'s list rather than typed');
const TO = html.indexOf('msg: errors.occupation', FROM);
ok('the Occupation field was found', FROM > 0 && TO > FROM, `${FROM}..${TO}`);
// Up to, but not including, the "})" that closes the field and hands over
// to the error line -- so the ternary is put back together whole.
const FIELD = html.slice(FROM, html.indexOf('}), /*#__PURE__*/React.createElement(Err, {', FROM)) + '})';

const HARNESS = `
  const inp = { padding:"8px", border:"1px solid #e5e5e0", borderRadius:6, fontSize:13, fontFamily:"inherit" };
  function Field({ occupationOptions, value, onChange }) {
    const P = { occupation: value };
    const errors = {};
    const up = () => e => onChange(e.target.value);
    const setP = null;
    return React.createElement("div", null, ${FIELD});
  }
`;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 700, height: 400 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: HARNESS });
  ok('the field compiled', await page.evaluate(() => typeof Field === 'function'),
     errors.join(' // '));

  const LIST = ['Business', 'Government Service', 'Private Service', 'Student'];
  async function draw(options, value) {
    await page.evaluate(([o, v]) => {
      const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
      root.render(null); window.__o = o; window.__v = v; window.__picked = null;
    }, [options, value]);
    await page.waitForTimeout(30);
    await page.evaluate(() => {
      window.__root.render(React.createElement(Field, {
        occupationOptions: window.__o, value: window.__v,
        onChange: v => { window.__picked = v; } }));
    });
    await page.waitForTimeout(50);
  }

  // ── with a list: a dropdown ───────────────────────────────────────────
  await draw(LIST, '');
  eq('it is a dropdown', await page.locator('select').count(), 1);
  eq('and not a text box', await page.locator('input').count(), 0);
  const opts = await page.evaluate(() =>
    Array.from(document.querySelector('select').options).map(o => o.textContent));
  eq('it offers Select and then the list', opts, ['Select', ...LIST]);
  eq('nothing is chosen to begin with', await page.locator('select').inputValue(), '');
  await page.locator('select').selectOption('Student');
  await page.waitForTimeout(40);
  eq('choosing one passes it up', await page.evaluate(() => window.__picked), 'Student');

  // ── 1. it must not block the desk ─────────────────────────────────────
  for (const none of [[], null, undefined]) {
    await draw(none || [], 'Teacher');
    eq('with no list it stays a text box: ' + JSON.stringify(none),
       await page.locator('input').count(), 1);
    eq('and keeps what is in it', await page.locator('input').inputValue(), 'Teacher');
  }

  // ── 2. it must not change anybody ─────────────────────────────────────
  // THE WHOLE POINT. An old patient recorded as "Teacher" when the list has
  // no Teacher: a plain <select> shows "Select" and saving files them as
  // nothing at all.
  await draw(LIST, 'Teacher');
  const withOld = await page.evaluate(() =>
    Array.from(document.querySelector('select').options).map(o => o.textContent));
  ok('an occupation not on the list is added to the options',
     withOld.indexOf('Teacher') >= 0, withOld);
  eq('and it is the one showing', await page.locator('select').inputValue(), 'Teacher');
  eq('it is not listed twice', withOld.filter(o => o === 'Teacher').length, 1);
  // ...and one that IS on the list is not duplicated either.
  await draw(LIST, 'Business');
  const onList = await page.evaluate(() =>
    Array.from(document.querySelector('select').options).map(o => o.textContent));
  eq('an occupation already on the list appears once', onList.filter(o => o === 'Business').length, 1);
  eq('and is the one showing', await page.locator('select').inputValue(), 'Business');
  eq('the options are otherwise the list', onList, ['Select', ...LIST]);

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
