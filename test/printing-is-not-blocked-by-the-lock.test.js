// "Even after assigning the password it is not clickable, and this lock is
// not on documents."
//
// Right on both counts. Printing a prescription sends the finished document
// to be kept in the patient's folder -- a side effect of printing, added so
// a prescription can be opened again months later. That save goes through
// createDocumentPDF, which is gated. So the gate refused it, the global
// auth handler fired, and the clinic was shown Staff Sign In ON TOP OF A
// PRINT THAT HAD ALREADY WORKED. The paper was coming out of the printer.
//
// The lock belongs on documents. It does not belong on printing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : '')); }
};
const eq = (name, got, want) => ok(name, got === want, `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// ── apiPost, lifted out and run ──────────────────────────────────────────
const a = html.indexOf('async function apiPost(action, data = {}, opts = {}) {');
const b = html.indexOf('\n}', html.indexOf('console.error("API:", e);', a)) + 2;
ok('apiPost was found', a > 0 && b > a, `${a}..${b}`);

function run(response, opts) {
  let tookOverScreen = false;
  const sandbox = {
    console: { error() {} }, JSON, String, Object, Promise, Error,
    SCRIPT_URL: 'https://script.example/exec',
    getSessionToken: () => '',
    // The real one drops the token and throws up the sign-in screen.
    handleAuthFailure: (res) => { if (res && res.authRequired) tookOverScreen = true; return res; },
    async fetch() { return { ok: true, status: 200, json: async () => response }; }
  };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(a, b) + '\n;globalThis.__post = apiPost;', sandbox);
  return sandbox.__post('createDocumentPDF', {}, opts).then(res => ({ res, tookOverScreen }));
}

const REFUSED = { success: false, error: 'AUTH_REQUIRED', authRequired: true };

(async () => {
  // ── the whole point ────────────────────────────────────────────────────
  {
    const { res, tookOverScreen } = await run(REFUSED, { quietAuth: true });
    ok('a quiet call does NOT put the sign-in screen over the app', !tookOverScreen);
    ok('and the caller is still told it was refused', res.authRequired === true, JSON.stringify(res));
  }
  {
    const { tookOverScreen } = await run(REFUSED, {});
    ok('an ordinary call still does', tookOverScreen);
  }
  {
    const { res, tookOverScreen } = await run({ success: true, fileName: 'Rx.pdf' }, { quietAuth: true });
    ok('a call that works is unaffected', res.success === true && !tookOverScreen);
    eq('and its answer comes back whole', res.fileName, 'Rx.pdf');
  }
  // No opts at all must behave exactly as it always did.
  {
    const { tookOverScreen } = await run(REFUSED);
    ok('calling it the old way is unchanged', tookOverScreen);
  }

  // ── which calls are quiet, and which are not ───────────────────────────
  // Keeping a copy of something already printed: quiet.
  const saves = html.split('apiPost("createDocumentPDF"');
  eq('both document saves were found', saves.length - 1, 2);
  for (let i = 1; i < saves.length; i++) {
    ok('document save ' + i + ' is quiet', /\{ quietAuth: true \}/.test(saves[i].slice(0, 500)),
       saves[i].slice(0, 260));
  }

  // Opening the Documents screen is somebody ASKING for the documents, so
  // the password screen is the right answer there and must still appear.
  const docRead = html.slice(html.indexOf('api("getPatientDocuments"'), html.indexOf('api("getPatientDocuments"') + 200);
  ok('opening a patient folder still goes through the ordinary path',
     !/quietAuth/.test(docRead), docRead.slice(0, 160));

  // ── what the clinic is told ────────────────────────────────────────────
  ok('a refused copy says the document still printed',
     /Printed\. The copy was not filed/.test(html));
  ok('and says where the password lives',
     /patient documents need the password from Master/.test(html));
  // Comments stripped: the page explains what AUTH_REQUIRED means, and that
  // explanation is not something anybody is ever shown.
  const CODE_ONLY = html.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  ok('AUTH_REQUIRED is never put on screen as-is',
     !/AUTH_REQUIRED/.test(CODE_ONLY), (CODE_ONLY.match(/.{0,70}AUTH_REQUIRED.{0,70}/) || [''])[0]);
  ok('the WhatsApp PDF explains itself too',
     /Patient documents are behind a password, and this computer is not signed in/.test(html));
  ok('and tells them printing still works',
     /Print still works without it/.test(html));

  // ── the Sign In button ─────────────────────────────────────────────────
  // It sat dimmed and dead until something was typed, which read as broken.
  ok('Sign In is no longer disabled just for being empty',
     /onClick:\(\)=>\{ if \(!pw\.trim\(\)\) \{ setErr\("Type the password first\."\); return; \} doLogin\(\); \},\s*\n\s*disabled:busy,/.test(html),
     (html.match(/onClick:\(\)=>\{ if \(!pw[\s\S]{0,120}/) || [''])[0]);

  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
