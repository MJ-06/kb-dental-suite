// Changes the clinic asked for on two work-done forms.
//
// RCT:
//   - Endomethasone on the sealer list.
//   - The accessory-cone entry took a COUNT only. A count does not say what
//     went into the canal, and the size is what the next dentist needs when
//     the tooth is opened again — so each canal now takes a size as well,
//     and it has to travel into the summary and onto the printed sheet.
//
// Implant Surgery:
//   - A Second Stage Surgery section after Follow-up: flap type, abutment
//     type, and whether a suture was placed — with a removal date that only
//     appears once one was.
//
// These forms live base64-encoded inside index.html, so they are decoded,
// written to disk and DRIVEN here. A form that merely contains the right
// markup is not the same as one that works.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kbforms-'));

function extract(constName) {
  const m = new RegExp('const ' + constName + '\\s*=\\s*([\\s\\S]*?);\\n').exec(html);
  if (!m) throw new Error(constName + ' not found');
  const b64 = (m[1].match(/"([^"]*)"/g) || []).map(s => s.slice(1, -1)).join('');
  const p = path.join(OUT, constName + '.html');
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
}

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const errors = [];

  // ══ RCT ════════════════════════════════════════════════════════════
  const rct = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  rct.on('pageerror', e => errors.push('RCT: ' + e.message));
  await rct.goto('file://' + extract('RCT_FORM_B64'));
  await rct.waitForTimeout(350);

  eq('Endomethasone is on the sealer list, after the ones already there',
     await rct.$$eval('#sealG .btn', b => b.map(x => x.textContent.trim())),
     ['AH Plus', 'ZOE-based', 'Bioceramic', 'MTA-based', 'Endomethasone']);
  ok('and it can be chosen like any other sealer', await rct.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#sealG .btn'))
      .find(x => x.textContent.trim() === 'Endomethasone');
    b.click();
    return b.classList.contains('active');
  }));

  // Canals have to be picked before the obturation table exists at all.
  await rct.evaluate(() => ['MB', 'P'].forEach(n => {
    const b = document.querySelector('[data-canal="' + n + '"]');
    if (b) b.click();
  }));
  await rct.waitForTimeout(300);

  eq('the accessory column asks for both the number and the size',
     await rct.$$eval('#obT thead th', t => t.map(x => x.textContent.trim())),
     ['Canal', 'Final WL (mm)', 'Master Cone Size', 'Accessory Cones (no. & size)']);
  eq('and every canal gets both boxes',
     await rct.evaluate(() => ['MB', 'P'].map(c => [
       !!document.getElementById('acc_' + c), !!document.getElementById('accsz_' + c)])),
     [[true, true], [true, true]]);

  // What the doctor reads back has to carry the size, or it was typed for
  // nothing.
  // buildWorkDone is not global; it runs off the form's own input events
  // and writes into #workDoneBox, so the boxes are filled the way a person
  // fills them and the panel is read back.
  const summaryFor = async (vals) => {
    await rct.evaluate((v) => {
      const set = (id, val) => {
        const el = document.getElementById(id);
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('fwl_MB', v.fwl); set('acc_MB', v.acc); set('accsz_MB', v.accsz);
    }, vals);
    await rct.waitForTimeout(150);
    // The summary is built when the summary step is opened, and again
    // before printing. Printing is the one that does not need navigation.
    return rct.evaluate(() => {
      window.dispatchEvent(new Event('beforeprint'));
      const b = document.getElementById('workDoneBox');
      return b ? b.innerHTML : '';
    });
  };

  let out = await summaryFor({ fwl: '21', acc: '2', accsz: 'MF' });
  ok('the summary says how many accessory cones and what size',
     /MB:[\s\S]{0,120}?Acc\. cones: 2 \(MF\)/.test(out),
     (out.match(/MB:[^<]{0,140}/) || [''])[0]);

  out = await summaryFor({ fwl: '21', acc: '', accsz: 'MF' });
  ok('a size with no count is still reported, not thrown away',
     /Acc\. cone size: MF/.test(out), (out.match(/MB:[^<]{0,140}/) || [''])[0]);

  out = await summaryFor({ fwl: '21', acc: '2', accsz: '' });
  ok('and a count with no size reads exactly as it used to',
     /Acc\. cones: 2(?!\s*\()/.test(out), (out.match(/MB:[^<]{0,140}/) || [''])[0]);

  // The printed sheet is built separately from the summary, so it is
  // checked separately.
  // The printed sheet is built by a different function from the summary, so
  // it is pinned separately — otherwise one could carry the size and the
  // other quietly not.
  const rctSrc0 = fs.readFileSync(path.join(OUT, 'RCT_FORM_B64.html'), 'utf8');
  ok('the printed sheet carries the size too',
     /if\(acc&&acc!=="—"\) s\+=", Acc="\+acc\+\(accsz&&accsz!=="—"\?" \("\+accsz\+"\)":""\);/.test(rctSrc0) &&
     /else if\(accsz&&accsz!=="—"\) s\+=", Acc size="\+accsz;/.test(rctSrc0));

  // Saved and restored with the sitting, or it is gone on reload.
  const rctSrc = fs.readFileSync(path.join(OUT, 'RCT_FORM_B64.html'), 'utf8');
  ok('the size is saved with the sitting',
     /accsz: document\.getElementById\('accsz_'\+c\) \? document\.getElementById\('accsz_'\+c\)\.value : ''/.test(rctSrc));
  ok('and put back when it is opened again',
     /if \(document\.getElementById\('accsz_'\+c\)\) document\.getElementById\('accsz_'\+c\)\.value = d\.accsz\|\|'';/.test(rctSrc));

  await rct.close();

  // ══ Implant Surgery ════════════════════════════════════════════════
  const imp = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  imp.on('pageerror', e => errors.push('IMP: ' + e.message));
  await imp.goto('file://' + extract('IMP_SURGERY_B64'));
  await imp.waitForTimeout(350);

  eq('the flap types offered are the two asked for',
     await imp.$$eval('#ssFlapType .btn', b => b.map(x => x.textContent.trim())),
     ['Tissue Punch', 'Open Flap']);
  eq('and the abutment types are the three asked for',
     await imp.$$eval('#ssAbutType .btn', b => b.map(x => x.textContent.trim())),
     ['Healing Abutment', 'Stock Abutment', 'Multi-unit Abutment']);
  eq('suture placed is a plain yes or no',
     await imp.$$eval('#ssSuture .btn', b => b.map(x => x.textContent.trim())),
     ['Yes', 'No']);

  // It belongs to the second stage, which happens months later, so it sits
  // after the follow-up rather than among the surgery that placed it.
  ok('the section sits after Follow-up and before Provisional & Dates',
     await imp.evaluate(() => {
       const heads = Array.from(document.querySelectorAll('.ch')).map(h => h.textContent);
       const fu = heads.findIndex(h => /Follow-up/.test(h));
       const ss = heads.findIndex(h => /Second Stage Surgery/.test(h));
       const pr = heads.findIndex(h => /Provisional/.test(h));
       return fu >= 0 && ss === fu + 1 && pr === ss + 1;
     }));

  // The removal date is not a question until a suture was placed.
  eq('the removal date is hidden to begin with',
     await imp.evaluate(() => document.getElementById('ssSutureRemovalDateRow').style.display), 'none');
  await imp.evaluate(() => Array.from(document.querySelectorAll('#ssSuture .btn'))
    .find(b => b.textContent.trim() === 'Yes').click());
  await imp.waitForTimeout(250);
  ok('it appears once a suture was placed',
     await imp.evaluate(() => document.getElementById('ssSutureRemovalDateRow').style.display) !== 'none');
  await imp.evaluate(() => Array.from(document.querySelectorAll('#ssSuture .btn'))
    .find(b => b.textContent.trim() === 'No').click());
  await imp.waitForTimeout(250);
  eq('and goes away again if there was none',
     await imp.evaluate(() => document.getElementById('ssSutureRemovalDateRow').style.display), 'none');

  const impSrc = fs.readFileSync(path.join(OUT, 'IMP_SURGERY_B64.html'), 'utf8');
  ok('the second stage is saved with the record',
     /ssFlapType:ga\('ssFlapType'\),ssAbutType:ga\('ssAbutType'\),/.test(impSrc) &&
     /ssSuture:ga\('ssSuture'\),ssSutureRemovalDate:gv\('ssSutureRemovalDate'\),/.test(impSrc));
  ok('and restored when it is opened again',
     /setGroup\('ssFlapType',rec\.ssFlapType\); setGroup\('ssAbutType',rec\.ssAbutType\);/.test(impSrc));
  ok('it is on the printed sheet, after the first-stage suture lines',
     /opt\('Second Stage — Flap',d\.ssFlapType\)/.test(impSrc) &&
     /opt\('Second Stage — Abutment',d\.ssAbutType\)/.test(impSrc) &&
     /opt\('Second Stage — Suture',d\.ssSuture==='Yes'/.test(impSrc));
  // The clinical-record sheet keeps a column per field; a field missing
  // from here is saved by the form and lost by the sheet.
  // CR_CFG lives inside the form, not in index.html, so it is read there.
  ok('and it has columns in the clinical-record sheet',
     /\["ssFlapType", "Second Stage — Flap Type"\]/.test(impSrc) &&
     /\["ssSutureRemovalDate", "Second Stage — Suture Removal Date"\]/.test(impSrc) &&
     /\{"title": "SECOND STAGE SURGERY", "fields":/.test(impSrc));

  await imp.close();
  ok('neither form threw', errors.length === 0, errors.join(' // '));
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
