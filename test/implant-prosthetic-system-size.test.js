// The Implant Prosthetic work-done sheet has always printed a "Company /
// Size" row, but the form had nowhere to enter either — only a tooth and a
// date per implant. The row printed whatever the surgery record happened to
// carry, or nothing at all, and a prosthetic done on an implant placed
// elsewhere had no way to say what it was seated on.
//
// So the form now asks, from the same master list the Implant Surgery form
// uses, with the built-in catalogue as the fallback and a typed size always
// accepted.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kbipsys-'));

function extract(blob, file) {
  const m = new RegExp('const ' + blob + '\\s*=\\s*([\\s\\S]*?);\\n').exec(html);
  if (!m) throw new Error(blob + ' not found');
  const b64 = (m[1].match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1)).join('');
  const text = Buffer.from(b64, 'base64').toString('utf8');
  fs.writeFileSync(path.join(OUT, file), text);
  return text;
}

const checks = [];
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, detail) =>
  checks.push({ name, ok: !!cond, got: detail, want: 'truthy' });

const host = child => {
  const p = path.join(OUT, 'h_' + child);
  fs.writeFileSync(p, `<!DOCTYPE html><html><body>
    <iframe src="${child}" style="width:100%;height:900px;border:0;"></iframe>
    <script>
      window.__posted = null;
      window.addEventListener('message', function(e){
        if (e.data && e.data.type === 'KB_SAVE_CLINICAL_SHEET') {
          window.__posted = e.data;
          e.source.postMessage({ type:'KB_SAVE_RESULT', token:e.data.token, ok:true }, '*');
        }
      });
    </script></body></html>`);
  return p;
};

const MASTER = [
  { name: 'Nobel Active', sizes: '3.0*10mm, 3.5*11.5mm, 4.3*13mm' },
  { name: 'Nobel Parallel CC', sizes: 'NP 3.75*10, RP 4.3*11.5' },
];

(async () => {
  const ip = extract('IMP_PROSTHETIC_B64', 'ip.html');

  ok('the sites table has an Implant System column', /<th>Implant System<\/th>/.test(ip));
  ok('and a Size column', /<th>Implant System<\/th><th>Size<\/th>/.test(ip));
  ok('the size is a datalist, so an unlisted one can still be typed',
    /list="sizes_'\+row\.id\+'"/.test(ip) && /<datalist id="sizes_/.test(ip));

  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.goto('file://' + host('ip.html'));
  await page.waitForTimeout(900);
  const f = page.frames().find(fr => fr.url().endsWith('/ip.html'));
  await f.waitForFunction(() => document.querySelectorAll('#impTbody tr').length > 0);

  const brands = () => f.evaluate(() =>
    Array.from(document.querySelector('[id^="brand_"]').options).map(o => o.textContent));

  // ── before the app sends anything, the built-in list keeps it usable ────
  const builtIn = await brands();
  ok('a brand dropdown exists on the row', builtIn.length > 1, builtIn.length);
  ok('and offers the built-in systems until the master arrives',
    builtIn.indexOf('Straumann') > 0 && builtIn.indexOf('Osstem') > 0, builtIn.join('|'));

  // ── the master replaces it ─────────────────────────────────────────────
  await f.evaluate(b => window.postMessage({ type: 'KB_IMPLANT_BRANDS', brands: b }, '*'), MASTER);
  await page.waitForTimeout(300);
  eq('the master list replaces the built-in one wholesale',
    await brands(), ['Select…', 'Nobel Active', 'Nobel Parallel CC']);

  const sizes = () => f.evaluate(() =>
    Array.from(document.querySelector('[id^="sizes_"]').options).map(o => o.value));
  const pickBrand = name => f.evaluate(n => {
    const sel = document.querySelector('[id^="brand_"]');
    sel.value = n;
    sel.dispatchEvent(new Event('change'));
  }, name);

  await pickBrand('Nobel Active');
  await page.waitForTimeout(200);
  eq('picking a system offers that system\'s sizes',
    await sizes(), ['3.0*10mm', '3.5*11.5mm', '4.3*13mm']);
  await pickBrand('Nobel Parallel CC');
  await page.waitForTimeout(200);
  eq('and changing it changes the sizes',
    await sizes(), ['NP 3.75*10', 'RP 4.3*11.5']);

  // ── it reaches the saved record ────────────────────────────────────────
  const pickSite = (rowIndex, tooth) => f.evaluate(({ rowIndex, tooth }) => {
    const btns = document.querySelectorAll('[id^="tbtn_"]');
    btns[rowIndex].click();
    const t = Array.from(document.querySelectorAll('.ft')).find(x => x.dataset.n === String(tooth));
    t.click();
    document.getElementById('modalConfirm').click();
  }, { rowIndex, tooth });

  await pickSite(0, 36);
  await page.waitForTimeout(200);
  await pickBrand('Nobel Active');
  await f.evaluate(() => { document.querySelector('[id^="size_"]').value = '4.3*13mm'; });

  // A second implant must not wipe the first row's system and size.
  await f.evaluate(() => document.getElementById('addImpBtn').click());
  await page.waitForTimeout(250);
  const firstStill = await f.evaluate(() => {
    const b = document.querySelectorAll('[id^="brand_"]')[0];
    const s = document.querySelectorAll('[id^="size_"]')[0];
    return [b.value, s.value];
  });
  eq('adding another implant leaves the first row alone',
    firstStill, ['Nobel Active', '4.3*13mm']);

  await pickSite(1, 46);
  await page.waitForTimeout(200);
  await f.evaluate(() => {
    const b = document.querySelectorAll('[id^="brand_"]')[1];
    b.value = 'Nobel Parallel CC';
    b.dispatchEvent(new Event('change'));
    document.querySelectorAll('[id^="size_"]')[1].value = 'RP 4.3*11.5';
    document.getElementById('pId').value = 'AL0777';
    document.getElementById('pName').value = 'Test Patient';
  });
  await f.evaluate(() => document.getElementById('saveBtn').click());
  await page.waitForTimeout(500);
  const rec = await page.evaluate(() => window.__posted && window.__posted.allTeeth);
  ok('the record was posted', !!rec);
  eq('each implant carries its own system and size',
    (rec && rec.implants || []).map(i => [i.site, i.brand, i.size]),
    [['36', 'Nobel Active', '4.3*13mm'], ['46', 'Nobel Parallel CC', 'RP 4.3*11.5']]);
  await page.close();

  // ── and comes back on the next visit ───────────────────────────────────
  const p2 = await browser.newPage();
  p2.on('pageerror', e => errors.push('resume: ' + e.message));
  await p2.goto('file://' + host('ip.html'));
  await p2.waitForTimeout(900);
  const f2 = p2.frames().find(fr => fr.url().endsWith('/ip.html'));
  // The brands arrive before the record, as they do in the app.
  await f2.evaluate(b => window.postMessage({ type: 'KB_IMPLANT_BRANDS', brands: b }, '*'), MASTER);
  await f2.evaluate(() => window.postMessage({ type: 'KB_CLINICAL_RECORD', record: {
    pName: 'Test Patient', pId: 'AL0777',
    implants: [
      { n: 1, site: '36', date: '01/09/2026', brand: 'Nobel Active', size: '4.3*13mm' },
      { n: 2, site: '46', date: '01/09/2026', brand: 'Nobel Parallel CC', size: 'RP 4.3*11.5' },
    ],
  } }, '*'));
  await p2.waitForTimeout(500);
  const back = await f2.evaluate(() =>
    Array.from(document.querySelectorAll('#impTbody tr')).map(tr => [
      tr.querySelector('[id^="brand_"]').value,
      tr.querySelector('[id^="size_"]').value,
    ]));
  eq('a second visit reopens on the systems the first recorded',
    back, [['Nobel Active', '4.3*13mm'], ['Nobel Parallel CC', 'RP 4.3*11.5']]);
  await p2.close();

  // ── a message that beats the form's own setup is not lost ──────────────
  const p3 = await browser.newPage();
  p3.on('pageerror', e => errors.push('early: ' + e.message));
  await p3.goto('file://' + host('ip.html'));
  const f3 = p3.frames().find(fr => fr.url().endsWith('/ip.html'));
  if (f3) await f3.evaluate(b => window.postMessage({ type: 'KB_IMPLANT_BRANDS', brands: b }, '*'), MASTER)
    .catch(() => {});
  await p3.waitForTimeout(1500);
  const f3b = p3.frames().find(fr => fr.url().endsWith('/ip.html'));
  const early = await f3b.evaluate(() =>
    Array.from(document.querySelector('[id^="brand_"]').options).map(o => o.textContent));
  ok('an early message is buffered, not dropped',
    early.indexOf('Straumann') < 0, early.join('|'));
  await p3.close();

  eq('the form threw nothing along the way', errors, []);
  await browser.close();

  let pass = 0, fail = 0;
  checks.forEach(c => {
    if (c.ok) { pass++; console.log('  PASS  ' + c.name); }
    else {
      fail++;
      console.log('  FAIL  ' + c.name + '\n          got ' + JSON.stringify(c.got) +
                  ', want ' + JSON.stringify(c.want));
    }
  });
  console.log('==============================================================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
