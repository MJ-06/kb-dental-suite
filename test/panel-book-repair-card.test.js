// The card the clinic actually clicks when the empanelled sheet is missing
// patients: Master → Accounts → Panels.
//
// It exists because of two rounds of "it has not landed". Each time the
// answer was invisible from the screen -- the move either threw where only a
// log would show it, or the Code.gs behind the app was not the one in the
// repository -- and each time the next step was a guess. So this card is
// mounted and driven here, and what it must do is say WHICH of those it is.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

ok('the card is reached from the screen that names the panels',
   /panels: \(\) =>[\s\S]{0,600}React\.createElement\(PanelBookRepair/.test(html));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<body style="margin:0;padding:16px;font-family:system-ui"><div id="root"></div></body>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });

  const cut = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));
  await page.addScriptTag({ content:
    cut('// "I updated their record to panel patients', 'function Master() {') });

  // Every call the card makes is recorded, so "it did something" can be told
  // apart from "it said something".
  await page.addScriptTag({ content: `
    window.__calls = [];
    window.__replies = {};
    window.api = (action, payload) => {
      window.__calls.push(action);
      const r = window.__replies[action];
      return typeof r === "function" ? Promise.resolve(r()) : Promise.resolve(r || { success:false, error:"no reply set" });
    };
    window.__mount = (replies) => {
      window.__calls = [];
      window.__replies = replies;
      const root = document.getElementById("root");
      ReactDOM.render(null, root);
      ReactDOM.render(React.createElement(PanelBookRepair, { key: String(Math.random()) }), root);
    };
  `});

  const mount = async (replies) => {
    await page.evaluate((r) => {
      const out = {};
      Object.keys(r).forEach(k => { out[k] = r[k]; });
      window.__mount(out);
    }, replies);
    await page.waitForTimeout(90);
  };
  const text = () => page.$eval('#root', el => el.innerText.replace(/\s+/g, ' ').trim());
  const calls = () => page.evaluate(() => window.__calls.slice());
  const button = (re) => page.evaluateHandle((src) => {
    const rx = new RegExp(src, 'i');
    return [...document.querySelectorAll('button')].find(b => rx.test(b.innerText)) || null;
  }, re);

  // ── patients stranded in the main register ────────────────────────────
  await mount({
    auditPanelBook: { success: true, here: 'main', build: '2026-11-06b', stranded: [
      { uhid: 'AL1010', name: 'Santosh Kumar', panel: 'CGHS' },
      { uhid: 'AL1012', name: 'Meena Devi', panel: 'DGEHS' },
      { uhid: 'AL1013', name: '', panel: 'CGHS' }
    ]},
    sweepPanelBook: { success: true, found: 3, moved: 3, left: [], build: '2026-11-06b' }
  });
  let t = await text();
  eq('it looks before it says anything', await calls(), ['auditPanelBook']);
  ok('it counts them', /3 patients are marked onto a panel/.test(t), t);
  ok('and names them, so the clinic can recognise the case',
     /Santosh Kumar . AL1010 . CGHS/.test(t) && /Meena Devi/.test(t), t);
  ok('a row with no name is still shown rather than dropped', /\(no name\) . AL1013/.test(t), t);
  ok('the backend names itself', /Backend 2026-11-06b/.test(t), t);

  let b = await button('Move 3 into the empanelled book');
  ok('there is one button and it says what it will do', !!(await b.jsonValue() !== null), t);
  await b.asElement().click();
  await page.waitForTimeout(120);
  t = await text();
  eq('it moves them and looks again', await calls(), ['auditPanelBook', 'sweepPanelBook', 'auditPanelBook']);
  ok('and reports what happened', /3 of 3 moved into the empanelled book/.test(t), t);

  // ── some of them could not be moved ──────────────────────────────────
  // A count alone would hide this. The reason is the whole point.
  await mount({
    auditPanelBook: { success: true, here: 'main', build: '2026-11-06b',
      stranded: [{ uhid: 'AL1010', name: 'Santosh Kumar', panel: 'CGHS' }] },
    sweepPanelBook: { success: true, found: 1, moved: 0, left: ['Santosh Kumar — Service unavailable: Spreadsheets'] }
  });
  (await button('Move 1 into the empanelled book')).asElement() &&
    await (await button('Move 1 into the empanelled book')).asElement().click();
  await page.waitForTimeout(120);
  t = await text();
  ok('a patient that did not move is named with the reason',
     /0 of 1 moved/.test(t) && /Not moved: Santosh Kumar . Service unavailable/.test(t), t);

  // ── nothing to do ────────────────────────────────────────────────────
  await mount({ auditPanelBook: { success: true, here: 'main', build: '2026-11-06b', stranded: [] } });
  t = await text();
  ok('when the books agree it says so plainly',
     /Every patient marked onto a panel is in the empanelled book/.test(t), t);
  ok('and still names the backend', /Backend 2026-11-06b/.test(t), t);
  b = await button('Move');
  eq('with nothing to move there is no move button', await b.jsonValue(), null);

  // ── the empanelled app ───────────────────────────────────────────────
  await mount({ auditPanelBook: { success: true, here: 'panel', build: '2026-11-06b', stranded: [] } });
  t = await text();
  ok('on the empanelled app it points at the main one',
     /Open the main clinic app/.test(t), t);
  b = await button('Move');
  eq('and offers nothing to press', await b.jsonValue(), null);

  // ── the backend is older than the app ────────────────────────────────
  // This is the case that cost a round. An old Code.gs does not know the
  // action, and the card has to say that in words, not sit there blank.
  await mount({ auditPanelBook: { success: false, error: 'Unknown action: auditPanelBook' } });
  t = await text();
  ok('an unknown action is shown, not swallowed', /Unknown action: auditPanelBook/.test(t), t);
  ok('and it says what that means and how to fix it',
     /older than this app/.test(t) && /New version/.test(t), t);
  b = await button('Check again');
  ok('with a way to look again once it is deployed', (await b.jsonValue()) !== null, t);

  // ── a dead connection is not a blank card ────────────────────────────
  await page.evaluate(() => {
    window.__mount({});
    window.api = () => Promise.reject(new Error('Failed to fetch'));
    window.__mount({});
  });
  await page.waitForTimeout(120);
  ok('a network failure says so too', /Failed to fetch/.test(await text()), await text());

  eq('nothing threw', errors, []);
  await browser.close();

  let pass = 0, fail = 0;
  checks.forEach(c => {
    if (c.ok) pass++;
    else {
      fail++;
      console.log('  FAIL  ' + c.name +
        (c.want !== undefined ? '\n          got ' + JSON.stringify(c.got) + ', wanted ' + JSON.stringify(c.want)
         : c.got !== undefined ? '\n          ' + c.got : ''));
    }
  });
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL  the harness itself: ' + (e && e.stack || e)); process.exit(1); });
