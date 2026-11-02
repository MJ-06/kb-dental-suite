// "Unknown action: saveAppPassword", with the new Code.gs sitting in the
// editor and the clinic certain it had been deployed.
//
// Pasting Code.gs changes nothing on its own: the /exec URL serves whichever
// VERSION the deployment points at, so without Deploy > Manage deployments >
// New version the old code goes on answering. The failure is silent until
// something calls an action that build has never heard of, somewhere deep in
// a screen.
//
// The sidebar made this worse. It read "KB Dental Clinical Suite v20" --
// typed into the page by hand, so it said v20 whatever backend was
// answering, including one deployed months before. It looked like a version
// indicator and was not one.
//
// Now it asks the backend. And the three answers are kept distinct, which is
// the part that matters: a backend that reports NO build is not the same as
// one that reports an old build, and must not be shouted about.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

// ── the backend says which build it is ───────────────────────────────────
// A date, and optionally a letter after it. Two Code.gs changes in one day
// is ordinary, and a marker that cannot move within a day cannot warn about
// the second of them -- which is the case this whole mechanism exists for.
ok('Code.gs carries a build stamp', /var BACKEND_BUILD = "\d{4}-\d{2}-\d{2}[a-z]?"/.test(gs));
ok('and ping reports it', /message: "pong"[\s\S]{0,80}build: BACKEND_BUILD/.test(gs));
// ping is public, so this works before anybody has signed in -- which is
// when you most want to know the backend is stale.
ok('ping needs no session', /PUBLIC_ACTIONS = \[[\s\S]{0,120}"ping"/.test(gs));

const required = (html.match(/KB_BACKEND_BUILD_REQUIRED = "(\d{4}-\d{2}-\d{2}[a-z]?)"/) || [])[1];
const shipped = (gs.match(/var BACKEND_BUILD = "(\d{4}-\d{2}-\d{2}[a-z]?)"/) || [])[1];
ok('the page states which build it needs', !!required, required);
ok('and the shipped backend is at least that new', shipped >= required, `${shipped} vs ${required}`);
// Compared as text, which is why the suffix goes after the date and not
// before it: a revision must sort after the plain date and before tomorrow.
ok('a same-day revision sorts after the plain date', "2026-11-02b" > "2026-11-02");
ok('and before the next day', "2026-11-02b" < "2026-11-03");

// ── the hand-typed version label is gone ─────────────────────────────────
// Comments stripped first: this file explains what the old label said, and
// that explanation is not the label.
const CODE_ONLY = html.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
ok('the sidebar no longer claims a version of its own',
   !/KB Dental Clinical Suite v\d+/.test(CODE_ONLY));
ok('it renders the live build line instead',
   /React\.createElement\(BackendBuildLine, null\)/.test(CODE_ONLY));

// ── rendered, in each of the three states ────────────────────────────────
const a = html.indexOf('function BackendBuildLine() {');
const b = html.indexOf('\nfunction StaffLoginGate', a);
ok('the sidebar line was found', a > 0 && b > a, `${a}..${b}`);

const STATE_FN = (() => {
  const i = html.indexOf('function backendBuildState(build) {');
  return html.slice(i, html.indexOf('\n}', i) + 2);
})();

async function show(browser, ping, errors) {
  const page = await browser.newPage({ viewport: { width: 500, height: 300 } });
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  }
  await page.addScriptTag({ content: `
    const { useState, useRef, useEffect } = React;
    const KB_BACKEND_BUILD_REQUIRED = ${JSON.stringify(required)};
    ${STATE_FN}
    function api(action){ return Promise.resolve(${JSON.stringify(ping)}); }` });
  await page.addScriptTag({ content: html.slice(a, b) });
  await page.addScriptTag({ content: `
    ReactDOM.createRoot(document.getElementById("root"))
      .render(React.createElement(BackendBuildLine, null));` });
  await page.waitForTimeout(350);
  const out = {
    text: await page.locator('#root').innerText(),
    title: await page.locator('#root span').getAttribute('title').catch(() => null)
  };
  await page.close();
  return out;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const errors = [];

  // current
  {
    const o = await show(browser, { success: true, message: 'pong', build: required }, errors);
    ok('a current backend shows its build', o.text.includes(required), o.text);
    ok('and says nothing alarming', !/out of date/i.test(o.text), o.text);
  }

  // stale -- reported, and older than the page needs
  {
    const o = await show(browser, { success: true, message: 'pong', build: '2020-01-01' }, errors);
    ok('a stale backend is called out', /out of date/i.test(o.text), o.text);
    ok('and named as Code.gs, not something vague', /redeploy Code\.gs/i.test(o.text), o.text);
    ok('with the actual steps on hover',
       o.title && /Manage deployments/.test(o.title) && /New version/.test(o.title), o.title);
    ok('including the thing everybody gets wrong',
       o.title && /not enough on its own/.test(o.title), o.title);
  }

  // unknown -- a backend from before any of this existed. THE IMPORTANT ONE.
  // Shipping a red warning here would put it in front of the clinic the
  // moment this released and leave it there until the next redeploy.
  {
    const o = await show(browser, { success: true, message: 'pong' }, errors);
    ok('a backend that cannot say is not called out', !/out of date/i.test(o.text), o.text);
    ok('and is not shown a made-up build either', !/\d{4}-\d{2}-\d{2}/.test(o.text), o.text);
    ok('it just names the app', /KB Dental Clinical Suite/.test(o.text), o.text);
  }

  // a backend that cannot be reached at all
  {
    const o = await show(browser, { success: false, error: 'network' }, errors);
    ok('an unreachable backend is not called stale', !/out of date/i.test(o.text), o.text);
  }

  ok('nothing threw', errors.length === 0, errors.join(' | '));
  await browser.close();

  // ── the states, directly ───────────────────────────────────────────────
  const vm = require('vm');
  const box = { KB_BACKEND_BUILD_REQUIRED: '2026-10-31' };
  vm.createContext(box);
  vm.runInContext(STATE_FN + ';globalThis.__s = backendBuildState;', box);
  eq('same day is current', box.__s('2026-10-31'), 'current');
  eq('later is current', box.__s('2026-11-15'), 'current');
  eq('earlier is stale', box.__s('2026-10-30'), 'stale');
  eq('a previous year is stale', box.__s('2025-12-31'), 'stale');
  eq('missing is unknown', box.__s(''), 'unknown');
  eq('undefined is unknown', box.__s(undefined), 'unknown');
  eq('nonsense is unknown, not stale', box.__s('v20'), 'unknown');

  const failed = checks.filter(c => !c.ok);
  for (const c of failed) {
    console.log('  FAIL  ' + c.name);
    if (c.want !== undefined) console.log('        wanted ' + JSON.stringify(c.want));
    if (c.got !== undefined) console.log('        got    ' + JSON.stringify(c.got));
  }
  console.log('  ' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
