// "Now it did not ask for a password."
//
// Because the sign-in from a moment earlier was still good. It lasts twelve
// hours and lives in sessionStorage, so it survives a refresh and only dies
// when the tab is closed. Documents opening without a prompt is that working
// as intended, not the lock being gone.
//
// But the clinic had no way to tell the two apart, and that IS a gap. There
// was no way to end a sign-in: a front desk nobody is sitting at stayed open
// for the rest of the day, and nobody could check the lock still worked
// without closing the browser.
//
// So: a Lock button, shown only while there is a sign-in to end.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── why it did not ask ──────────────────────────────────────────────────
ok('a sign-in lasts twelve hours at the backend', /SESSION_TTL_MS = 12 \* 60 \* 60 \* 1000/.test(gs));
// sessionStorage, not localStorage: it dies with the tab rather than sitting
// on a shared machine overnight.
ok('and the token is held for the tab, not the machine',
   /sessionStorage\.getItem\(scopedKey\(KB_TOKEN_KEY\)\)/.test(html));
ok('the backend can be told to forget a session', /function staffLogout\(p\) \{/.test(gs));
ok('and it actually deletes it', /delete sessions\[String\(p\.token\)\];/.test(gs));

// ── the lock, and what it does ──────────────────────────────────────────
ok('Documents offers a way to lock them again', /"\\uD83D\\uDD12 Lock documents"/.test(html));
ok('shown only while there is a sign-in to end', /unlocked && React\.createElement\("button", \{ onClick:lockDocuments/.test(html));
ok('it forgets the token here', /setSessionToken\(""\);\n    setUnlocked\(false\);/.test(html));
ok('and at the other end too, so a copied token is no use',
   /await api\("staffLogout", \{ token: tok \}\)/.test(html));
ok('it clears what is on screen rather than leaving the list up',
   /setDocs\(\[\]\);\n    setDocsError\("Documents are locked\./.test(html));
ok('and signing back in lights it up again',
   /const again = \(\) => \{ setUnlocked\(true\); if \(pat && pat\.uhid\) loadDocs\(pat\.uhid\); \};/.test(html));

// ── driven, with the real handler ───────────────────────────────────────
// From the state it owns, not just the handler -- `unlocked` is declared
// a line above it and the handler is meaningless without it.
const A = html.indexOf('  const [unlocked, setUnlocked] = React.useState(() => !!getSessionToken());');
const B = html.indexOf('\n  const loadDocs = (uhid) => {', A);
ok('the lock handler was found', A > 0 && B > A, `${A}..${B}`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  // A real origin: a page made with setContent has an opaque one, and
  // sessionStorage -- which is the whole subject here -- is denied on it.
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><div id="root"></div>' }));
  await page.goto('http://kb.test/');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const KB_TOKEN_KEY = "kbdc_session_token";
    const scopedKey = k => k;
    function getSessionToken(){ try { return sessionStorage.getItem(KB_TOKEN_KEY) || ""; } catch(e){ return ""; } }
    function setSessionToken(t){ try { t ? sessionStorage.setItem(KB_TOKEN_KEY, t) : sessionStorage.removeItem(KB_TOKEN_KEY); } catch(e){} }
    window.__calls = [];
    async function api(action, params){ window.__calls.push([action, params]); return { success: true }; }
  ` });
  await page.addScriptTag({ content: `
    function Docs() {
      const [docs, setDocs] = React.useState(['an x-ray']);
      const [docsError, setDocsError] = React.useState("");
      ${html.slice(A, B)}
      window.__lock = lockDocuments;
      return React.createElement("div", { id:"out" },
        (unlocked ? "UNLOCKED" : "LOCKED") + " | " + docs.length + " shown | " + docsError);
    }
  ` });

  const show = () => page.locator('#out').textContent();
  const mount = async token => {
    await page.evaluate(t => {
      if (t) sessionStorage.setItem('kbdc_session_token', t);
      else sessionStorage.removeItem('kbdc_session_token');
      window.__calls = [];
      const root = window.__root || (window.__root = ReactDOM.createRoot(document.getElementById('root')));
      root.render(null);
    }, token);
    await page.waitForTimeout(40);
    await page.evaluate(() => { window.__root.render(React.createElement(Docs, null)); });
    await page.waitForTimeout(60);
    if (!(await page.locator('#out').count()))
      throw new Error('the component did not render: ' + errors.join(' // '));
  };

  // Signed in already — which is why it did not ask.
  await mount('tok-123');
  ok('with a sign-in in hand, documents are open', /^UNLOCKED \| 1 shown/.test(await show()), await show());

  await page.evaluate(() => window.__lock());
  await page.waitForTimeout(80);
  const after = await show();
  ok('locking says so', /^LOCKED/.test(after), after);
  ok('and takes the list off the screen', /0 shown/.test(after), after);
  ok('with a line saying how to get back in', /Master . Security/.test(after), after);
  eq('the token is gone from this browser',
     await page.evaluate(() => sessionStorage.getItem('kbdc_session_token')), null);
  eq('and the backend was told to forget it',
     await page.evaluate(() => window.__calls.map(c => [c[0], c[1].token])),
     [['staffLogout', 'tok-123']]);

  // Never signed in: nothing to end, so nothing offered.
  await mount('');
  ok('with no sign-in there is nothing to lock', /^LOCKED/.test(await show()), await show());
  await page.evaluate(() => window.__lock());
  await page.waitForTimeout(60);
  eq('and locking again asks the backend nothing',
     await page.evaluate(() => window.__calls.length), 0);

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
