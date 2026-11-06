// Implant brands and their sizes are maintained in Master, not fixed in the
// app. The form takes the catalogue by message and rebuilds its brand dropdown
// and per-brand size list from it, while staying usable on its built-in list
// until one arrives — and never dropping a brand already recorded on a row.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kbbrands-'));
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

function extract() {
  const m = /const IMP_SURGERY_B64\s*=\s*([\s\S]*?);\n/.exec(html);
  const b64 = (m[1].match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1)).join('');
  const p = path.join(OUT, 'implant-surgery.html');
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

const checks = [];
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail, want: 'truthy' });

const brandNames = page => page.evaluate(() =>
  Array.from(document.querySelector('select[id^="brand_"]').options)
    .map(o => o.value).filter(Boolean));

const sizesFor = (page, brand) => page.evaluate(b => {
  const sel = document.querySelector('select[id^="brand_"]');
  sel.value = b;
  sel.dispatchEvent(new Event('change'));
  const dl = document.getElementById('sizes_' + sel.id.replace('brand_', ''));
  return Array.from(dl.options).map(o => o.value);
}, brand);

const send = (page, brands) => page.evaluate(bs => {
  window.postMessage({ type: 'KB_IMPLANT_BRANDS', brands: bs }, '*');
}, brands);

(async () => {
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.goto('file://' + extract());
  await page.waitForTimeout(250);

  // --- usable before Master has ever been filled in ------------------------
  const builtIn = await brandNames(page);
  ok('the form ships with a working brand list', builtIn.length > 0, builtIn.slice(0, 3));
  ok('built-in list includes Straumann', builtIn.indexOf('Straumann') >= 0, builtIn);

  // --- the master list replaces it ----------------------------------------
  await send(page, [
    { name: 'Straumann BLT', sizes: '3.3 × 8 mm, 4.1 × 10 mm' },
    { name: 'Osstem TS III', sizes: '4.0 × 10 mm' },
  ]);
  await page.waitForTimeout(150);

  eq('the brand dropdown becomes exactly the master list',
    await brandNames(page), ['Straumann BLT', 'Osstem TS III']);

  eq('sizes come from the master row', await sizesFor(page, 'Straumann BLT'),
    ['3.3 × 8 mm', '4.1 × 10 mm']);
  eq('a different brand gets its own sizes', await sizesFor(page, 'Osstem TS III'),
    ['4.0 × 10 mm']);

  // --- a brand with no sizes recorded is still selectable ------------------
  // Clear the row first: a brand left selected is deliberately kept in the
  // dropdown (covered below), which would otherwise mask what the new list is.
  await page.evaluate(() => { document.querySelector('select[id^="brand_"]').value = ''; });
  await send(page, [{ name: 'New System', sizes: '' }]);
  await page.waitForTimeout(150);
  eq('a brand with no sizes yet is still offered', await brandNames(page), ['New System']);
  eq('it simply offers no size suggestions', await sizesFor(page, 'New System'), []);
  ok('size stays typeable so an unlisted size is never blocked',
    await page.evaluate(() => {
      const el = document.querySelector('input[id^="size_"]');
      return el.tagName === 'INPUT' && !!el.getAttribute('list');
    }));

  // --- a brand already on a row survives it leaving the master list --------
  await page.evaluate(() => {
    const sel = document.querySelector('select[id^="brand_"]');
    sel.value = 'New System';
  });
  await send(page, [{ name: 'Something Else', sizes: '4.0 × 10 mm' }]);
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.querySelector('select[id^="brand_"]').value);
  eq('an implant already recorded keeps its brand after a master change',
    after, 'New System');
  ok('and that brand is kept in the dropdown so it still shows',
    (await brandNames(page)).indexOf('New System') >= 0, await brandNames(page));

  // --- an empty master list must not wipe the form -------------------------
  await send(page, []);
  await page.waitForTimeout(150);
  ok('an empty master list is ignored rather than emptying the dropdown',
    (await brandNames(page)).length > 0, await brandNames(page));

  eq('no uncaught page errors', errors, []);
  await page.close();

  // --- the app side: Master screen and the plumbing behind it -------------
  // Matched loosely on the spacing: the entry is aligned with the lists that
  // joined it under Clinical Configuration, and that is not what is pinned.
  ok('Master has an Implant Brands & Sizes subtab',
    /\{ id:"implantBrands",\s*label:"Implant Brands & Sizes" \}/.test(html));
  ok('Master renders the brand editor', html.includes('ImplantBrandListEditor'));
  ok('Master loads the list', html.includes('api("getImplantBrandsList")'));
  ok('Master saves the list', html.includes('saveImplantBrandsList'));
  ok('the app pushes the catalogue into the Implant Surgery form',
    html.includes('KB_IMPLANT_BRANDS'));

  const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');
  ok('backend exposes getImplantBrandsList', gs.includes('function getImplantBrandsList()'));
  ok('backend exposes saveImplantBrandsList', gs.includes('function saveImplantBrandsList(p)'));
  ok('both are routed', gs.includes('case "getImplantBrandsList"') && gs.includes('case "saveImplantBrandsList"'));
  ok('there is a paste-in patch note for the backend half',
    fs.existsSync(path.join(REPO, 'APPS-SCRIPT-PENDING.md')));

  await browser.close();

  let pass = 0, fail = 0;
  console.log('\n' + '='.repeat(78));
  console.log('IMPLANT BRANDS & SIZES — MAINTAINED IN MASTER');
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
