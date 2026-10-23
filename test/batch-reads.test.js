// Refreshing was slow because every list was its own HTTPS request to Apps
// Script, which charges roughly a second of start-up each and limits how many
// run at once for one user. The Master page asked for eighteen, so they
// queued. This runs the real batchRead_ out of Code.gs, and checks the page's
// end of the bargain in index.html.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const GS = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

const checks = [];
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail, want: 'truthy' });

// --- the real batchRead_, with a route() that records how it was called ----
const a = GS.indexOf('var BATCH_MAX = 25;');
const b = GS.indexOf('function route(p) {', a);
const src = GS.slice(a, b);

let calls = [];
function makeApi(routeImpl) {
  calls = [];
  return new Function('route', src + '\nreturn batchRead_;')(routeImpl);
}
const goodRoute = (p) => { calls.push(p); return { success: true, got: p.action, token: p.token }; };

{
  const batchRead_ = makeApi(goodRoute);
  const r = batchRead_({ actions: JSON.stringify(['getChairsList', 'getPaymentModesList']), token: 'T1' });
  eq('a batch succeeds', r.success, true);
  eq('each action is answered under its own name',
    Object.keys(r.results).sort(), ['getChairsList', 'getPaymentModesList']);
  eq('the results are the actions\' own', r.results.getChairsList.got, 'getChairsList');
  eq('it really ran them, once each', calls.map(c => c.action),
    ['getChairsList', 'getPaymentModesList']);
  // Auth is not re-implemented here: each action goes back through route(),
  // which applies the same session check it always did. The token must reach it.
  eq('the caller\'s token is passed to every action',
    calls.map(c => c.token), ['T1', 'T1']);
}

// --- the refusals ---------------------------------------------------------
{
  const batchRead_ = makeApi(goodRoute);
  eq('no actions is an error', batchRead_({ actions: '[]' }).success, false);
  eq('unparseable actions is an error too', batchRead_({ actions: 'not json' }).success, false);

  const many = batchRead_({ actions: JSON.stringify(new Array(26).fill('getChairsList')) });
  eq('more than the limit is refused outright', many.success, false);
  ok('and says the limit', /at most 25/.test(many.error), many.error);

  // Writes must not go through here: a batch half-applied is a worse problem
  // than a slow page.
  const w = batchRead_({ actions: JSON.stringify(['saveChairsList', 'getChairsList']) });
  eq('a write inside a batch is refused', w.results.saveChairsList.success, false);
  ok('and says why', /reads only/.test(w.results.saveChairsList.error), w.results.saveChairsList.error);
  eq('while the read beside it still runs', w.results.getChairsList.success, true);
  eq('the write never reached route()', calls.map(c => c.action), ['getChairsList']);

  // Unbounded nesting.
  const n = batchRead_({ actions: JSON.stringify(['batch']) });
  eq('a batch inside a batch is refused', n.results.batch.success, false);
}

// --- one action failing must not take the others with it ------------------
{
  const batchRead_ = makeApi((p) => {
    calls.push(p);
    if (p.action === 'getMedicinesMaster') throw new Error('sheet missing');
    return { success: true, got: p.action };
  });
  const r = batchRead_({ actions: JSON.stringify(['getChairsList', 'getMedicinesMaster', 'getReasonsList']) });
  eq('the batch as a whole still succeeds', r.success, true);
  eq('the failure is reported against its own action', r.results.getMedicinesMaster.success, false);
  ok('with the reason', /sheet missing/.test(r.results.getMedicinesMaster.error),
    r.results.getMedicinesMaster.error);
  eq('the action after it still ran', r.results.getReasonsList.success, true);
}

// --- the backend is routed to at all --------------------------------------
ok('Code.gs routes the batch action', /case "batch":\s*return batchRead_\(p\);/.test(GS));

// --- the page's end -------------------------------------------------------
ok('index.html has the batch helper', /async function apiBatch\(actions\)/.test(html));
// This matters more than it looks: index.html ships via Pages the moment it
// merges, while Code.gs only changes when it is pasted and redeployed by hand.
// Without the fallback the Master page would be broken in between.
ok('it falls back to individual calls on an older backend',
  /return Promise\.all\(actions\.map\(a => api\(a\)\)\);/.test(html));

// The Master page's call specifically — there are other apiBatch callers now
// (the CRM asks for its staff this way), and the first one in the file is not
// necessarily this one.
const master = html.slice(html.indexOf('apiBatch([\n      "getTreatmentsMaster"'));
const names = (master.slice(0, master.indexOf(']')).match(/"([^"]+)"/g) || []).length;
const destructured = (/\.then\(\(\[([^\]]+)\]/.exec(master) || [, ''])[1]
  .split(',').map(s => s.trim()).filter(Boolean).length;
eq('every list asked for has somewhere to land', names, destructured);
// Not a fixed number: the list grows as Master grows. What matters is that
// they go in ONE request, which the equality above already pins, and that the
// page is still asking for a realistic set rather than having quietly lost
// most of them.
ok('the Master page still fetches its full set of lists', names >= 18, names);
eq('the Master page no longer fires them one by one',
  /Promise\.all\(\[\s*api\("getTreatmentsMaster"/.test(html), false);

let pass = 0, fail = 0;
console.log('\n' + '='.repeat(78));
console.log('EIGHTEEN LISTS, ONE ROUND TRIP');
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
