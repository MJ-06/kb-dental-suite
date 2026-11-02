// "Make it ask every time, at least whenever a new patient folder is opened."
//
// It used to be asked once and then not again for the rest of the day on
// that computer. That is not what "locked" means to a clinic: one person
// types it in the morning and every patient's X-rays are open to whoever
// walks up to the desk afterwards.
//
// Now every folder asks. The unlock is held in memory, for ONE patient at a
// time, so:
//   - opening another patient's folder asks again
//   - coming BACK to the first asks again
//   - a refresh asks again, because nothing is written down anywhere
//
// And a locked folder is not merely hidden: nothing is fetched for it.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── it is held in memory, not written down ──────────────────────────────
ok('the unlock is per patient', /const \[unlockedFor, setUnlockedFor\] = React\.useState\(""\);/.test(html));
ok('and kept nowhere a refresh could survive',
   !/sessionStorage[^\n]*unlockedFor/.test(html) && !/localStorage[^\n]*unlockedFor/.test(html));
ok('changing patient drops it at once, and the last list with it',
   /if \(cur && cur !== id\) \{ setDocs\(\[\]\); setDocsError\(""\); return ""; \}/.test(html));
ok('a locked folder is never even asked for',
   /if \(!force && unlockedFor !== uhid\) \{ setDocs\(\[\]\); setDocsError\(""\); setLoading\(false\); return; \}/.test(html));
ok('the same password as before unlocks it', /api\("staffLogin", \{ password: pw \}\)/.test(html));
ok('and it says which password that is',
   /The password set in Master \\u203A Security\. It is asked for every patient/.test(html));
ok('the folder is shown only once unlocked',
   /pat && unlockedFor === pat\.uhid && React\.createElement\("div", null,/.test(html));
ok('and the lock names the patient without showing anything of theirs',
   /pat && unlockedFor !== pat\.uhid && React\.createElement\("div", null,/.test(html));

// ── driven, with the real code lifted out ───────────────────────────────
const A = html.indexOf('  const [unlockedFor, setUnlockedFor] = React.useState("");');
const B = html.indexOf('\n  React.useEffect(() => {\n    const again =', A);
ok('the lock was found', A > 0 && B > A, `${A}..${B}`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  await page.addScriptTag({ content: `
    const inp = { padding:"8px", fontSize:13 }, T = "#0078B4", TL = "#DCF4FB", TM = "#9ad", BORDER = "#e5e5e0";
    window.__fetched = []; window.__token = "";
    function setSessionToken(t){ window.__token = t; }
    async function api(action, params){
      if (action === "staffLogin")
        return params.password === "right" ? { success:true, token:"tok" } : { success:false, error:"Incorrect password" };
      if (action === "getPatientDocuments") { window.__fetched.push(params.uhid); return { success:true, documents:[{ id:1 }] }; }
      return { success:true };
    }
  ` });
  await page.addScriptTag({ content: `
    function Docs({ pat }) {
      const [docs, setDocs] = React.useState([]);
      const [loading, setLoading] = React.useState(false);
      const [docsError, setDocsError] = React.useState("");
      ${html.slice(A, B)}
      return React.createElement("div", { id:"out" },
        (pat ? (unlockedFor === pat.uhid ? "OPEN" : "LOCKED") : "NO PATIENT")
        + " | " + docs.length + " docs",
        pat && unlockedFor !== pat.uhid && React.createElement("div", null,
          React.createElement("input", { id:"pw", type:"password", value:pw,
            onChange:e=>setPw(e.target.value) }),
          React.createElement("button", { id:"go", onClick:unlock }, "Unlock"),
          React.createElement("span", { id:"err" }, pwErr)));
    }
    function Harness() {
      const [uhid, setUhid] = React.useState("KB001");
      window.__to = setUhid;
      return React.createElement(Docs, { pat: uhid ? { uhid, name: "Patient " + uhid } : null });
    }
  ` });
  await page.evaluate(() => {
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness, null));
  });
  await page.waitForTimeout(80);

  const show = () => page.locator('#out').textContent();
  const type = async v => { await page.locator('#pw').fill(v); await page.locator('#go').click(); await page.waitForTimeout(80); };

  // ── a folder opens locked, and nothing is fetched ─────────────────────
  ok('the folder starts locked', /^LOCKED/.test(await show()), await show());
  eq('and nothing was fetched for it', await page.evaluate(() => window.__fetched), []);

  // ── the wrong password ────────────────────────────────────────────────
  await type('wrong');
  ok('a wrong password keeps it shut', /^LOCKED/.test(await show()), await show());
  ok('and says so', /Incorrect/.test(await page.locator('#err').textContent()));
  eq('still nothing fetched', await page.evaluate(() => window.__fetched), []);

  // ── the right one ─────────────────────────────────────────────────────
  await type('right');
  ok('the right password opens it', /^OPEN \| 1 docs/.test(await show()), await show());
  eq('and only then are the documents fetched',
     await page.evaluate(() => window.__fetched), ['KB001']);
  eq('the session for fetching the files is renewed',
     await page.evaluate(() => window.__token), 'tok');

  // ── another patient asks again ────────────────────────────────────────
  await page.evaluate(() => window.__to('KB002'));
  await page.waitForTimeout(80);
  // Not just hidden: the last patient's list is dropped with their unlock.
  ok('another patient’s folder is locked, showing nothing of the last one',
     /^LOCKED \| 0 docs/.test(await show()), await show());
  eq('and nothing of theirs was fetched',
     await page.evaluate(() => window.__fetched), ['KB001']);
  eq('the box is empty again, not holding the last password',
     await page.locator('#pw').inputValue(), '');

  // ── and coming BACK asks again ────────────────────────────────────────
  await page.evaluate(() => window.__to('KB001'));
  await page.waitForTimeout(80);
  ok('the first patient is locked again', /^LOCKED/.test(await show()), await show());
  await type('right');
  ok('and opens on the password', /^OPEN/.test(await show()), await show());
  eq('fetched once more, deliberately',
     await page.evaluate(() => window.__fetched), ['KB001', 'KB001']);

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
