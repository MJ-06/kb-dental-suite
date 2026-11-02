// "Unable to save anything in referral list and others."
//
// Not a fault in the app, and not something trying again fixes. The Apps
// Script deployment was older than the page: Code.gs had been pasted in and
// SAVED, but the deployment was not given a NEW VERSION, so the web app URL
// kept serving what it served before. The backend answered
// "Unknown action: saveReferralSourcesList" and the Master page printed that
// straight out, which reads as "saving is broken".
//
// A new master list is where this shows up first, because nothing else asks
// the backend for anything it did not already have.
//
// Two things were wrong, and one of them was the build marker I had built
// for exactly this and then left stale for every Code.gs change since.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const gs = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : '')); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// ── the build markers must agree, and must not be stale ─────────────────
const backend = (/var BACKEND_BUILD = "([^"]+)";/.exec(gs) || [])[1];
const required = (/const KB_BACKEND_BUILD_REQUIRED = "([^"]+)";/.exec(html) || [])[1];
ok('Code.gs says which build it is', !!backend, backend);
ok('and the app says which it needs', !!required, required);
eq('they agree', backend, required);
// The whole point of the marker is that it moves when Code.gs does. A
// backend that still claims a build from before the last few changes cannot
// warn anybody about anything.
ok('the marker is not the one that sat stale through all of this',
   backend > "2026-10-31", backend);

// ── the sidebar can still tell current from stale ───────────────────────
{
  const a = html.indexOf('function backendBuildState(build) {');
  const b = html.indexOf('\n}', a) + 2;
  const box = { String, KB_BACKEND_BUILD_REQUIRED: required };
  vm.createContext(box);
  vm.runInContext(html.slice(a, b) + '\n;globalThis.__s = backendBuildState;', box);
  eq('a backend on the required build is current', box.__s(required), 'current');
  eq('an older one is stale', box.__s('2026-10-31'), 'stale');
  eq('a newer one is still current', box.__s('2099-01-01'), 'current');
  for (const junk of ['', null, undefined, 'pong', '2026'])
    eq('a backend that cannot say reads as unknown: ' + JSON.stringify(junk),
       box.__s(junk), 'unknown');
}

// ── the message, which is the part the clinic actually reads ────────────
{
  const a = html.indexOf('function sayIfBackendIsOld(r) {');
  const b = html.indexOf('\nasync function apiDirect', a);
  ok('the translation was found', a > 0 && b > a, `${a}..${b}`);
  const box = { String, Object, RegExp };
  vm.createContext(box);
  vm.runInContext(html.slice(a, b) + '\n;globalThis.__f = sayIfBackendIsOld;', box);
  const f = box.__f;

  const out = f({ success: false, error: 'Unknown action: saveReferralSourcesList' });
  ok('it names the action the backend is missing',
     /saveReferralSourcesList/.test(out.error), out.error);
  ok('it says saving Code.gs is not enough', /Saving it is not enough/.test(out.error), out.error);
  ok('and gives the exact menu path',
     /Deploy → Manage deployments → edit → Version: New version → Deploy/.test(out.error),
     out.error);
  ok('it is marked so anything else can react to it', out.backendTooOld === true);
  ok('the raw "Unknown action" wording is gone from what the clinic sees',
     !/^Unknown action/.test(out.error), out.error);

  // Everything else must pass through untouched: this sits in the path of
  // every answer the app gets.
  const same = (name, r) => eq(name, f(r), r);
  same('a success is untouched', { success: true, flags: ['a'] });
  same('another failure is untouched', { success: false, error: 'the sheet did not answer' });
  same('an auth failure is untouched', { success: false, error: 'AUTH_REQUIRED', authRequired: true });
  same('a failure with no error at all', { success: false });
  eq('null is handled', f(null), null);
  eq('undefined is handled', f(undefined), undefined);
  eq('a non-object is handled', f('nope'), 'nope');
  // The original object must not be mutated — callers hold on to it.
  const orig = { success: false, error: 'Unknown action: x' };
  f(orig);
  eq('the answer it was given is not changed underneath the caller',
     orig.error, 'Unknown action: x');
}

// ── it is in the path of every answer ───────────────────────────────────
ok('every reply goes through it',
   /return handleAuthFailure\(sayIfBackendIsOld\(await r\.json\(\)\)\);/.test(html));
ok('and the backend still answers with its build',
   /build: BACKEND_BUILD/.test(gs));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
