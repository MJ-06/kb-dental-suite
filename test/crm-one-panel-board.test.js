// "When we click on a patient in leads the app crashes."
// "Why did we build a new pipeline -- we just need two."
// "Whenever we create a new pipeline the structure should remain as in
//  Dental Clinic Service Pipeline."
//
// All three came from one mistake. savePipeline put a board made by hand at
// the FRONT of the list, and the code that decided which board was "the
// regular one" read position 0. So the day the clinic built a CGHS board of
// its own it became board number one: private patients started landing on
// it, and the panel board this app generated was generated as a copy of IT
// instead of the dental board -- on top of the clinic's, which is why there
// were three.
//
// The crash was separate and worse: a useState inside renderLeadDetail,
// which only runs when a lead is open. Five hooks on the board, six on a
// lead, and React stops the whole CRM.
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
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const crm = (() => {
  const m = /const CRM_B64\s*=\n/.exec(html);
  const a = m.index, b = html.indexOf(';\n', a);
  return Buffer.from((html.slice(a, b).match(/"[^"]*"/g) || [])
    .map(x => x.slice(1, -1)).join(''), 'base64').toString('utf8');
})();

// ══ THE CRASH: no hook may sit behind an if ═════════════════════════════
// Checked structurally rather than by eye, because this is invisible in
// review and fatal in use: React counts hooks per render and refuses to
// carry on if the count moves.
{
  const body = crm.slice(crm.indexOf('function CRMPage() {'));
  const lines = body.split('\n');
  // Depth 1 is the component body itself. Anything deeper is inside some
  // other function, which may or may not run on a given render.
  let depth = 0;
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const code = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
    const hook = /(^|[^.\w])(useState|useEffect|useRef|useMemo|useCallback|useReducer|useLayoutEffect)\s*\(/.exec(code);
    if (hook && depth !== 1) bad.push('depth ' + depth + ': ' + line.trim().slice(0, 70));
    for (const ch of code) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth <= 0) break;                     // out of CRMPage
  }
  eq('every hook sits directly in the component body', bad, []);
}
ok('the lead tab is state, not a hook of its own',
   /var activeTab = st\.leadTab \|\| 'notes';/.test(crm) &&
   /function setTab\(t\)\{ upd\(\{leadTab:t\}\); \}/.test(crm));
ok('and it is declared with the rest of the view state', /leadTab:'notes',/.test(crm));
ok('opening a lead starts on its notes rather than the last lead’s tab',
   !/upd\(\{selLead:lead\.id,sec:'lead_detail'\}\)/.test(crm) &&
   /upd\(\{selLead:lead\.id,sec:'lead_detail',leadTab:'notes'\}\)/.test(crm));

// ══ lift the board logic out and run it ═════════════════════════════════
function slice(from, to) {
  const a = crm.indexOf(from), b = crm.indexOf(to, a);
  ok('found ' + from.trim().slice(0, 44), a > 0 && b > a, `${a}..${b}`);
  return crm.slice(a, b);
}
const CODE = [
  slice('  function consultPipeline(list){', '  /* The register already knows'),
  slice("  var TP_NAME = 'Treatment Progress';", '  function initPipelines(){')
].join('\n');

let seq = 0;
const sandbox = {
  Object, String, Array, JSON, st: { pipelines: [] },
  uid: () => 'n' + (++seq),
  nowISO: () => '2026-11-03T04:00:00.000Z',
  DEF_PIPELINE: { id: 'p_dental', name: 'Dental Clinic Service Pipeline', stages: [
    { id: 's1', name: 'Initial Contact', type: 'open' },
    { id: 's2', name: 'Consultation Scheduled', type: 'open' },
    { id: 's3', name: 'Treatment Planning', type: 'open' },
    { id: 's6', name: 'Treatment Progress', type: 'open' },
    { id: 's4', name: 'Treatment Completed', type: 'close' },
    { id: 's5', name: 'Patient Lost', type: 'close' }] }
};
vm.createContext(sandbox);
vm.runInContext(CODE +
  '\n;globalThis.__fold = foldGeneratedPanelBoard;' +
  '\n;globalThis.__regular = consultPipeline;' +
  '\n;globalThis.__panel = panelBoard;' +
  '\n;globalThis.__isPanel = isPanelBoard;' +
  '\n;globalThis.__isDental = isDentalBoard;' +
  '\n;globalThis.__stages = clinicStages;' +
  '\n;globalThis.__addPanel = addPanelPipeline;', sandbox);

const DENTAL = JSON.parse(JSON.stringify(sandbox.DEF_PIPELINE));
// The clinic's own, built by hand -- so it sits at the FRONT, which is how
// all of this started.
const THEIRS = { id: 'c_own1', name: 'CGHS Panel', stages: [
  { id: 'o1', name: 'Initial Contact', type: 'open' },
  { id: 'o2', name: 'Consultation Scheduled', type: 'open' },
  { id: 'o3', name: 'Treatment Planning', type: 'open' },
  { id: 'o4', name: 'Treatment Completed', type: 'close' }] };
const MINE = { id: 'p_panel', name: 'Panel Patients (CGHS / DGEHS)',
  panelLeadsMovedAt: '2026-11-01T00:00:00.000Z', stages: [
  { id: 'ps1', name: 'Initial Contact', type: 'open' },
  { id: 'ps2', name: 'Consultation Scheduled', type: 'open' },
  { id: 'ps3', name: 'Treatment Planning', type: 'open' },
  { id: 'ps4', name: 'Treatment Completed', type: 'close' }] };
const THREE = () => JSON.parse(JSON.stringify([THEIRS, DENTAL, MINE]));

// ══ WHICH BOARD IS WHICH -- by name, never by position ══════════════════
{
  const all = THREE();
  eq('the dental board is found even though it is second',
     sandbox.__regular(all).id, 'p_dental');
  eq('the clinic’s own CGHS board is the panel board', sandbox.__panel(all).id, 'c_own1');
  ok('the generated one is not preferred over theirs', sandbox.__panel(all).id !== 'p_panel');
  // The whole bug, asserted directly: position must not decide.
  const shuffled = [all[2], all[0], all[1]];
  eq('order does not change which board is the regular one',
     sandbox.__regular(shuffled).id, 'p_dental');
  eq('nor which is the panel one', sandbox.__panel(shuffled).id, 'c_own1');
}
{
  // A board the clinic names however it likes is still a panel board, so a
  // second one is never generated on top of it.
  for (const name of ['CGHS Panel', 'CGHS', 'DGEHS', 'cghs patients',
                      'Panel Patients', 'Empanelled', 'CGHS / DGEHS Board'])
    ok('"' + name + '" is recognised as a panel board', sandbox.__isPanel({ id: 'x', name }));
  for (const name of ['Dental Clinic Service Pipeline', 'New Pipeline', 'Orthodontics',
                      'Implants', 'Walk-ins'])
    ok('"' + name + '" is not', !sandbox.__isPanel({ id: 'x', name }));
  ok('the dental board is never a panel board even if renamed oddly',
     !sandbox.__isPanel({ id: 'p_dental', name: 'CGHS something' }));
  ok('and it is recognised by id or by name',
     sandbox.__isDental({ id: 'p_dental', name: 'whatever' }) &&
     sandbox.__isDental({ id: 'x', name: 'dental clinic service pipeline' }));
}
{
  // With their board already there, none is generated.
  eq('no second panel board is generated on top of the clinic’s',
     sandbox.__addPanel([THEIRS, DENTAL]).changed, false);
  // And when one IS generated, it copies the DENTAL board, not whatever is
  // first in the list. This is what gave the generated board the wrong
  // Kanban columns.
  const made = sandbox.__addPanel([{ id: 'c_other', name: 'Orthodontics',
    stages: [{ id: 'z1', name: 'Something', type: 'open' }] }, DENTAL]);
  const gen = made.pipelines.filter(p => p.id === 'p_panel')[0];
  eq('a generated board copies the dental board’s stages',
     gen.stages.map(s => s.name), DENTAL.stages.map(s => s.name));
}

// ══ THE FOLD: the generated board goes, its leads move ══════════════════
const lead = (id, pipelineId, stageId, extra) => Object.assign({
  id, title: 'Consultation — ' + id, pipelineId, stageId, status: 'open', notes: []
}, extra || {});

function fixture() {
  return {
    pipelines: THREE(),
    leads: [
      lead('l1', 'p_panel', 'ps2'),
      lead('l2', 'p_panel', 'ps3'),
      lead('l3', 'p_panel', 'ps4', { status: 'won' }),
      lead('l4', 'c_own1', 'o2'),          // already on theirs
      lead('l5', 'p_dental', 's2')         // a private patient
    ],
    followups: [
      { id: 'f1', leadId: 'l1', pipelineId: 'p_panel', status: 'open' },
      { id: 'f2', leadId: 'l5', pipelineId: 'p_dental', status: 'open' },
      { id: 'f3', leadId: 'l4', pipelineId: 'c_own1', status: 'open' }
    ]
  };
}
const fold = f => sandbox.__fold(f.leads, f.followups, f.pipelines);

{
  const f = fixture(), r = fold(f);
  ok('it did something', r.changed);
  eq('three leads moved', r.moved, 3);
  eq('off the generated board', r.removed, 'Panel Patients (CGHS / DGEHS)');
  eq('and onto the clinic’s own', r.into, 'CGHS Panel');
  eq('named and identified, so the view can switch to it', r.intoId, 'c_own1');

  eq('there are two boards left', r.pipelines.length, 2);
  eq('the generated one is gone', r.pipelines.filter(p => p.id === 'p_panel').length, 0);
  eq('the clinic’s board is still there', !!r.pipelines.filter(p => p.id === 'c_own1')[0], true);
  eq('and so is the dental one', !!r.pipelines.filter(p => p.id === 'p_dental')[0], true);

  const on = id => r.leads.find(l => l.id === id).pipelineId;
  eq('l1 moved across', on('l1'), 'c_own1');
  eq('l2 moved across', on('l2'), 'c_own1');
  eq('a closed lead moved too', on('l3'), 'c_own1');
  eq('a lead already on their board is untouched', on('l4'), 'c_own1');
  eq('and a private patient is left alone', on('l5'), 'p_dental');

  // No lead may be left naming a stage its board does not have: it would
  // vanish off the Kanban.
  for (const l of r.leads) {
    const pipe = r.pipelines.find(p => p.id === l.pipelineId);
    ok(l.id + '’s board still exists', !!pipe, l.pipelineId);
    if (pipe) ok(l.id + ' names a stage that board has',
                 pipe.stages.some(s => s.id === l.stageId), l.pipelineId + '/' + l.stageId);
  }
  const named = id => {
    const l = r.leads.find(x => x.id === id);
    const p = r.pipelines.find(x => x.id === l.pipelineId);
    return (p.stages.find(s => s.id === l.stageId) || {}).name;
  };
  eq('each lands at the stage it was on', named('l1'), 'Consultation Scheduled');
  eq('by name, not by number', named('l2'), 'Treatment Planning');
  eq('including a closed one', named('l3'), 'Treatment Completed');

  eq('the follow-up went with its lead',
     r.followups.find(x => x.id === 'f1').pipelineId, 'c_own1');
  eq('one follow-up moved', r.followupsMoved, 1);
  eq('the private patient’s follow-up stayed',
     r.followups.find(x => x.id === 'f2').pipelineId, 'p_dental');

  const note = r.leads.find(l => l.id === 'l1').notes;
  eq('a note says what happened', note.length, 1);
  ok('naming the board it ended up on', /CGHS Panel/.test(note[0].text), note[0].text);
  eq('the original list was not mutated', f.leads[0].pipelineId, 'p_panel');
}

// ── the "already moved" stamp is carried across ──────────────────────────
// Left on the board being deleted, the one-time move of panel patients off
// the regular board would look as if it had never run -- and run again.
{
  const f = fixture(), r = fold(f);
  const theirs = r.pipelines.find(p => p.id === 'c_own1');
  eq('the stamp moved to the surviving board',
     theirs.panelLeadsMovedAt, '2026-11-01T00:00:00.000Z');
}
{
  // If it never ran, nothing is invented -- so it can still run later.
  const f = fixture();
  delete f.pipelines.find(p => p.id === 'p_panel').panelLeadsMovedAt;
  const r = fold(f);
  ok('no stamp is invented',
     !r.pipelines.find(p => p.id === 'c_own1').panelLeadsMovedAt);
}
{
  // A stamp the clinic's board already has is not overwritten with an older one.
  const f = fixture();
  f.pipelines.find(p => p.id === 'c_own1').panelLeadsMovedAt = '2026-10-01T00:00:00.000Z';
  const r = fold(f);
  eq('an existing stamp is left alone',
     r.pipelines.find(p => p.id === 'c_own1').panelLeadsMovedAt, '2026-10-01T00:00:00.000Z');
}

// ── once, because there is nothing left to fold ──────────────────────────
{
  const f = fixture(), once = fold(f);
  const twice = sandbox.__fold(once.leads, once.followups, once.pipelines);
  eq('a second open folds nothing', twice.changed, false);
  eq('and moves nothing', twice.moved, 0);
}

// ── it refuses to leave panel patients nowhere ───────────────────────────
{
  // The generated board is the ONLY panel board. Removing it would orphan
  // every lead on it.
  const r = sandbox.__fold([lead('l1', 'p_panel', 'ps2')], [],
                           JSON.parse(JSON.stringify([DENTAL, MINE])));
  eq('with nothing to fold into, nothing is removed', r.changed, false);
  eq('and the leads stay where they are', r.leads[0].pipelineId, 'p_panel');
}
eq('no generated board at all is a no-op',
   sandbox.__fold([], [], [DENTAL, THEIRS]).changed, false);
eq('no boards at all is not a crash', sandbox.__fold([], [], []).changed, false);
eq('and nor is nothing at all',
   sandbox.__fold(undefined, undefined, undefined).changed, false);

// ══ A NEW BOARD LOOKS LIKE THE DENTAL ONE ═══════════════════════════════
{
  const cs = sandbox.__stages(THREE());
  eq('a new board gets the dental board’s stages, in order',
     cs.map(s => s.name), DENTAL.stages.map(s => s.name));
  eq('with the same open and closing stages',
     cs.map(s => s.type), DENTAL.stages.map(s => s.type));
  eq('and fresh ids, shared with no other board',
     cs.filter(s => DENTAL.stages.some(d => d.id === s.id)).length, 0);
  eq('every id unique', new Set(cs.map(s => s.id)).size, cs.length);
  // Not whatever happens to be first.
  eq('taken from the dental board, not position 0',
     sandbox.__stages([THEIRS, DENTAL]).map(s => s.name), DENTAL.stages.map(s => s.name));
  eq('and with no boards at all it falls back to the built-in one',
     sandbox.__stages([]).map(s => s.name), DENTAL.stages.map(s => s.name));
}
ok('"Start from blank" opens on those stages', /var cs = clinicStages\(\);/.test(crm));
ok('the pre-built template is the clinic’s own board',
   /name:'New Pipeline',stages:clinicStages\(\)/.test(crm));
ok('and "New / In Progress / Won / Lost" is gone',
   !/name:'In Progress',type:'open'/.test(crm));
ok('a board saved with no stages gets them too',
   /stages:allStages\.length\?allStages:clinicStages\(\)/.test(crm));
ok('and so does an AI board that generated none',
   /\(p\.stages&&p\.stages\.length\)\?p\.stages\.map/.test(crm));
// The front of the list is what started all of this.
ok('a new board goes on the END of the list',
   /if\(i>=0\) l\[i\]=p; else l\.push\(p\);/.test(crm) && !/else l\.unshift\(p\)/.test(crm));

// ══ it is wired into the open, before the panel move ════════════════════
ok('the fold runs when the CRM loads', /var fold = foldGeneratedPanelBoard\(/.test(crm));
ok('before the panel patients are moved',
   crm.indexOf('var fold = foldGeneratedPanelBoard(') < crm.indexOf('var mv = movePanelLeads('));
ok('the surviving boards are carried through the open',
   /cur\.pipelines = fold\.pipelines; dirty\.pipelines = true;/.test(crm));
ok('with the moved leads', /cur\.leads = fold\.leads; dirty\.leads = true;/.test(crm));
ok('and the moved follow-ups', /cur\.followups = fold\.followups; dirty\.followups = true;/.test(crm));
// By ID. A board is looked up by id, so naming one here left getPipeline
// with nothing and the view fell back to whichever board came first.
ok('a board being looked at when it disappears is swapped out, by id',
   /if\(patch\.selPipeline === PANEL_PIPELINE_ID\) patch\.selPipeline = fold\.intoId;/.test(crm));
ok('the clinic is told a duplicate board was removed',
   /There were two panel boards/.test(crm));
ok('and the other notices are not wiped by it',
   /told\.push\(/.test(crm) && /patch\.moveMsg = told\.join\('  '\);/.test(crm));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
