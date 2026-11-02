// "2nd screen: no password asked and documents opened."
//
// Two faults behind that, and the second is the serious one.
//
// 1. api() coalesces get* reads into one `batch` request. The batch WRAPPER
//    succeeds even when a read inside it was refused for want of a session:
//    it comes back {success:true, results:{...}} with the refusal buried in
//    results. handleAuthFailure only ever saw the wrapper, so an expired or
//    missing session inside a batch never reached the sign-in screen.
//
// 2. The Documents screen set its list only on success. A refused read left
//    it empty, and the screen then said "No documents uploaded yet." --
//    telling the clinic a patient has no X-rays when the truth is that
//    nobody could look. On imaging, that is the worst answer available.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n          ' + detail : '')); }
};
const eq = (name, got, want) => ok(name, got === want, `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// ── 1. a refusal inside a batch reaches the sign-in screen ───────────────
const a = html.indexOf('function flushBatch() {');
const b = html.indexOf('\n}', html.indexOf('chunk.forEach(q => apiDirect(q.action, q.data).then(q.resolve));', a)) + 2;
ok('flushBatch was found', a > 0 && b > a, `${a}..${b}`);

function runBatch(batchResponse) {
  const seenByAuthHandler = [];
  const direct = [];
  const sandbox = {
    console, JSON, String, Array, Math, Promise, RegExp,
    KB_BATCH_MAX: 25,
    _batchTimer: null,
    _batchQueue: [],
    apiDirect: (action, data) => {
      if (action === 'batch') return Promise.resolve(batchResponse);
      direct.push(action);
      return Promise.resolve({ success: true, viaDirect: true });
    },
    // The real one drops the token and raises the sign-in screen.
    handleAuthFailure: (res) => { seenByAuthHandler.push(res); return res; }
  };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(a, b) + '\n;globalThis.__flush = flushBatch;', sandbox);

  const answers = {};
  const waits = ['docs', 'panels'].map(key => new Promise(resolve => {
    sandbox._batchQueue.push({
      key, action: key === 'docs' ? 'getPatientDocuments' : 'getPanelsList',
      data: {}, entry: { key, action: key === 'docs' ? 'getPatientDocuments' : 'getPanelsList' },
      resolve: (r) => { answers[key] = r; resolve(r); }
    });
  }));
  sandbox.__flush();
  return Promise.all(waits).then(() => ({ answers, seenByAuthHandler, direct }));
}

(async () => {
  // One read inside the batch refused, the wrapper itself succeeding.
  // This is exactly the shape the clinic's backend returns.
  const { answers, seenByAuthHandler } = await runBatch({
    success: true,
    results: {
      docs: { success: false, error: 'AUTH_REQUIRED', authRequired: true },
      panels: { success: true, panels: ['CGHS'] }
    }
  });

  ok('the refusal is handed to the auth handler',
     seenByAuthHandler.some(r => r && r.authRequired === true),
     JSON.stringify(seenByAuthHandler));
  ok('and so is the read that worked, as before',
     seenByAuthHandler.some(r => r && r.success === true),
     JSON.stringify(seenByAuthHandler));
  eq('the caller still gets its refusal', answers.docs.authRequired, true);
  eq('and the other read is unaffected', answers.panels.panels[0], 'CGHS');

  // A whole batch that fails still falls back to individual reads.
  {
    const { direct } = await runBatch({ success: false, error: 'no batch action' });
    eq('every read is retried on its own', direct.length, 2);
  }
  // And an entry the batch itself refused to serve is still retried alone,
  // rather than being mistaken for an auth problem.
  {
    const { direct } = await runBatch({
      success: true,
      results: { docs: { success: false, error: 'batch: reads only' },
                 panels: { success: true, panels: [] } }
    });
    eq('the unserved entry goes out on its own', direct.length, 1);
    eq('and it is the right one', direct[0], 'getPatientDocuments');
  }

  // ── 2. the Documents screen tells the two empties apart ────────────────
  // It takes a second argument now -- every patient's folder asks for the
  // password, and `force` is how unlocking one says it may be read.
  const loadDocs = html.slice(html.indexOf('  const loadDocs = (uhid, force) => {'),
                              html.indexOf('React.useEffect(() => {', html.indexOf('  const loadDocs = (uhid, force) => {')));
  ok('a failed read no longer leaves the list quietly empty',
     /setDocs\(\[\]\);\s*\n\s*setDocsError\(/.test(loadDocs), loadDocs.slice(0, 400));
  ok('a locked folder says it is locked',
     /These documents are locked/.test(loadDocs));
  ok('and says where the password is',
     /Master \\u203A Security/.test(loadDocs) || /Master › Security/.test(loadDocs));
  ok('any other failure says it could not read, not that there are none',
     /That is not the same as there being none/.test(loadDocs));
  ok('a thrown error is handled the same way',
     /\.catch\(\(e\) => \{[\s\S]{0,200}setDocsError\(/.test(loadDocs), loadDocs.slice(-400));

  // The empty-folder message must not show when the real answer is "locked".
  ok('"No documents uploaded yet" is held back when there is a reason',
     /!loading && !docsError && docs\.length === 0/.test(html));
  ok('and the reason is shown in its place',
     /!loading && docsError && React\.createElement/.test(html));

  // ── 3. the printed-copy message is not doubled ────────────────────────
  // The prescription form already prefixes "Printed, but NOT kept:", so this
  // is the reason only. It used to read "Printed, but NOT kept: Printed. The
  // copy was not filed..." on screen.
  ok('the copy-not-filed message gives only the reason',
     /error: locked\s*\n\s*\? "patient documents need the password from Master/.test(html),
     (html.match(/error: locked[\s\S]{0,160}/) || [''])[0]);
  ok('it no longer repeats the outcome',
     !/"Printed\. The copy was not filed/.test(html));

  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
