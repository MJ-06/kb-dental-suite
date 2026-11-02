// "Nothing changed and no password asked."  Four times over.
//
// It had changed. The file in the browser had not. GitHub Pages sits behind
// a CDN that can go on serving an old index.html after a merge, and
// Ctrl+Shift+R does not always beat it -- so "you did nothing" and "your
// browser still has yesterday's file" looked identical from both ends, and
// there was no way for either of us to tell which.
//
// The sidebar said which BACKEND was answering and nothing at all about the
// page itself. Now it says both.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the marker ──────────────────────────────────────────────────────────
const app = (/const KB_APP_BUILD = "([^"]+)";/.exec(html) || [])[1];
const backendNeeded = (/const KB_BACKEND_BUILD_REQUIRED = "([^"]+)";/.exec(html) || [])[1];
ok('the app states which build it is', !!app, app);
// Same shape as the backend's: a date, and a letter when there is more than
// one in a day. Compared as text, so the letter sorts after the plain date.
ok('in the same shape as the backend marker', /^\d{4}-\d{2}-\d{2}[a-z]?$/.test(app || ''), app);
ok('and it is not older than the backend it needs', app >= backendNeeded, `${app} vs ${backendNeeded}`);

// ── it is shown, in every state the line can be in ──────────────────────
const A = html.indexOf('function BackendBuildLine() {');
const B = html.indexOf('\nfunction StaffLoginGate(', A);
ok('the sidebar line was found', A > 0 && B > A, `${A}..${B}`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const { useState, useEffect } = React;
    const KB_APP_BUILD = ${JSON.stringify(app)};
    const KB_BACKEND_BUILD_REQUIRED = ${JSON.stringify(backendNeeded)};
    ${html.slice(html.indexOf('function backendBuildState(build) {'),
                 html.indexOf('\n}', html.indexOf('function backendBuildState(build) {')) + 2)}
    window.__pong = null;
    async function api(){ return window.__pong; }
  ` });
  await page.addScriptTag({ content: html.slice(A, B) });

  const render = async pong => {
    await page.evaluate(p => {
      window.__pong = p;
      const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
      root.render(null);
    }, pong);
    await page.waitForTimeout(30);
    await page.evaluate(() => { window.__root.render(React.createElement(BackendBuildLine, null)); });
    await page.waitForTimeout(80);
    return page.evaluate(() => document.body.innerText);
  };

  // A backend on the right build: both are named.
  const current = await render({ success: true, build: backendNeeded });
  ok('with a current backend, the app build is shown',
     current.indexOf('app ' + app) >= 0, current);
  ok('and the backend build beside it',
     current.indexOf('backend ' + backendNeeded) >= 0, current);

  // THE CASE THAT CAUSED THIS. An out-of-date backend used to replace the
  // whole line with a warning, saying nothing about the page -- which is
  // the one thing you need when you are asking "did my app update".
  const stale = await render({ success: true, build: '2026-01-01' });
  ok('a stale backend still says which app this is',
     stale.indexOf('app ' + app) >= 0, stale);
  ok('while still warning about the backend', /Backend out of date/.test(stale), stale);

  // A backend that cannot say which build it is.
  const unknown = await render({ success: true, build: '' });
  ok('an unknown backend still says which app this is',
     unknown.indexOf('app ' + app) >= 0, unknown);
  ok('and claims nothing about the backend', !/backend /.test(unknown), unknown);

  // Before the backend has answered at all -- and if it never does.
  const silent = await render(null);
  ok('the app build shows even with no answer from the backend',
     silent.indexOf('app ' + app) >= 0, silent);

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
