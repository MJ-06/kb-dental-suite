// "I need a separate pipeline for CGHS and for regular patients."
//
// A panel patient's lead does not belong on the same board as a private
// one: the money comes from CGHS or DGEHS rather than from the patient, the
// paperwork differs, and mixing them makes both boards useless for seeing
// what is actually waiting.
//
// So there are two, and a new patient goes to the right one by itself --
// from the registration queue AND from an import, which are the only two
// ways a lead is opened automatically.
//
// The stages start identical on purpose. The panel process is the clinic's
// to describe, not something to be guessed at here; stages can be added to
// that board in the CRM like any other.
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

// ── lift out the pieces that decide things ───────────────────────────────
function slice(from, to) {
  const a = crm.indexOf(from), b = crm.indexOf(to, a);
  ok('found ' + from.trim().slice(0, 42), a > 0 && b > a, `${a}..${b}`);
  return crm.slice(a, b);
}
const CODE = [
  slice("  var PANEL_PIPELINE_ID = 'p_panel';", '  var TP_NAME'),
  slice("  var TP_NAME = 'Treatment Progress';", '  function initPipelines(){'),
  slice('  function consultPipeline(list){', '  /* The register already knows')
].join('\n');

const sandbox = { Object, String, Array, JSON, st: { pipelines: [] },
                  nowISO: () => '2026-11-01T00:00:00.000Z',
                  DEF_PIPELINE: { id: 'p_dental', stages: [] } };
vm.createContext(sandbox);
vm.runInContext(CODE +
  '\n;globalThis.__upgrade = upgradePipelines;' +
  '\n;globalThis.__panel = addPanelPipeline;' +
  '\n;globalThis.__for = pipelineFor;' +
  '\n;globalThis.__stage = consultStage;', sandbox);

const LIVE = [{
  id: 'p_dental', name: 'Dental Clinic Service Pipeline',
  customFields: [{ id: 'cf1', name: 'Service Type' }],
  stages: [
    { id: 's1', name: 'Initial Contact', type: 'open' },
    { id: 's2', name: 'Consultation Scheduled', type: 'open' },
    { id: 's3', name: 'Treatment Planning', type: 'open' },
    { id: 's4', name: 'Treatment Completed', type: 'close' },
    { id: 's5', name: 'Patient Lost', type: 'close' }
  ]
}];

// ── the second board appears ─────────────────────────────────────────────
{
  const r = sandbox.__upgrade(JSON.parse(JSON.stringify(LIVE)));
  ok('the pipelines were changed', r.changed);
  eq('there are two boards now', r.pipelines.length, 2);
  eq('the first is still the regular one', r.pipelines[0].id, 'p_dental');
  eq('and the second is the panel one', r.pipelines[1].id, 'p_panel');
  ok('named for what it is', /CGHS/.test(r.pipelines[1].name), r.pipelines[1].name);

  const reg = r.pipelines[0].stages.map(s => s.name);
  const pan = r.pipelines[1].stages.map(s => s.name);
  eq('the panel board starts with the same stages', pan, reg);
  ok('including the new Treatment Progress one', pan.includes('Treatment Progress'), pan);

  // Two boards must not share a stage id, or moving a lead on one would be
  // ambiguous about which stage it meant.
  const regIds = r.pipelines[0].stages.map(s => s.id);
  const panIds = r.pipelines[1].stages.map(s => s.id);
  eq('no stage id is shared between the boards',
     regIds.filter(i => panIds.includes(i)), []);
  eq('and the panel board’s own ids are unique', new Set(panIds).size, panIds.length);
  // The regular board's ids must not have moved: every lead names one.
  eq('the regular board’s stage ids are untouched', regIds.slice(0, 3), ['s1', 's2', 's3']);
}

// ── running it again changes nothing ─────────────────────────────────────
{
  const once = sandbox.__upgrade(JSON.parse(JSON.stringify(LIVE)));
  const twice = sandbox.__upgrade(once.pipelines);
  eq('a second run reports no change', twice.changed, false);
  eq('and makes no third board', twice.pipelines.length, 2);
  const thrice = sandbox.__upgrade(twice.pipelines);
  eq('nor does a third run', thrice.pipelines.length, 2);
}
// Somebody who built one by hand must not get a duplicate.
{
  const theirs = [LIVE[0], { id: 'whatever', name: 'Panel Patients (CGHS / DGEHS)', stages: [] }];
  eq('a board they named themselves is recognised',
     sandbox.__panel(theirs).changed, false);
}
eq('no pipelines at all is left alone', sandbox.__panel([]).changed, false);

// ── a patient lands on the right board ───────────────────────────────────
{
  const both = sandbox.__upgrade(JSON.parse(JSON.stringify(LIVE))).pipelines;
  eq('a CGHS patient goes to the panel board',
     sandbox.__for({ panel: 'CGHS' }, both).id, 'p_panel');
  eq('so does a DGEHS one', sandbox.__for({ panel: 'DGEHS' }, both).id, 'p_panel');
  eq('whitespace is not a panel', sandbox.__for({ panel: '   ' }, both).id, 'p_dental');
  eq('a private patient stays on the regular board',
     sandbox.__for({ panel: '' }, both).id, 'p_dental');
  eq('and so does one with no panel field at all',
     sandbox.__for({}, both).id, 'p_dental');

  // If the panel board were somehow deleted, a CGHS patient must still get
  // a lead rather than falling through a gap.
  eq('with no panel board they fall back to the regular one',
     sandbox.__for({ panel: 'CGHS' }, LIVE).id, 'p_dental');
}

// ── both lead-opening paths choose per patient ───────────────────────────
// This is the bit that would quietly half-work: picking the board once
// before the loop puts a whole import on one board whatever the panels say.
ok('the registration queue chooses inside the loop',
   /var pipe = pipelineFor\(pt, pipesNow\), consult = consultStage\(pipe\);\s*\n\s*if\(!pipe \|\| !consult\) return;\s*\n\s*newLeads\.push\(consultationLead/.test(crm),
   (crm.match(/pipelineFor\(pt, pipesNow\)[\s\S]{0,180}/) || [''])[0]);
ok('and so does the import',
   /var pipe = pipelineFor\(pt\), consult = consultStage\(pipe\);/.test(crm));
ok('neither picks one board before the loop any more',
   !/var pipe = consultPipeline\(\), consult = consultStage\(pipe\);/.test(crm) &&
   !/var pipe = consultPipeline\(pipesNow\), consult = consultStage\(pipe\);/.test(crm));

// ── it is applied everywhere the pipelines live ──────────────────────────
ok('this browser’s saved copy is upgraded', /var up = upgradePipelines\(saved\);/.test(crm));
ok('and the clinic book’s copy', /upgradePipelines\(patch\.pipelines\)/.test(crm));
ok('which is sent back up', /crmSaveOne\('pipelines', up\.pipelines\)/.test(crm));
// Order matters: the panel board is copied from the regular one, so the
// regular one must gain Treatment Progress first or the copy lacks it.
ok('the stage is added before the board is copied from it',
   /var a = addTreatmentProgress\(pipelines\);\s*\n\s*var b = addPanelPipeline\(a\.pipelines\);/.test(crm));

// ── what the clinic is told ──────────────────────────────────────────────
ok('the queue says how many went to the panel board',
   /on the panel board/.test(crm));
ok('and the import summary no longer names a single stage',
   !/' opened as ' \+ consult\.name \+ ' lead\(s\)'/.test(crm));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
