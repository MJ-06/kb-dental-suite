// The backend's address, and where the session token rides.
//
// Two things the app should no longer have baked in:
//
//   1. WHERE the backend is. All four pages read window.KB_SERVER_URL if the
//      machine serving them set one, and fall back to the Apps Script /exec
//      URL if not. So moving to the clinic's own server is a setting, and so
//      is moving back -- which is the whole of the rollback plan.
//
//   2. WHERE the token goes. Against our own server it travels in a header.
//      A URL is written into access logs, into browser history, and into the
//      Referer of whatever the page loads next, and a session token has no
//      business in any of them. Against Apps Script it has to stay in the
//      query string, because doGet is handed parameters and nothing else --
//      and a custom header there would make the request non-simple and need a
//      CORS preflight Apps Script cannot answer.
//
// The api layer is lifted out of the page and RUN, with fetch replaced, so
// what is checked is what a request actually carries.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
const html = read('index.html');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

const EXEC = 'https://script.google.com/macros/s/AKfycby-OX-qvGE2U9Zt3b-_rpFqc5WQxRT5WMn1A030IcQIKXEaso36cMTbJ6c5xiP5O_6Zvg/exec';

// ── 1. no page has an address baked in ───────────────────────────────────
for (const page of ['index.html', 'chatbot.html', 'register.html', 'expense.html']) {
  const src = read(page);
  ok(`${page} follows window.KB_SERVER_URL when one is set`,
     /typeof window\.KB_SERVER_URL === "string" && window\.KB_SERVER_URL/.test(src));
  ok(`${page} still falls back to the /exec URL`, src.includes(EXEC));
}
// Both instances, not just the main one: the empanelled app must not go on
// talking to Apps Script after the move.
eq('both instances in index.html follow it',
   (html.match(/scriptUrl: KB_SERVER_URL \|\| "https:\/\/script\.google\.com/g) || []).length, 2);

// ── the api layer, lifted out and run ────────────────────────────────────
const FROM = html.indexOf('const SCRIPT_URL');
const TO = html.indexOf('// Every read the app makes goes through here');
ok('the api layer was found in the page', FROM > 0 && TO > FROM, `${FROM}..${TO}`);
const API_SRC = html.slice(FROM, TO);

// Everything the slice touches, and nothing it does not: a stub that quietly
// answers anything would let a broken request pass.
function load(serverUrl, token) {
  const calls = [];
  const sandbox = {
    console: { error() {}, warn() {}, log() {} },
    URLSearchParams, setTimeout, Promise, JSON, Object, String, Number, Boolean,
    Array, Math, Date, RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent,
    React: { useState: () => [null, () => {}], useEffect() {}, useMemo: f => f() },
    sessionStorage: {
      getItem: () => token || null, setItem() {}, removeItem() {}
    },
    async fetch(url, opts) {
      calls.push({ url: String(url), opts: opts || null });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
  };
  sandbox.window = {
    KB_INSTANCE: { scriptUrl: serverUrl || EXEC },
    KB_INSTANCE_ID: 'main'
  };
  if (serverUrl) sandbox.window.KB_SERVER_URL = serverUrl;
  vm.createContext(sandbox);
  vm.runInContext(API_SRC + '\n;globalThis.__api = apiDirect;'
    + '\n;globalThis.__scriptUrl = SCRIPT_URL;'
    + '\n;globalThis.__isAppsScript = KB_BACKEND_IS_APPS_SCRIPT;', sandbox);
  return { api: sandbox.__api, calls, sandbox };
}

(async () => {
  // ── 2. on GitHub Pages: nothing changes ────────────────────────────────
  {
    const { api, calls, sandbox } = load(null, 'TOK123');
    eq('with no KB_SERVER_URL the backend is Apps Script', sandbox.__scriptUrl, EXEC);
    eq('and the app knows it', sandbox.__isAppsScript, true);
    await api('getPanelsList');
    eq('one request went out', calls.length, 1);
    ok('the token is in the query string, as it has to be there',
       calls[0].url.includes('token=TOK123'), calls[0].url);
    ok('and no custom header is sent, so there is no preflight to fail',
       !calls[0].opts || !calls[0].opts.headers, JSON.stringify(calls[0].opts));
  }

  // ── 3. on the clinic's own server: the token leaves the URL ────────────
  {
    const { api, calls, sandbox } = load('/', 'TOK123');
    eq('with KB_SERVER_URL set the backend is that server', sandbox.__scriptUrl, '/');
    eq('and the app knows it is not Apps Script', sandbox.__isAppsScript, false);
    await api('getPanelsList');
    eq('one request went out', calls.length, 1);
    ok('the token is NOT in the URL', !/token=/.test(calls[0].url), calls[0].url);
    eq('it is in a header instead',
       calls[0].opts && calls[0].opts.headers && calls[0].opts.headers['X-KB-Token'], 'TOK123');
    ok('and the action still is in the URL',
       calls[0].url.includes('action=getPanelsList'), calls[0].url);
  }

  // ── 4. signed out: no header, no token, either way ─────────────────────
  {
    const { api, calls } = load('/', '');
    await api('ping');
    ok('nothing is sent when there is no session',
       !/token=/.test(calls[0].url) && (!calls[0].opts || !calls[0].opts.headers),
       JSON.stringify(calls[0]));
  }

  // ── 5. a long write still goes as a POST, with the token in the right
  //       place for whichever backend is listening ─────────────────────────
  const longList = JSON.stringify(Array.from({ length: 300 }, (_, i) => `Dr. Name Number ${i}`));
  {
    const { api, calls } = load('/', 'TOK123');
    await api('saveDoctorDetailsList', { doctors: longList });
    eq('it is a POST', calls[0].opts.method, 'POST');
    eq('the token is in the header', calls[0].opts.headers['X-KB-Token'], 'TOK123');
    ok('and not in the body', !JSON.parse(calls[0].opts.body).token,
       Object.keys(JSON.parse(calls[0].opts.body)).join(','));
    ok('the payload is still there',
       JSON.parse(calls[0].opts.body).doctors === longList);
  }
  {
    const { api, calls } = load(null, 'TOK123');
    await api('saveDoctorDetailsList', { doctors: longList });
    eq('against Apps Script it is still a POST', calls[0].opts.method, 'POST');
    eq('the token is in the body, where doPost can read it',
       JSON.parse(calls[0].opts.body).token, 'TOK123');
    eq('and the content type is still the simple one',
       calls[0].opts.headers['Content-Type'], 'text/plain;charset=utf-8');
    ok('with no header that would trigger a preflight',
       !calls[0].opts.headers['X-KB-Token'], JSON.stringify(calls[0].opts.headers));
  }

  // ── 6. the retry behaviour is untouched ────────────────────────────────
  ok('a read is still retried', /const isRead = action === "batch"/.test(API_SRC));
  ok('and a write still is not, except on a 404',
     /if \(!isRead && e\.status !== 404\) break;/.test(API_SRC));

  // ── report ─────────────────────────────────────────────────────────────
  const failed = checks.filter(c => !c.ok);
  for (const c of checks) {
    if (!c.ok) {
      console.log(`  FAIL ${c.name}`);
      if (c.want !== undefined) console.log(`       wanted ${JSON.stringify(c.want)}`);
      if (c.got !== undefined) console.log(`       got    ${JSON.stringify(c.got)}`);
    }
  }
  console.log(`  ${checks.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
