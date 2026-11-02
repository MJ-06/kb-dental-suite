// "Everywhere it takes up a signature for Dr. Viveyk Mittel, instead it
//  should take the operating doctor's name for it to sign."
// "Change the Good morning, Dr. Viveyk to K.B. Dental here, and when making
//  it for selling it should be a placeholder for the clinic name."
// "Shift Implant Brands and Sizes from Clinic to Clinical Configuration."
//
// The signature one is not cosmetic. A consent form is a document saying a
// NAMED doctor explained the risks; printing one doctor's name on a form for
// a patient another doctor is treating is a false record, and it was on the
// registration consent, the care plan, the treatment plan, the cost sheet
// and every consent form in the app.
//
// The app already knew who was treating the patient: treatingDoctorFor()
// reads today's appointment for them and falls back to Master's first
// doctor. It was only being used for the forms in the iframe.
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

// ── not one of them is left ─────────────────────────────────────────────
eq('no form carries a doctor name typed into the markup',
   (html.match(/Viveyk/g) || []).length, 0);
// Nor the clinic's own name as a greeting: a copy sold to somebody else
// would greet them by this clinic's doctor.
ok('the dashboard greeting is computed, not typed',
   /\}, greeting\(\)\), /.test(html));

// ── who signs, lifted out and run ───────────────────────────────────────
const A = html.indexOf('var KB_SIGNING_DOCTOR = "";');
const B = html.indexOf('// Resolves who is treating this patient', A);
ok('the signing logic was found', A > 0 && B > A, `${A}..${B}`);
const box = { String, RegExp };
let doctors = [];
box.getDoctors = () => doctors.slice();
vm.createContext(box);
vm.runInContext(html.slice(A, B) +
  '\n;globalThis.__set = setSigningDoctor;' +
  '\n;globalThis.__who = signingDoctor;' +
  '\n;globalThis.__line = signatureLine;' +
  '\n;globalThis.__dr = withDr;', box);

// "Dr." is added, but never twice: Master holds whatever the clinic typed.
eq('a bare name gets Dr.', box.__dr('Mehta'), 'Dr. Mehta');
eq('one that has it keeps it', box.__dr('Dr. Mehta'), 'Dr. Mehta');
eq('lower case counts', box.__dr('dr. mehta'), 'dr. mehta');
eq('without the full stop too', box.__dr('Dr Mehta'), 'Dr Mehta');
eq('a professor is not re-titled', box.__dr('Prof. Rao'), 'Prof. Rao');
eq('and nothing stays nothing', box.__dr('   '), '');

{
  doctors = ['Viveyk Mittel', 'Anita Rao'];
  box.__set('');
  eq('with nobody set, the clinic’s first doctor signs', box.__who(), 'Dr. Viveyk Mittel');
  box.__set('Anita Rao');
  eq('the treating doctor signs when there is one', box.__who(), 'Dr. Anita Rao');
  eq('and the line reads as it always did',
     box.__line('02/11/2026'), 'Dr. Anita Rao | Date: 02/11/2026');
  // A doctor who has left Master still signs the form they are treating on:
  // the appointment is the record, not the list.
  box.__set('Dr. Someone Else');
  eq('a name not on the list is still used', box.__who(), 'Dr. Someone Else');
}
{
  // THE POINT. No doctors list and nobody resolved: a blank line for
  // somebody to write on, never another doctor's name.
  doctors = [];
  box.__set('');
  eq('with nothing to go on, nobody is named', box.__who(), '');
  eq('and the line is just the date', box.__line('02/11/2026'), 'Date: 02/11/2026');
}

// ── every screen that prints resolves it ────────────────────────────────
for (const [name, anchor] of [
  ['the care plan', 'function CarePlan\\('],
  ['the treatment plan', 'function TreatmentPlan\\('],
  ['registration', 'function Registration\\('],
]) ok(name + ' resolves who is treating the patient',
      new RegExp(anchor + '[\\s\\S]{0,700}useSigningDoctor\\(').test(html));
ok('the consent forms do too',
   /var pat = _p\[0\], setPat = _p\[1\];\n  useSigningDoctor\(pat && pat\.uhid\);/.test(html));
eq('all four of them', (html.match(/useSigningDoctor\(/g) || []).length, 5);  // 4 calls + the definition
ok('and it is the treating doctor it asks for, not a guess',
   /treatingDoctorFor\(id\)\.then\(name => \{ if \(alive\) setSigningDoctor\(name\); \}\)/.test(html));
// Clearing it matters: moving from a patient to no patient must not leave
// the last patient's doctor on the next form printed.
ok('leaving the patient clears it', /if \(!id\) \{ setSigningDoctor\(""\); return; \}/.test(html));

// ── the greeting ────────────────────────────────────────────────────────
{
  const a = html.indexOf('function greeting(now) {');
  const b = html.indexOf('\n}', a) + 2;
  const g = { window: { CLINIC: { name: 'K.B. Dental Clinic' } }, String, Date };
  vm.createContext(g);
  vm.runInContext(html.slice(a, b) + '\n;globalThis.__g = greeting;', g);
  const at = h => new Date(2026, 10, 2, h, 0, 0);
  eq('morning', g.__g(at(9)), 'Good morning, K.B. Dental Clinic');
  eq('afternoon', g.__g(at(14)), 'Good afternoon, K.B. Dental Clinic');
  // It said "Good morning" at half past ten at night.
  eq('evening', g.__g(at(22)), 'Good evening, K.B. Dental Clinic');
  eq('midnight is morning', g.__g(at(0)), 'Good morning, K.B. Dental Clinic');
  eq('five is still afternoon’s end', g.__g(at(17)), 'Good evening, K.B. Dental Clinic');
  // Sold to another clinic: their name the moment they set it, and no name
  // at all until they do — never this clinic's.
  g.window.CLINIC = { name: 'Smile Dental Care' };
  eq('another clinic’s copy greets them', g.__g(at(9)), 'Good morning, Smile Dental Care');
  for (const empty of [{ name: '' }, { name: '   ' }, {}, null]) {
    g.window.CLINIC = empty;
    eq('with no clinic name it greets without one: ' + JSON.stringify(empty),
       g.__g(at(9)), 'Good morning');
  }
}

// ── Implant Brands & Sizes moved ────────────────────────────────────────
const tabsOf = (id) => {
  const a = html.indexOf('{ id:"' + id + '"');
  const b = html.indexOf(']}', a);
  return (html.slice(a, b).match(/id:"(\w+)"/g) || []).map(x => x.slice(4, -1)).slice(1);
};
ok('it has left CLINIC', tabsOf('clinic').indexOf('implantBrands') < 0, tabsOf('clinic').join(','));
eq('and is what Clinical Configuration holds', tabsOf('clinicalConfig'), ['implantBrands']);
ok('which is no longer an empty placeholder',
   !/id:"clinicalConfig", label:"Clinical Configuration", placeholder:true/.test(html));
ok('the editor behind it is untouched',
   /implantBrands: \(\) => React\.createElement/.test(html));

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
