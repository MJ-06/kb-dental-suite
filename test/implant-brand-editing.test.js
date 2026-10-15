// Master -> Implant Brands & Sizes used to save a sizes change the moment
// focus left the box, with no button to press and nothing to cancel, and the
// brand name itself could not be edited at all — a brand typed wrongly was
// stuck that way. It now works like the fee lists: Edit, then Save or Cancel,
// with Delete beside it.
const fs = require("fs");
const path = require("path");
const HTML = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};

const start = HTML.indexOf("function ImplantBrandListEditor");
ok("the editor is still there", start > 0);
const body = HTML.slice(start, HTML.indexOf("\nfunction TemplateListEditor", start));

ok("it takes an onEdit, like the other master lists", /function ImplantBrandListEditor\(\{[^}]*onEdit/.test(body));
ok("a row can be put into edit", /startEdit/.test(body) && /editAt===i/.test(body));
ok("there is a Save button", /\}, "Save"\)/.test(body));
ok("and a Cancel beside it", /setEditAt\(null\)/.test(body) && /\}, "Cancel"\)/.test(body));
ok("the brand name is editable, not just the sizes", /draft\.name/.test(body) && /draft\.sizes/.test(body));
ok("Save is refused on an empty brand name", /disabled:!draft\.name\.trim\(\)/.test(body));
ok("nothing saves until Save is pressed — no save on blur", !/onBlur/.test(body));
ok("there is an Edit button on each row", /\}, "Edit"\)/.test(body));
ok("and a Delete", /\}, "Delete"\)/.test(body));
ok("Delete asks first, naming the brand", /window\.confirm\("Delete " \+ it\.name/.test(body));
ok("Edit and Delete sit side by side on one row, not stacked",
   /"Edit"\)[\s\S]{0,400}"Delete"\)/.test(body) && /whiteSpace:"nowrap"/.test(body));

// Wiring: the screen has to pass onEdit through or the button does nothing.
const site = HTML.slice(HTML.indexOf("implantBrands: () => React.createElement(ImplantBrandListEditor"));
ok("the screen wires onEdit to the save", /onEdit:\(i,v\)=>saveImplantBrands/.test(site.slice(0, 500)));
ok("and still wires add and remove", /onAdd:\(v\)=>saveImplantBrands/.test(site.slice(0, 500)) &&
   /onRemove:\(i\)=>saveImplantBrands/.test(site.slice(0, 500)));

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
