// Reports, rendered for real.
//
// reports.test.js checks the arithmetic. This checks the thing the clinic
// actually gets: that the component mounts, draws, and does not throw. A
// React error anywhere in it produces a BLANK PAGE with nothing in the
// console the front desk would ever see, which is exactly what "I do not
// see anything in reports" looks like.
//
// React comes from the repo's own node_modules, so nothing is fetched.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });

const a = html.indexOf('// ── Reports ─');
const b = html.indexOf('\n// Sits in front of the whole app when the backend has REQUIRE_AUTH', a);
ok('the Reports block was found in the page', a > 0 && b > a, `${a}..${b}`);
const REPORTS_SRC = html.slice(a, b);

// Everything the block leans on from the rest of the page. Stubs, because
// what is under test is Reports, not the date formatter -- but every one of
// them is named here, so a new dependency shows up as a crash rather than
// as a silently blank screen.
const DEPS = `
  const { useState, useRef, useEffect } = React;
  const T = "#0078B4", TL = "#DCF4FB", BORDER = "#e5e5e0", BGS = "#f5f5f0";
  const inp = { padding: "8px", border: "1px solid #e5e5e0", borderRadius: 6, fontSize: 13 };
  function toISODate(d){ const p = n => String(n).padStart(2,"0");
    return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()); }
  function fmtDMY(x){ return String(x).slice(0,10).split("-").reverse().join("/"); }
  function reasonWithStep(t, s){ return s ? (t + " \\u00b7 " + s) : (t || "\\u2014"); }
  function ReportsPasswordChanger(){ return React.createElement("div", { id:"pwchanger" }, "change password"); }
`;

function backend(opts) {
  const o = opts || {};
  return `
  window.__calls = [];
  function api(action, params){
    window.__calls.push(action);
    if (${o.failing ? 'true' : 'false'} && action === "getReceipts")
      return Promise.resolve({ success:false, error:"the sheet did not answer" });
    if (${o.hanging ? 'true' : 'false'} && action === "getDailyRegister")
      return new Promise(() => {});           // never settles
    const R = {
      getReceipts: { success:true, receipts:[
        { uhid:"AA0001", date:"${o.d1 || '2026-10-02'}", service:"RCT", fee:8000 },
        { uhid:"AA0002", date:"${o.d1 || '2026-10-02'}", service:"Consultation", fee:500 }] },
      getExpenses: { success:true, expenses:[{ date:"${o.d1 || '2026-10-03'}", category:"Lab", amount:3000 }] },
      getDailyRegister: { success:true, entries:[
        { uhid:"AA0001", date:"${o.d1 || '2026-10-02'}", procedureDone:"RCT" },
        { uhid:"AA0002", date:"${o.d1 || '2026-10-02'}", procedureDone:"Consultation" }] },
      getAppointments: { success:true, appointments:[
        { id:1, date:"${o.d1 || '2026-10-02'}", status:"No Show", type:"RCT", subType:"BMP", patientName:"Missed One", mobile:"9810000000" },
        { id:2, date:"${o.d1 || '2026-10-02'}", status:"Completed", type:"RCT", subType:"" }] },
      getAllPatients: { success:true, patients:[
        { uhid:"AA0001", registeredOn:"${o.reg || '2026-10-01'}T00:00:00Z" },
        { uhid:"AA0002", registeredOn:"${o.reg || '2026-10-01'}T00:00:00Z" }] },
      getTreatmentsMaster: { success:true, treatments: ${JSON.stringify(o.treatments || [
        { name: 'RCT', fee: 8000, cost: '', department: 'Endodontics' },
        { name: 'Consultation', fee: 500, cost: '', department: 'Consultation' }])} },
      getFollowUps: { success:true, postTreatment:[], recall:[], missed:[] }
    };
    return Promise.resolve(R[action] || { success:true });
  }`;
}

// A fresh page each time. Reusing one and calling setContent again left the
// root empty on every render after the first, which would have read as nine
// broken reports rather than a reused page.
async function render(browser, opts, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.setContent('<div id="root"></div>');
  for (const f of ['node_modules/react/umd/react.production.min.js',
                   'node_modules/react-dom/umd/react-dom.production.min.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(REPO, f), 'utf8') });
  }
  await page.addScriptTag({ content: DEPS + backend(opts) });
  await page.addScriptTag({ content: REPORTS_SRC });
  await page.addScriptTag({ content: `
    try { ReactDOM.createRoot(document.getElementById("root"))
            .render(React.createElement(ReportsModule, null)); }
    catch (e) { window.__renderErr = String((e && e.message) || e); }` });
  await page.waitForTimeout(opts && opts.wait ? opts.wait : 700);
  const out = await page.evaluate(() => ({
    err: window.__renderErr || null,
    calls: window.__calls || [],
    text: document.getElementById('root').innerText || ''
  }));
  await page.close();
  return out;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const errors = [];

  // ── it draws ───────────────────────────────────────────────────────────
  const out = await render(browser, {}, errors);
  eq('nothing threw while rendering', out.err, null);
  ok('and nothing threw after it', errors.length === 0, errors.join(' | '));
  ok('all seven reads were made', out.calls.length === 7, out.calls.join(','));

  // The page is not blank. This is the check that matters.
  ok('the page is not blank', out.text.trim().length > 200, out.text.length);
  for (const heading of ['1. Patients each month', '2 & 3. What the money comes from',
                         '6. Most chosen treatments', '7. Where patients stop',
                         '8. Booked, but did not turn up', '9. Revenue, expenses and profit',
                         '9b. Treatment against consultation', 'Expenses by category']) {
    ok('it shows "' + heading + '"', out.text.includes(heading), out.text.slice(0, 200));
  }
  ok('the password changer is reachable', out.text.includes('change password'));
  ok('real numbers reach the screen', /8,500|8500/.test(out.text.replace(/\s+/g, '')), out.text.slice(0, 400));

  // ── a read that fails is reported, not drawn as zero ───────────────────
  const failed = await render(browser, { failing: true }, errors);
  eq('a failed read does not throw', failed.err, null);
  ok('it names what could not be read', /Could not read: receipts/.test(failed.text), failed.text.slice(0, 300));
  ok('and says what to do about it', /shorter date range/.test(failed.text), failed.text.slice(0, 300));
  ok('no report is drawn from books that did not arrive',
     !failed.text.includes('9. Revenue, expenses and profit'), failed.text.slice(0, 300));

  // ── a read that never answers must not hang the page for ever ──────────
  // The real ceiling is ninety seconds; this only proves the page keeps
  // drawing and says what it is waiting for rather than going blank.
  const hung = await render(browser, { hanging: true, wait: 900 }, errors);
  eq('a hung read does not throw', hung.err, null);
  ok('the page says it is still reading', /Reading the books/.test(hung.text), hung.text.slice(0, 200));
  ok('and says how far it has got', /of 7/.test(hung.text), hung.text.slice(0, 200));

  // ── margins appear only once a cost is on file ─────────────────────────
  const noCost = await render(browser, {}, errors);
  ok('with no costs it says so rather than inventing a margin',
     noCost.text.includes('Highest and lowest margin treatment'), noCost.text.slice(0, 300));
  ok('and points at where to type the cost',
     /Treatments & Fees/.test(noCost.text), noCost.text.slice(0, 300));

  const withCost = await render(browser, { treatments: [
    { name: 'RCT', fee: 8000, cost: 2500, department: 'Endodontics' },
    { name: 'Consultation', fee: 500, cost: '', department: 'Consultation' }] }, errors);
  eq('margins do not throw', withCost.err, null);
  ok('the margin report appears once a cost exists',
     withCost.text.includes('4 & 5. Margin by treatment'), withCost.text.slice(0, 300));
  ok('and the treatment with no cost is left off it',
     /1 treatment\(s\) were done or billed in this range but have no cost/.test(withCost.text),
     withCost.text.slice(withCost.text.indexOf('4 & 5'), withCost.text.indexOf('4 & 5') + 500));
  // RCT: earned 8000, cost 2500 once done -> 5500, 69%.
  ok('with the arithmetic on screen', /69%/.test(withCost.text),
     withCost.text.slice(withCost.text.indexOf('4 & 5'), withCost.text.indexOf('4 & 5') + 400));

  await browser.close();

  const failedChecks = checks.filter(c => !c.ok);
  for (const c of failedChecks) {
    console.log('  FAIL  ' + c.name);
    if (c.want !== undefined) console.log('        wanted ' + JSON.stringify(c.want));
    if (c.got !== undefined) console.log('        got    ' + JSON.stringify(c.got));
  }
  console.log('  ' + (checks.length - failedChecks.length) + ' passed, ' + failedChecks.length + ' failed');
  process.exit(failedChecks.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
