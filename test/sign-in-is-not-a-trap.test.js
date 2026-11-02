// "Whenever I give a print command or go back to the folder it asks for a
// staff password which we never assigned, so every time we have to close
// the app and restart."
//
// Patient documents are gated whatever the rollout flag says. Printing a
// prescription calls createDocumentPDF and opening a patient's folder calls
// getPatientDocuments, and both are on that list -- so both were refused,
// and the sign-in screen appeared. With no password ever set, staffLogin
// cannot issue a session, so nothing typed there could work and the screen
// had no way off it. Restarting the app was the only escape.
//
// The gate itself is a decision for the clinic: opening it would make
// X-rays reachable by anyone holding the /exec URL, which is published in
// the page source. What is fixed here is the TRAP -- the screen now says
// which situation it is in and can always be left.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

// ── the backend tells the app which situation it is in ───────────────────
ok('the backend can say whether a password exists', /function appPasswordSet_\(\)/.test(gs));
ok('authStatus reports it', /case "authStatus":.*passwordSet: appPasswordSet_\(\)/.test(gs));
// The gate is NOT opened by this change. If that ever becomes the intent it
// should be a deliberate decision, not a quiet edit.
ok('patient documents are still gated',
   /DOCUMENT_ACTIONS\.indexOf\(p\.action\) >= 0 && !isValidSession_\(p\.token\)/.test(gs));
ok('and printing a prescription is one of the gated actions',
   /DOCUMENT_ACTIONS = \[[\s\S]{0,200}createDocumentPDF/.test(gs));
ok('as is opening a patient folder',
   /DOCUMENT_ACTIONS = \[[\s\S]{0,200}getPatientDocuments/.test(gs));

// ── the screen, rendered ─────────────────────────────────────────────────
const a = html.indexOf('function StaffLoginGate({ children }) {');
const b = html.indexOf('\nfunction ', a + 10);
ok('the sign-in gate was found', a > 0 && b > a, `${a}..${b}`);
const GATE_SRC = html.slice(a, b);

const DEPS = `
  const { useState, useRef, useEffect } = React;
  const T = "#0078B4", BORDER = "#e5e5e0", BGS = "#f5f5f0";
  const inp = { padding: "8px", border: "1px solid #e5e5e0", borderRadius: 6, fontSize: 13 };
  let _onAuthRequired = null;
  function setAuthRequiredHandler(fn){ _onAuthRequired = fn; }
  function setSessionToken(t){ window.__token = t; }
`;

function backend(status) {
  return `
  window.__authCalls = 0;
  function api(action, params){
    if (action === "authStatus") { window.__authCalls++; return Promise.resolve(${JSON.stringify(status)}); }
    if (action === "staffLogin") return Promise.resolve({ success:false, error:"No APP_PASSWORD set in Script Properties" });
    return Promise.resolve({ success:true });
  }`;
}

async function render(browser, status, errors) {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  }
  await page.addScriptTag({ content: DEPS + backend(status) });
  await page.addScriptTag({ content: GATE_SRC });
  await page.addScriptTag({ content: `
    ReactDOM.createRoot(document.getElementById("root")).render(
      React.createElement(StaffLoginGate, null,
        React.createElement("div", { id:"app" }, "THE APP")));` });
  await page.waitForTimeout(400);
  return page;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const errors = [];

  // ── a document action is refused, and no password exists ───────────────
  {
    const page = await render(browser, { success: true, authRequired: false, valid: false, passwordSet: false }, errors);
    ok('with auth off the app is shown, not the password box',
       await page.locator('#app').isVisible());

    // This is the moment the clinic hit: print, or open a folder.
    await page.evaluate(() => _onAuthRequired());
    await page.waitForTimeout(300);
    const text = await page.locator('#root').innerText();

    ok('the sign-in screen appears', /Staff Sign In/.test(text), text.slice(0, 200));
    ok('and says there is nothing to type, rather than just asking',
       /No password has been set yet/.test(text), text.slice(0, 400));
    ok('it names what the lock is actually for',
       /X-rays, scans and saved prescriptions/.test(text), text.slice(0, 400));
    ok('it says exactly where to set one', /Master . Security/.test(text), text.slice(0, 400));
    ok('and that the rest of the app is unaffected',
       /Everything else in the app works without it/.test(text), text.slice(0, 400));
    // A password box with nothing that could go in it is just a dead end.
    eq('no password box is offered', await page.locator('input[type=password]').count(), 0);
    ok('it re-asked the backend before demanding a password',
       (await page.evaluate(() => window.__authCalls)) >= 2,
       await page.evaluate(() => window.__authCalls));

    // The whole point: a way off the screen without restarting the app.
    const out = page.locator('button', { hasText: 'Continue without opening documents' });
    eq('there is a way to leave the screen', await out.count(), 1);
    await out.click();
    await page.waitForTimeout(250);
    ok('and it returns to the app', await page.locator('#app').isVisible());
    ok('without the app having been restarted',
       !/Staff Sign In/.test(await page.locator('#root').innerText()));
    await page.close();
  }

  // ── a password DOES exist: the screen behaves as it always did ─────────
  {
    const page = await render(browser, { success: true, authRequired: true, valid: false, passwordSet: true }, errors);
    const text = await page.locator('#root').innerText();
    // IN FRONT OF, not instead of. This used to insist the app was GONE --
    // which is precisely the glitch: returning the sign-in screen in place
    // of the app unmounted it, and signing in brought it back from scratch
    // on the dashboard with the patient closed. The app stays mounted and
    // the box covers it. See signing-in-keeps-your-place.test.js.
    ok('with auth on, the password box stands in front of the app',
       /Staff Sign In/.test(text), text.slice(0, 200));
    ok('and the app behind it was not thrown away',
       await page.locator('#app').count() === 1);
    ok('it says what the password opens',
       /kept behind this password/.test(text), text.slice(0, 400));
    ok('and how long signing in lasts', /twelve hours/.test(text), text.slice(0, 400));
    ok('and which password it is', /Master . Security/.test(text), text.slice(0, 400));
    eq('the password box is there', await page.locator('input[type=password]').count(), 1);
    await page.close();
  }

  // ── an older backend that cannot say ───────────────────────────────────
  {
    const page = await render(browser, { success: true, authRequired: true, valid: false }, errors);
    const text = await page.locator('#root').innerText();
    ok('an older backend still gets a password prompt',
       /kept behind this password/.test(text), text.slice(0, 300));
    ok('with no claim either way about a password existing',
       !/No password has been set yet/.test(text), text.slice(0, 300));
    ok('and no guess at which screen sets it',
       !/Master . Security/.test(text), text.slice(0, 300));
    eq('the password box is still offered', await page.locator('input[type=password]').count(), 1);
    await page.close();
  }

  // ── and the password can be set from inside the app ────────────────────
  // It lives in Master, which is itself behind the Master password, so only
  // whoever holds that can change it -- no Script Properties, and nobody
  // wandering into it by accident.
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    page.on('pageerror', e => errors.push(String(e.message)));
    await page.setContent('<div id="root"></div>');
    for (const f of ['node_modules/react/umd/react.production.min.js',
                     'node_modules/react-dom/umd/react-dom.production.min.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
    }
    const pa = html.indexOf('function DocumentsPasswordChanger() {');
    const pb = html.indexOf('\nfunction MasterPasswordChanger() {', pa);
    ok('the documents password panel was found', pa > 0 && pb > pa, `${pa}..${pb}`);
    await page.addScriptTag({ content: `
      const { useState, useRef, useEffect } = React;
      const T = "#0078B4", BORDER = "#e5e5e0";
      const inp = { padding:"8px", border:"1px solid #e5e5e0", borderRadius:6, fontSize:13 };
      window.__saved = null; window.__tokenCleared = false;
      function setSessionToken(t){ if (!t) window.__tokenCleared = true; }
      function api(action, params){
        if (action === "getSettings") return Promise.resolve({ success:true, appPasswordSet:false, masterPasswordSet:true });
        if (action === "saveAppPassword") { window.__saved = params.password; return Promise.resolve({ success:true }); }
        return Promise.resolve({ success:true });
      }` });
    await page.addScriptTag({ content: html.slice(pa, pb) });
    await page.addScriptTag({ content: `
      ReactDOM.createRoot(document.getElementById("root"))
        .render(React.createElement(DocumentsPasswordChanger, null));` });
    await page.waitForTimeout(400);

    const text = await page.locator('#root').innerText();
    ok('it says documents cannot be opened until one is set',
       /CANNOT BE OPENED/.test(text), text.slice(0, 300));
    ok('and that it is not the Master page password',
       /separate from the Master page password/.test(text), text.slice(0, 400));
    ok('and that nothing else is held back',
       /Only the documents are held back/.test(text), text.slice(0, 500));

    await page.locator('input[type=password]').fill('open-the-xrays');
    await page.locator('button', { hasText: 'Set Password' }).click();
    await page.waitForTimeout(300);
    eq('it writes the documents password, not the Master one',
       await page.evaluate(() => window.__saved), 'open-the-xrays');
    ok('the old session is dropped, so nobody carries on believing they are signed in',
       await page.evaluate(() => window.__tokenCleared));
    ok('and it says everyone signs in again',
       /signs in again/.test(await page.locator('#root').innerText()));
    await page.close();
  }

  // The backend keeps the two passwords apart, and offers no way to clear
  // the documents one -- clearing it would rebuild the dead end.
  ok('saveAppPassword writes its own property', /setProperty\("APP_PASSWORD", pw\)/.test(gs));
  ok('and is reachable from the app', /case "saveAppPassword":/.test(gs));
  ok('it refuses an empty password rather than clearing the lock',
     /function saveAppPassword[\s\S]{0,200}if \(!pw\) return \{ success: false/.test(gs));
  ok('getSettings reports whether it is set', /appPasswordSet: !!props\.getProperty\("APP_PASSWORD"\)/.test(gs));

  ok('nothing threw anywhere', errors.length === 0, errors.join(' | '));
  await browser.close();

  const failed = checks.filter(c => !c.ok);
  for (const c of failed) {
    console.log('  FAIL  ' + c.name);
    if (c.want !== undefined) console.log('        wanted ' + JSON.stringify(c.want));
    if (c.got !== undefined) console.log('        got    ' + JSON.stringify(c.got));
  }
  console.log('  ' + (checks.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
