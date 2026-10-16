// Master's Save button did nothing at all — no save, no message, the row just
// sat there open. A phone column of digits leaves a Google Sheet as a NUMBER,
// not text, and the backend handed it straight through. The editor then
// called draft.phone.trim(), which threw inside the click handler, so the
// click was swallowed and nothing on screen said why.
//
// It only showed up once real phone numbers were in the masters, which is why
// it looked like the Edit button had broken the screen.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const GS = fs.readFileSync(path.join(REPO, 'apps-script/out/Code.gs'), 'utf8');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'kbnum-'));

const checks = [];
const eq = (name, got, want) =>
  checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
const ok = (name, cond, detail) =>
  checks.push({ name, ok: !!cond, got: detail, want: 'truthy' });

// ── the backend sends people as text ───────────────────────────────────────
const person_ = new Function(
  GS.slice(GS.indexOf("function person_("), GS.indexOf("\n}", GS.indexOf("function person_(")) + 2) +
  "\nreturn person_;")();
eq('a numeric phone cell leaves the sheet as text',
   person_(["Dr A", 9811111111, "a@x.in", "Endo"]),
   { name: "Dr A", phone: "9811111111", email: "a@x.in", role: "Endo" });
eq('an empty cell is an empty string, not undefined',
   person_(["Dr A"]), { name: "Dr A", phone: "", email: "", role: "" });
eq('a zero is kept, not swallowed by a falsy test',
   person_(["Dr A", 0, "", ""]).phone, "0");
ok('the doctor list goes through it', /items\.push\(person_\(data\[i\]\)\);[\s\S]{0,80}doctors: items/.test(GS));
ok('and the employee list', /items\.push\(person_\(data\[i\]\)\);[\s\S]{0,80}employees: items/.test(GS));

// ── and the editor survives one even if it does not ───────────────────────
function extract(name, file) {
  const a = HTML.indexOf("function " + name);
  const b = HTML.indexOf("\nfunction ", a + 10);
  fs.writeFileSync(path.join(OUT, file), HTML.slice(a, b));
}
extract("PersonListEditor", "comp.js");
for (const f of ["react/umd/react.development.js", "react-dom/umd/react-dom.development.js"])
  fs.copyFileSync(path.join(REPO, "node_modules", f), path.join(OUT, path.basename(f)));

fs.writeFileSync(path.join(OUT, "page.html"), `<!DOCTYPE html><html><body><div id="root"></div>
<script src="react.development.js"></script>
<script src="react-dom.development.js"></script>
<script>
var inp={padding:"7px 9px"}; var T="#0f6fc5", BGS="#f4f6f9", BORDER="#e2e2e2";
</script>
<script src="comp.js"></script>
<script>
function Host(){
  // Exactly what the sheet returns: the phone as a number.
  var s=React.useState([{name:"Dr. S. Mehta",phone:9811111111,email:"m@x.in",role:"Oral Surgery"}]);
  var items=s[0], setItems=s[1];
  return React.createElement(PersonListEditor,{ items:items,
    onAdd:function(it){ setItems(items.concat([it])); },
    onRemove:function(i){ setItems(items.filter(function(_,x){return x!==i;})); },
    onEdit:function(i,it){ window.__saved=it; setItems(items.map(function(x,ix){return ix===i?it:x;})); }});
}
ReactDOM.render(React.createElement(Host),document.getElementById('root'));
</script></body></html>`);

(async () => {
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.goto('file://' + path.join(OUT, 'page.html'));
  await page.waitForTimeout(400);

  // The real flow: change the role, never touch the phone box.
  await page.click('tbody button:has-text("Edit")');
  await page.fill('tbody input >> nth=3', 'Implantologist');
  await page.click('tbody button:has-text("Save")');
  await page.waitForTimeout(300);

  ok('Save closes the row instead of swallowing the click',
     !(await page.$('tbody button:has-text("Save")')));
  eq('the edit reached the save',
     await page.evaluate(() => window.__saved),
     { name: 'Dr. S. Mehta', phone: '9811111111', email: 'm@x.in', role: 'Implantologist' });
  eq('the numeric phone is carried through as text, not lost',
     await page.evaluate(() => window.__saved && typeof window.__saved.phone), 'string');
  eq('and the row shows it', await page.$$eval('tbody tr:first-child td', ts => ts.map(t => t.textContent)),
     ['Dr. S. Mehta', '9811111111', 'm@x.in', 'Implantologist', 'EditRemove']);
  eq('nothing threw', errors, []);

  await browser.close();
  let pass = 0, fail = 0;
  checks.forEach(c => {
    if (c.ok) { pass++; console.log('  PASS  ' + c.name); }
    else { fail++; console.log('  FAIL  ' + c.name + '\n          got ' + JSON.stringify(c.got) +
                               ', want ' + JSON.stringify(c.want)); }
  });
  console.log('==============================================================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
