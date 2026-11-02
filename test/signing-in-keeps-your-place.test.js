// "A super glitch: opening the document folder asks for the password, but
//  on entering it, instead of opening the document folder it closes the
//  patient folder and opens up the dashboard."
//
// The password was never the problem. StaffLoginGate did this:
//
//     if (!needsLogin) return children;
//     return <the sign-in screen>;
//
// Returning the sign-in screen INSTEAD of children unmounts the entire app.
// Every bit of state inside goes with it: which page you were on, which
// patient was open, what you had typed. Signing in sets needsLogin false,
// children mount again FROM SCRATCH, and a freshly mounted app is on the
// dashboard with no patient. Exactly what the clinic saw, and nothing to do
// with documents.
//
// So the box goes on TOP and the app stays mounted. React unmounts a subtree
// when it stops being rendered, which makes this a thing you cannot catch by
// reading -- it has to be rendered, hidden, shown and checked.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

// ── the shape of the fix ────────────────────────────────────────────────
ok('the app is no longer thrown away to ask for a password',
   !/if \(!needsLogin\) return children;/.test(html));
ok('it is rendered alongside the box',
   /return React\.createElement\(React\.Fragment, null,\n    children,\n    needsLogin && React\.createElement\("div"/.test(html));
ok('and the box covers the screen, so nothing behind it can be used',
   /position:"fixed", inset:0, zIndex:10000/.test(html));
ok('signing in tells whatever was refused that it may ask again',
   /window\.dispatchEvent\(new Event\("kb-signed-in"\)\)/.test(html));
ok('and the documents listen for it',
   /window\.addEventListener\("kb-signed-in", again\)/.test(html));
ok('which they stop doing when they go away',
   /window\.removeEventListener\("kb-signed-in", again\)/.test(html));

// ── the behaviour, in a browser ─────────────────────────────────────────
// A stand-in app with state of its own, under the real gate's structure:
// render children always, overlay when locked. The old shape is run first,
// because a test that cannot fail on it proves nothing.
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js'])
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });

  const run = shape => page.evaluate(async mode => {
    const e = React.createElement;
    // The app: remembers which page it is on and which patient is open.
    function App() {
      const [page, setPage] = React.useState('dashboard');
      const [patient, setPatient] = React.useState('');
      window.__open = (p) => { setPage('documents'); setPatient(p); };
      return e('div', { id: 'app' }, page + '|' + patient);
    }
    function Gate({ locked, children }) {
      if (mode === 'old') {
        // What it used to do.
        if (!locked) return children;
        return e('div', { id: 'box' }, 'Sign in');
      }
      // What it does now.
      return e(React.Fragment, null, children,
        locked ? e('div', { id: 'box', style: { position: 'fixed', inset: 0 } }, 'Sign in') : null);
    }
    function Root() {
      const [locked, setLocked] = React.useState(false);
      window.__lock = () => setLocked(true);
      window.__unlock = () => setLocked(false);
      return e(Gate, { locked }, e(App, null));
    }
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(e(Root, null));
    const wait = () => new Promise(r => setTimeout(r, 40));
    await wait();
    window.__open('KB001');                       // open a patient's documents
    await wait();
    const before = document.getElementById('app') && document.getElementById('app').textContent;
    window.__lock();                              // the password is asked for
    await wait();
    const boxShown = !!document.getElementById('box');
    window.__unlock();                            // and typed correctly
    await wait();
    const after = document.getElementById('app') && document.getElementById('app').textContent;
    return { before, boxShown, after };
  }, shape);

  // The glitch, reproduced.
  const old = await run('old');
  eq('before: the patient’s documents are open', old.before, 'documents|KB001');
  ok('the password box comes up', old.boxShown);
  eq('old behaviour: signing in lands on the dashboard with the patient closed',
     old.after, 'dashboard|');

  // And gone.
  const now = await run('new');
  eq('before: the patient’s documents are open', now.before, 'documents|KB001');
  ok('the password box still comes up', now.boxShown);
  eq('now: signing in leaves you exactly where you were', now.after, 'documents|KB001');

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
