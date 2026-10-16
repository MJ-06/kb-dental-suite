// Doctors and Employees could only be added and removed. A number typed
// wrongly, a spelling, a change of role — all of it meant deleting the person
// and retyping the other three fields, which is how a phone number quietly
// goes missing. Both screens share PersonListEditor, so one Edit fixes both.
const fs = require("fs");
const path = require("path");
const HTML = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};

const start = HTML.indexOf("function PersonListEditor");
ok("the editor is still there", start > 0);
const body = HTML.slice(start, HTML.indexOf("\nfunction MedicineListEditor", start));

ok("it takes an onEdit, like the other master lists",
   /function PersonListEditor\(\{[^}]*onEdit/.test(body));
ok("a row can be put into edit", /startEdit/.test(body) && /editAt===i/.test(body));
ok("there is a Save button", /\}, "Save"\)/.test(body));
ok("and a Cancel beside it", /setEditAt\(null\)/.test(body) && /\}, "Cancel"\)/.test(body));
ok("all four fields are editable, not just the name",
   ['"name"', '"phone"', '"email"', '"role"'].every(k => body.indexOf(k) > 0) &&
   /draft\[k\]/.test(body));
ok("Save is refused on an empty name", /disabled:!txt\(draft\.name\)\.trim\(\)/.test(body));
ok("nothing saves until Save is pressed — no save on blur", !/onBlur/.test(body));
ok("Enter saves and Escape backs out", /e\.key==="Enter"\) saveEdit\(i\)/.test(body) &&
   /e\.key==="Escape"\) setEditAt\(null\)/.test(body));
ok("there is an Edit button on each row", /\}, "Edit"\)/.test(body));
ok("and a Remove", /\}, "Remove"\)/.test(body));
ok("Remove asks first, naming the person", /window\.confirm\("Remove " \+ txt\(it\.name\)/.test(body));
ok("Edit and Remove sit side by side on one row, not stacked",
   /"Edit"\)[\s\S]{0,500}"Remove"\)/.test(body) && /whiteSpace:"nowrap"/.test(body));

// Wiring: both screens have to pass onEdit through or the button does nothing.
const site = HTML.slice(HTML.indexOf("doctors: () => React.createElement(PersonListEditor"),
                        HTML.indexOf("expenses: () => React.createElement"));
ok("Doctors wires onEdit to the save", /onEdit:\(i,item\)=>saveDoctors/.test(site));
ok("Employees wires onEdit to the save", /onEdit:\(i,item\)=>saveEmployees/.test(site));
ok("and both still wire add and remove",
   /onAdd:\(item\)=>saveDoctors/.test(site) && /onRemove:\(i\)=>saveDoctors/.test(site) &&
   /onAdd:\(item\)=>saveEmployees/.test(site) && /onRemove:\(i\)=>saveEmployees/.test(site));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
