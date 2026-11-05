// The clinic reported the grey text as hard to read at the counter. Every text
// grey in the app was darkened and every on-screen size below 14 raised a
// notch. These pin it, because a single later edit pasted from an old screen
// is all it takes for the faint grey to creep back in one corner.
var fs = require("fs");
var src = fs.readFileSync(__dirname + "/../index.html", "utf8");
var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
}
function count(re) { return (src.match(re) || []).length; }

// --- no faint text greys anywhere ------------------------------------------
["#999", "#aaa", "#888", "#777", "#666", "#555"].forEach(function (g) {
  var n = count(new RegExp('(?<![a-zA-Z-])color:\\s*"?' + g, "gi"));
  ok("no text is " + g + " any more", n === 0, n + " still there");
});

// --- and the darker ones are actually in use -------------------------------
ok("the darker greys replaced them",
   count(/(?<![a-zA-Z-])color:\s*"?#(4b4b4b|5a5a5a|444444|3d3d3d|383838|2e2e2e)/gi) > 300);

// Hierarchy matters as much as contrast: if every grey collapsed onto one
// value, a hint would shout as loudly as a heading.
var distinct = ["#4b4b4b", "#5a5a5a", "#444444", "#3d3d3d", "#383838", "#2e2e2e"]
  .filter(function (c) { return src.indexOf(c) !== -1; });
ok("and they are still distinct from each other, not one flat grey",
   distinct.length >= 5, distinct.join(" "));

// --- nothing tiny left on screen -------------------------------------------
// Every size was raised one notch, so 12 and 13 legitimately exist now — they
// are what 11 and 12 became. What must not survive is the bottom of the old
// range, which is what the clinic was squinting at.
["11", "11.5"].forEach(function (f) {
  var n = count(new RegExp("fontSize:\\s*" + f.replace(".", "\\.") + "(?![0-9.])", "g"));
  ok("nothing on screen at " + f + "px any more", n === 0, n + " still there");
});
ok("12px is the smallest text in the app",
   count(/fontSize:\s*12(?![0-9.])/g) > 0);
ok("and plenty of it reached 14",
   count(/fontSize:\s*14(?![0-9.])/g) > 150);

// --- the printed documents, with one deliberate exception ------------------
// Consent forms, the registration printout and the rest keep their sizes:
// those are page layouts, and growing the type pushes a form onto an extra
// sheet, which is worse than small print on paper held at reading distance.
//
// The clinical work-done sheet is the exception. The clinic asked for it
// directly — "the font size should be readable (it is too small and a lot of
// page is empty)" — so its own stylesheet was enlarged and nothing else was.
// The counts moved by exactly the two rules that changed in it.
//
// 8.5pt went 29 -> 31 when the CGHS endorsement was added, then 31 -> 30
// when that sheet lost its beneficiary signature: it prints on the
// prescription pad now, and only the doctor signs it. 10pt went 44 -> 45
// with the pad sheet's own table cells. A count that moves for any other
// reason is a sheet whose type was changed by accident.
// 30 -> 31 and 45 -> 46 with the CGHS prescription: its signature line and
// its table cells are set at the same sizes as every other sheet's, which is
// the point of pinning this.
// Moved again with the CGHS bill, which has two signature captions at 8.5pt
// and a table at 10pt -- the same sizes every other sheet uses, which is the
// point of pinning this. A count that moves for any other reason is a sheet
// whose type was changed by accident.
ok("the other printed documents keep their 8.5pt", count(/font-size:8\.5pt/g) === 33);
ok("and their 10pt", count(/font-size:10pt/g) === 47);
ok("and their 11pt", count(/font-size:11pt/g) === 14);

const clcss = src.slice(src.indexOf("const CL_PCSS = `"), src.indexOf("`;", src.indexOf("const CL_PCSS = `")));
ok("the clinical sheet's body type is readable", /font-size:12pt;color:#111/.test(clcss));
ok("its table cells too", /td\{padding:8pt 9pt;border:0\.5pt solid #ddd;font-size:12pt/.test(clcss));
ok("and its row labels", /\.row-lbl\{[^}]*font-size:11\.5pt/.test(clcss));

// --- borders and backgrounds were never the problem ------------------------
ok("borders were not darkened", count(/borderColor:\s*"#(4b4b4b|5a5a5a|444444|3d3d3d|383838|2e2e2e)"/g) === 0);
ok("nor backgrounds", count(/background(Color)?:\s*"?#(4b4b4b|5a5a5a|444444|3d3d3d|383838|2e2e2e)/g) === 0);

console.log("==============================================================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("==============================================================================");
process.exit(fail ? 1 : 0);
