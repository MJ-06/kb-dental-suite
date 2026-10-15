// The master's implant brands never reached the Implant Surgery form. The
// push was guarded on formId === "implantSurgery" while the form's id is
// "imp_surgery", so the condition was never true: the surgeon always saw the
// form's built-in list, with nothing on screen to say the master had been
// ignored. An id typed by hand in two places is exactly the kind of thing a
// test should hold still.
const fs = require("fs");
const path = require("path");
const HTML = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};

// The id as the form list actually declares it.
const decl = HTML.match(/\{ id:"(\w+)", label:"🔩 Implant Surgery"/);
ok("the Implant Surgery form is still in the list", !!decl);
const id = decl && decl[1];
ok("and its id is imp_surgery", id === "imp_surgery", "got " + id);

const guard = HTML.match(/if\(formId==="([\w]+)"\) sendImplantBrandsToForm\(\)/);
ok("opening a form can still send the brands", !!guard);
ok("the guard uses the id the form really has, not a near-miss",
   guard && guard[1] === id, "guard is on " + (guard && guard[1]) + ", form is " + id);
ok("nothing is guarded on the id that never existed",
   !/formId\s*===?\s*"implantSurgery"/.test(HTML));

const fn = HTML.slice(HTML.indexOf("const sendImplantBrandsToForm"),
                      HTML.indexOf("const sendTemplatesToForm"));
ok("the brands are read from the master, not hard-coded",
   /api\("getImplantBrandsList"\)/.test(fn));
ok("an empty or failed read leaves the form on its built-in list",
   /if \(!brands\.length\) return;/.test(fn) && /catch \(e\) \{ return; \}/.test(fn));
ok("delivery retries rather than firing once at a guessed delay",
   /for \(let i = 0; i < 40; i\+\+\)/.test(fn) && /setTimeout\(r, 250\)/.test(fn));
ok("and stops as soon as the form is there to receive them",
   /typeof w\.applyMasterBrands === "function"/.test(fn) && /if \(ready\) return;/.test(fn));
ok("it no longer guesses at 1.5 seconds", !/sendImplantBrandsToForm, 1500/.test(HTML));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
