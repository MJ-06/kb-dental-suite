// Drives the rebuilt Implant Prosthetic form in a real browser.
//
// Anaesthesia and Investigation were pulled out into their own sections
// (matching RCT/Crown & Bridge/Implant Surgery), tooth site stays per-implant
// as in Crown & Bridge, and the per-row Investigation/Impression/Tray/Bite
// selects were replaced with the same Final Impression / Tray / Bite
// Registered section built for Crown & Bridge.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kbip-'));

function extract() {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const m = /const IMP_PROSTHETIC_B64\s*=\s*([\s\S]*?);\n/.exec(html);
  if (!m) throw new Error('IMP_PROSTHETIC_B64 not found in index.html');
  const b64 = (m[1].match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1)).join('');
  const p = path.join(OUT, 'ip.html');
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

(async () => {
  const file = extract();
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));

  await page.goto('file://' + file);
  await page.waitForTimeout(200);

  const click = (groupId, label) => page.evaluate(({ groupId, label }) => {
    const g = document.getElementById(groupId);
    const b = Array.from(g.querySelectorAll('.btn')).find(x => x.textContent.trim() === label);
    if (!b) throw new Error('no button "' + label + '" in #' + groupId);
    b.click();
  }, { groupId, label });

  const visible = id => page.evaluate(i => {
    const el = document.getElementById(i);
    return !!el && el.style.display !== 'none';
  }, id);

  // --- step order ------------------------------------------------------------
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tab')).map(t => t.textContent.replace(/^[0-9✓]/, '').trim()));
  eq('five steps, ending in Summary', tabs,
    ['Site & Anaesthesia', 'Impression', 'Prosthesis Details', 'Laboratory & Dates', 'Summary']);

  // --- Anaesthesia and Investigation are their own cards in step 1 ----------
  const step1Headers = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#p1 .ch')).map(h => h.textContent.trim()));
  eq('step 1 has Implant Sites, Anaesthesia, and Investigation as separate cards',
    step1Headers, ['👑 Implant Sites — one row per implant', '💉 Anaesthesia', '🩻 Investigation']);

  // --- the row holds only what is genuinely per implant ---------------------
  // Investigation, Impression, Tray and Bite are decided once for the case and
  // were moved out to their own cards. System and Size went the other way:
  // they are per implant, and the work-done sheet prints them per implant.
  const cols = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#impTable thead th')).map(t => t.textContent.trim()).filter(Boolean));
  eq('implant table holds the per-implant fields and nothing case-level',
    cols, ['#', 'Tooth No./Site', 'Implant System', 'Size', 'Date']);

  // --- Investigation options, per the user's answer -------------------------
  const investOpts = await page.evaluate(() =>
    Array.from(document.getElementById('investGrp').querySelectorAll('.btn')).map(b => b.textContent.trim()));
  eq('investigation keeps RVG/OPG/CBCT/None', investOpts, ['RVG', 'OPG', 'CBCT', 'None']);
  await click('investGrp', 'CBCT');
  await click('investGrp', 'OPG');
  const investActive = await page.evaluate(() =>
    Array.from(document.getElementById('investGrp').querySelectorAll('.btn.active')).map(b => b.textContent.trim()));
  eq('investigation is single-choice', investActive, ['OPG']);

  // --- Impression section matches Crown & Bridge's rebuild -------------------
  const impressionHeaders = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#p2 .ch')).map(h => h.textContent.trim()));
  eq('step 2 is the impression section', impressionHeaders[0], '🔵 Final Impression');

  const finalImpOpts = await page.evaluate(() =>
    Array.from(document.getElementById('finalImp').querySelectorAll('.btn')).map(b => b.textContent.trim()));
  // This row is the impression coping, and is now named for it. Impression
  // Material is a separate row — see test/implant-prosthetic-coping.test.js.
  eq('the coping options match the reference form', finalImpOpts,
    ['Digital', 'Closed Tray', 'Open Tray']);

  const trayOpts = await page.evaluate(() =>
    Array.from(document.getElementById('trayUsed').querySelectorAll('.btn')).map(b => b.textContent.trim()));
  eq('tray options match the reference form (no more Triple Tray)', trayOpts,
    ['Custom Tray', 'Stock Tray']);

  await click('finalImp', 'Digital');
  await click('trayUsed', 'Custom Tray');

  const biteOpts = await page.evaluate(() =>
    Array.from(document.getElementById('biteType').querySelectorAll('.btn')).map(b => b.textContent.trim()));
  eq('bite options match the reference form (no more yes/no gate)', biteOpts,
    ['Resin (Jet Bite)', 'Wax', 'None']);
  await click('biteType', 'Resin (Jet Bite)');

  // --- what actually gets saved ----------------------------------------------
  await page.evaluate(() => {
    document.getElementById('pName').value = 'Test Patient';
    document.getElementById('pId').value = 'AL0777';
    document.getElementById('anaQty').value = '1.5';
  });
  await click('anaType', 'Mepivacaine');
  await click('anaMethod', 'Both');

  await page.evaluate(() => document.querySelector('[data-goto="5"]').click());
  await page.waitForTimeout(150);
  const summary = await page.evaluate(() => document.getElementById('summaryContent').innerText);
  const has = (label, text) => eq('summary shows ' + label, summary.includes(text), true);
  has('anaesthesia with quantity and method', 'Mepivacaine (1.5 ml) / Both');
  has('investigation', 'OPG');
  has('impression coping', 'Digital');
  has('tray', 'Custom Tray');
  has('bite', 'Resin (Jet Bite)');

  // --- reaching the summary via the tab rebuilds it, not just via Continue --
  await click('anaMethod', 'Infiltration');
  await page.evaluate(() => document.querySelector('.tab[data-tab="1"]').click());
  await page.evaluate(() => document.querySelector('.tab[data-tab="5"]').click());
  await page.waitForTimeout(150);
  const summary2 = await page.evaluate(() => document.getElementById('summaryContent').innerText);
  eq('summary reached via tab reflects the latest change, not a stale build',
    summary2.includes('Mepivacaine (1.5 ml) / Infiltration'), true);

  eq('no uncaught page errors', errors, []);

  await browser.close();

  let pass = 0, fail = 0;
  console.log('\n' + '='.repeat(78));
  console.log('IMPLANT PROSTHETIC FORM — SEPARATE ANAESTHESIA/INVESTIGATION, C&B IMPRESSION');
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
