// One app, several books. An instance is a separate spreadsheet with its own
// Apps Script deployment, chosen by ?clinic=<id>. The property that matters is
// not that switching works — it is that it can never go wrong quietly: an
// unknown or unconfigured instance must refuse to load rather than fall
// through to the main clinic's book, and any non-main instance must say so on
// screen, because the app is otherwise identical.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const FILE = 'file://' + path.join(REPO, 'index.html');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail, want: 'truthy' });

// The app pulls React off a CDN this sandbox blocks, so the React tree never
// mounts here. Everything below is about the instance layer, which runs in a
// plain <script> before that — so it is fully exercised either way.
const state = (page) => page.evaluate(() => ({
  id: window.KB_INSTANCE_ID,
  label: window.KB_INSTANCE && window.KB_INSTANCE.label,
  url: window.KB_INSTANCE && window.KB_INSTANCE.scriptUrl,
  clinic: window.CLINIC && window.CLINIC.name,
  title: document.title,
  bodyText: document.body.innerText.slice(0, 400),
}));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const ctx = await browser.newContext();

  const open = async (qs) => {
    const page = await ctx.newPage();
    await page.goto(FILE + qs);
    await page.waitForTimeout(350);
    const s = await state(page);
    await page.close();
    return s;
  };

  // --- default: unchanged behaviour, no query string needed ---------------
  const main = await open('');
  eq('no query string means the main clinic', main.id, 'main');
  eq('the main clinic keeps its own letterhead', main.clinic, 'K.B. Dental Clinic');
  ok('the main clinic has its backend URL', /script\.google\.com/.test(main.url || ''), main.url);
  eq('and its title is untouched', main.title, 'K.B. Dental Clinical Suite');

  const explicit = await open('?clinic=main');
  eq('asking for main explicitly is the same thing', explicit.url, main.url);

  // --- a configured instance loads, on its OWN backend ---------------------
  const emp = await open('?clinic=empanelled');
  eq('the empanelled instance is itself, not main', emp.id, 'empanelled');
  ok('it has a backend URL of its own', /script\.google\.com/.test(emp.url || ''), emp.url);
  // The whole point of a separate book. Sharing main's deployment would put
  // empanelled patients straight into the main clinic's sheet.
  ok('and it is NOT the main clinic\'s backend', emp.url !== main.url, emp.url);
  ok('it says on screen which book it is', /Empanelled/i.test(emp.title), emp.title);

  // --- an instance with no backend still refuses, rather than falling through
  // Exercised against a copy of the real page with the URL blanked, so the
  // guard stays tested now that every shipped instance is configured.
  const tmp = path.join(require('os').tmpdir(), 'kb-instances-unconfigured.html');
  const unconfEmp = await (async () => {
    // The scriptUrl is now an expression, not a bare literal — it follows
    // window.KB_SERVER_URL when the clinic's own machine sets one and falls
    // back to the /exec URL otherwise. Blank the whole expression, which is
    // what "this instance has no backend" means either way.
    fs.writeFileSync(tmp, html.replace(
      /(empanelled: \{[\s\S]*?scriptUrl: )(?:KB_SERVER_URL \|\| )?"[^"]*"/, '$1""'));
    const p2 = await ctx.newPage();
    await p2.goto('file://' + tmp + '?clinic=empanelled');
    await p2.waitForTimeout(350);
    const st = await state(p2);
    await p2.close();
    fs.unlinkSync(tmp);
    return st;
  })();
  ok('an instance with no backend does not load the app',
    /not connected yet/i.test(unconfEmp.bodyText), unconfEmp.bodyText);
  ok('it says plainly that nothing was touched',
    /never write into another clinic|not open/i.test(unconfEmp.bodyText), unconfEmp.bodyText);
  ok('it never adopts the main clinic\'s backend URL',
    !(unconfEmp.url && /script\.google\.com/.test(unconfEmp.url)), unconfEmp.url);
  ok('it offers a way back', /Back to the main clinic/i.test(unconfEmp.bodyText), unconfEmp.bodyText);

  // --- an unknown id must refuse too, not silently become main ------------
  const bogus = await open('?clinic=doesnotexist');
  ok('an unknown instance refuses to load',
    /Unknown instance/i.test(bogus.bodyText), bogus.bodyText);
  ok('an unknown instance does not become the main clinic',
    bogus.id !== 'main', bogus.id);
  ok('and says nothing was touched',
    /no data has been touched/i.test(bogus.bodyText), bogus.bodyText);

  // An id from a URL is untrusted text; it is echoed back, so it must not be
  // able to create elements. It appearing as inert text is the correct outcome.
  const hostile = await ctx.newPage();
  const fired = [];
  hostile.on('dialog', d => { fired.push('dialog'); d.dismiss(); });
  await hostile.goto(FILE + '?clinic=' + encodeURIComponent('<img src=x onerror=alert(1)>'));
  await hostile.waitForTimeout(350);
  const injected = await hostile.evaluate(() => ({
    imgs: document.querySelectorAll('img').length,
    text: document.body.innerText.slice(0, 200),
  }));
  await hostile.close();
  eq('a hostile instance id creates no elements', injected.imgs, 0);
  eq('and executes nothing', fired, []);
  ok('it is shown as plain text instead', /Unknown instance/.test(injected.text), injected.text);

  // --- the source contract the above relies on ----------------------------
  ok('SCRIPT_URL comes from the selected instance, not a literal',
    /const SCRIPT_URL = \(window\.KB_INSTANCE/.test(html));
  // Every backend URL in the file must belong to an instance and be distinct;
  // a stray literal, or two instances sharing one, means data in the wrong book.
  const urls = html.match(/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+/g) || [];
  const declared = Object.values(JSON.parse(JSON.stringify(
    await (async () => { const p3 = await ctx.newPage(); await p3.goto(FILE);
      const v = await p3.evaluate(() => window.KB_INSTANCES); await p3.close(); return v; })()
  ))).map(i => i.scriptUrl).filter(Boolean);
  eq('every backend URL in the file belongs to an instance', urls.length, declared.length);
  eq('no two instances share a backend', new Set(declared).size, declared.length);
  ok('a non-main instance carries a badge for the sidebar',
    /badge: "EMPANELLED"/.test(html));
  ok('the sidebar renders that badge',
    /window\.KB_INSTANCE\.badge && React\.createElement/.test(html));

  await browser.close();

  let pass = 0, fail = 0;
  console.log('\n' + '='.repeat(78));
  console.log('INSTANCES — SEPARATE BOOKS, AND NO QUIET FALL-THROUGH');
  console.log('='.repeat(78));
  for (const c of checks) {
    c.ok ? pass++ : fail++;
    console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.name +
      (c.ok ? '' : `\n          expected ${JSON.stringify(c.want)}, got ${JSON.stringify(c.got)}`));
  }
  console.log('='.repeat(78));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})();
