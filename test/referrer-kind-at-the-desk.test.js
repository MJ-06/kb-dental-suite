// The desk half of keeping the kind of referrer beside the name. A referral
// is not always from another patient — a referring doctor, the clinic's own
// staff and somebody doing PR all send patients in, and "Sunita" on its own
// does not say which, so it cannot say whether to thank her, pay her, or
// credit her team.
//
// The cell is pulled out of index.html and rendered for real. Asserting on
// the source would prove only that the text is there, not that the select
// renders, holds the kinds, or writes to the field it claims to.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the kinds, taken from the page ────────────────────────────────────────
const kindsSrc = /const REFERRER_KINDS = (\[[^\]]*\]);/.exec(html);
ok('index.html declares the kinds a referrer can be', !!kindsSrc);
const KINDS = JSON.parse(kindsSrc[1]);
ok('a patient is one of them', KINDS.indexOf('Patient') >= 0, KINDS);
ok('and a referring doctor', KINDS.indexOf('Doctor') >= 0, KINDS);
ok('and the clinic\'s own staff, who the user said also refer',
   KINDS.indexOf('Staff') >= 0, KINDS);
ok('and the people who do PR, likewise',
   KINDS.some(k => /PR/.test(k)), KINDS);
ok('with somewhere to put anyone who is none of those',
   KINDS.indexOf('Other') >= 0, KINDS);

// ── the cell itself ──────────────────────────────────────────────────────
// Sliced by balancing the parentheses, so the cell comes out whole however
// the markup around it is laid out.
const anchor = html.indexOf('    c: "Referred By"');
ok('the Referred By cell is in the page', anchor > 0);
const cellSrc = (() => {
  const start = html.lastIndexOf('/*#__PURE__*/React.createElement("div", null,', anchor);
  let i = html.indexOf('(', start), depth = 0, quote = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
})();
ok('and comes out as one balanced expression', /\)$/.test(cellSrc));

// ── it is never printed ──────────────────────────────────────────────────
// The slip prints the referrer's NAME and always has. The kind is for the
// CRM; putting "Staff" on the patient's own copy says nothing to them.
const slip = html.slice(html.indexOf('KBDC/FORMS/REG-01'), html.indexOf('General Consent Form'));
ok('the kind is not printed on the registration slip',
   slip.indexOf('referredByType') < 0);
ok('while the referrer\'s name still is, as it always was',
   slip.indexOf('P.referredBy') >= 0);

// ── the register carries it ──────────────────────────────────────────────
ok('a blank registration has the field, so it is never undefined',
   /referredBy: "",\s*\n\s*referredByType: "",/.test(html));
ok('it is sent when the form is saved',
   /referredByType: P\.referredByType \|\| "",/.test(html));
ok('and read back when an existing patient is opened',
   /referredByType:\s*p\.referredByType\s*\|\| ""/.test(html));

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));

  const react = fs.readFileSync(path.join(REPO, 'node_modules/react/umd/react.production.min.js'), 'utf8');
  const reactDom = fs.readFileSync(path.join(REPO, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });

  const res = await page.evaluate(({ cellSrc, KINDS }) => {
    const REFERRER_KINDS = KINDS;
    const inp = { width: '100%', padding: 8, fontSize: 14, border: '1px solid #ccc' };
    const Lbl = ({ c }) => React.createElement('div', { className: 'lbl' }, c);
    // The real page's state setter, reduced to what this cell uses.
    window.wrote = [];
    const P = { referredBy: 'Sunita Rao', referredByType: 'Staff' };
    const setP = fn => window.wrote.push(typeof fn === 'function' ? fn(P) : fn);
    const up = (set, key) => e => set(prev => ({ ...prev, [key]: e.target.value }));

    const Cell = new Function('React', 'P', 'setP', 'up', 'Lbl', 'inp', 'REFERRER_KINDS',
      'return ' + cellSrc + ';');
    ReactDOM.createRoot(document.getElementById('root')).render(
      Cell(React, P, setP, up, Lbl, inp, REFERRER_KINDS));
    return null;
  }, { cellSrc, KINDS });

  await page.waitForTimeout(150);

  const sel = await page.$('select');
  const txt = await page.$eval('#root', n => n.innerText);
  ok('the cell renders a select for who the referrer is', !!sel);
  ok('labelled Referred By, as the desk has always known it', /Referred By/.test(txt), txt);

  const opts = await page.$$eval('select option', ns => ns.map(n => n.textContent));
  eq('it offers every kind, plus a prompt to choose one',
     opts.slice(1), KINDS);
  ok('and does not preselect a kind for a referral nobody has classified',
     /select/i.test(opts[0]), opts[0]);
  eq('an existing record shows the kind it was saved with',
     await page.$eval('select', n => n.value), 'Staff');

  eq('the name field still shows the referrer\'s name',
     await page.$eval('input', n => n.value), 'Sunita Rao');
  const ph = await page.$eval('input', n => n.placeholder);
  ok('and asks for a name, not a source — the kind asks that now',
     /name/i.test(ph) && !/source/i.test(ph), ph);

  // Both controls must write to their OWN field. A select wired to
  // referredBy would overwrite the name with "Doctor".
  await page.selectOption('select', 'Doctor');
  await page.waitForTimeout(50);
  let wrote = await page.evaluate(() => window.wrote);
  eq('choosing a kind writes the kind', wrote[wrote.length - 1].referredByType, 'Doctor');
  eq('and leaves the name alone', wrote[wrote.length - 1].referredBy, 'Sunita Rao');

  await page.fill('input', 'Dr Mehra');
  await page.waitForTimeout(50);
  wrote = await page.evaluate(() => window.wrote);
  eq('typing a name writes the name', wrote[wrote.length - 1].referredBy, 'Dr Mehra');
  eq('and leaves the kind alone', wrote[wrote.length - 1].referredByType, 'Staff');

  // The clinic asked for every on-screen size to be legible.
  const sizes = await page.$$eval('select, input', ns =>
    ns.map(n => parseFloat(getComputedStyle(n).fontSize)));
  ok('both controls are at the clinic-wide minimum size',
     sizes.every(s => s >= 13), sizes);

  // Side by side, not stacked — it is one answer in one row.
  const box = await page.evaluate(() => {
    const s = document.querySelector('select').getBoundingClientRect();
    const i = document.querySelector('input').getBoundingClientRect();
    return { sTop: Math.round(s.top), iTop: Math.round(i.top), sRight: Math.round(s.right), iLeft: Math.round(i.left) };
  });
  ok('the kind sits beside the name rather than above it',
     Math.abs(box.sTop - box.iTop) <= 2, box);
  ok('and they do not overlap', box.sRight <= box.iLeft + 1, box);

  ok('nothing threw while rendering it', errors.length === 0, errors.join(' | '));
  await browser.close();

  let pass = 0, fail = 0;
  checks.forEach(c => {
    if (c.ok) { pass++; console.log('  PASS  ' + c.name); }
    else {
      fail++;
      console.log('  FAIL  ' + c.name +
        (c.want !== undefined ? '\n          got ' + JSON.stringify(c.got) + ', want ' + JSON.stringify(c.want)
                              : c.got ? '\n          ' + JSON.stringify(c.got) : ''));
    }
  });
  console.log('==============================================================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
