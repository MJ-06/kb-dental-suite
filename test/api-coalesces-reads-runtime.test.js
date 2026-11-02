// The shape tests next door prove the code is written. This one runs it: the
// real api()/apiDirect/flushBatch are lifted out of index.html and driven
// against a fake backend, so the claim "a dozen reads become one request" is
// measured rather than asserted from a regex.
var fs = require("fs");
var src = fs.readFileSync(__dirname + "/../index.html", "utf8");
var pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
}

function slice(from, to) {
  var a = src.indexOf(from);
  var b = src.indexOf(to, a);
  if (a === -1 || b === -1) throw new Error("could not find " + from);
  return src.slice(a, b);
}

var code =
  slice("const KB_BATCH_MAX = 25;", "// Several reads in ONE round trip.") +
  "\nreturn { api: api, reset: function () { _batchQueue = []; _batchTimer = null; } };";

// The fake backend. It records every request and answers a batch the way
// Code.gs does: one object keyed by action name.
var calls;
function build() {
  calls = [];
  function apiDirect(action, data) {
    calls.push({ action: action, data: data || {} });
    return Promise.resolve(
      action === "batch"
        // Mirrors the real backend: entries are {key, action, params} and the
        // results are keyed by `key`, so the same action asked twice with
        // different parameters does not overwrite itself.
        ? { success: true, results: JSON.parse(data.actions).reduce(function (o, e) {
              o[e.key] = { success: true, from: e.action, params: e.params }; return o;
            }, {}) }
        : { success: true, from: action });
  }
  // handleAuthFailure is passed through unchanged: this file is about
  // coalescing, not about sessions. What it does with a refusal is
  // covered in a-locked-folder-is-not-an-empty-one.test.js.
  return new Function("apiDirect", "handleAuthFailure", code)(apiDirect, r => r);
}

function run(name, fn) {
  var m = build();
  return fn(m).catch(function (e) { fail++; console.log("  FAIL  " + name + " — " + e.message); });
}

var chain = Promise.resolve();

chain = chain.then(function () { return run("twelve reads", function (m) {
  var want = ["getA","getB","getC","getD","getE","getF",
              "getG","getH","getI","getJ","getK","getL"];
  return Promise.all(want.map(function (a) { return m.api(a); })).then(function (res) {
    ok("twelve reads in one tick make one request", calls.length === 1);
    ok("and that request is the batch", calls[0].action === "batch");
    ok("carrying all twelve actions", JSON.parse(calls[0].data.actions).length === 12);
    ok("every caller gets its own answer back",
       res.every(function (r, i) { return r.from === want[i]; }));
  });
}); });

chain = chain.then(function () { return run("writes", function (m) {
  return Promise.all([m.api("getList"), m.api("saveThing"), m.api("getOther")])
    .then(function () {
      var direct = calls.filter(function (c) { return c.action === "saveThing"; });
      ok("a write goes on its own, immediately", direct.length === 1);
      ok("and does not join the batch",
         calls.filter(function (c) { return c.action === "batch"; }).length === 1);
    });
}); });

// The change that mattered. A read naming a patient or a date used to go on
// its own, and those are most of what a clinic screen asks for.
chain = chain.then(function () { return run("params", function (m) {
  return Promise.all([
    m.api("getPatient", { uhid: "AL1001" }),
    m.api("getClinicalSheets", { uhid: "AL1001" }),
    m.api("getAppointments", { date: "06/10/2026" }),
  ]).then(function (res) {
    ok("three reads naming a patient or a date make ONE request", calls.length === 1, calls.length);
    var sent = JSON.parse(calls[0].data.actions);
    ok("and each carries its own parameters",
       sent[0].params.uhid === "AL1001" && sent[2].params.date === "06/10/2026",
       JSON.stringify(sent.map(function (e) { return e.params; })));
    ok("every caller gets the answer it asked for",
       res.map(function (r) { return r.from; }).join(",") ===
       "getPatient,getClinicalSheets,getAppointments",
       JSON.stringify(res.map(function (r) { return r.from; })));
  });
}); });

// Two patients are not the same read, however alike the action looks.
chain = chain.then(function () { return run("per-patient", function (m) {
  return Promise.all([
    m.api("getPatient", { uhid: "AL1001" }),
    m.api("getPatient", { uhid: "AL2002" }),
    m.api("getPatient", { uhid: "AL1001" }),
  ]).then(function (res) {
    var sent = JSON.parse(calls[0].data.actions);
    ok("the same patient asked for twice is sent once", sent.length === 2, String(sent.length));
    ok("but a different patient is a different read",
       sent.map(function (e) { return e.params.uhid; }).sort().join(",") === "AL1001,AL2002");
    ok("and each caller gets its own patient back",
       res[0].params.uhid === "AL1001" && res[1].params.uhid === "AL2002",
       JSON.stringify(res.map(function (r) { return r.params; })));
  });
}); });

chain = chain.then(function () { return run("dedupe", function (m) {
  return Promise.all([m.api("getDoctorDetailsList"), m.api("getDoctorDetailsList")])
    .then(function (res) {
      ok("the same list asked for twice is sent once",
         JSON.parse(calls[0].data.actions).length === 1);
      ok("and both callers are answered", res[0].from === "getDoctorDetailsList" &&
                                          res[1].from === "getDoctorDetailsList");
    });
}); });

chain = chain.then(function () { return run("chunking", function (m) {
  var want = [];
  for (var i = 0; i < 30; i++) want.push("get" + i);
  return Promise.all(want.map(function (a) { return m.api(a); })).then(function (res) {
    ok("thirty reads split into two batches, none dropped", calls.length === 2);
    ok("the first holds the cap", JSON.parse(calls[0].data.actions).length === 25);
    ok("the second holds the rest", JSON.parse(calls[1].data.actions).length === 5);
    ok("and all thirty callers are answered", res.length === 30 &&
       res.every(function (r) { return r.success; }));
  });
}); });

// Separate ticks must not share a batch — a list asked for later still goes.
chain = chain.then(function () { return run("later tick", function (m) {
  return m.api("getA").then(function () {
    return m.api("getB").then(function (r) {
      ok("a read in a later tick is sent, not swallowed", calls.length === 2);
      ok("and answered", r.from === "getB");
    });
  });
}); });

// Between merging this and deploying Code.gs, the browser sends the new entry
// format to a backend that expects bare action names. That backend answers
// "batch: reads only" for every entry, with success:true on the batch — so
// trusting it would put an error on every panel until the deploy caught up.
chain = chain.then(function () {
  var calls2 = [];
  function apiDirect2(action, data) {
    calls2.push(action);
    return Promise.resolve(action === "batch"
      ? { success: true, results: JSON.parse(data.actions).reduce(function (o, e) {
            o[e.key] = { success: false, error: "batch: reads only" }; return o;
          }, {}) }
      : { success: true, from: action });
  }
  var m = new Function("apiDirect", "handleAuthFailure", code)(apiDirect2, r => r);
  return Promise.all([m.api("getPatient", { uhid: "AL1001" }), m.api("getCarePlan", { uhid: "AL1001" })])
    .then(function (res) {
      ok("an out-of-date backend does not leave the clinic with errors",
         res.every(function (r) { return r.success; }), JSON.stringify(res));
      ok("each unserved read is retried on its own",
         calls2.filter(function (c) { return c !== "batch"; }).sort().join(",") ===
         "getCarePlan,getPatient", calls2.join(","));
    });
});

chain.then(function () {
  console.log("==============================================================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  console.log("==============================================================================");
  process.exit(fail ? 1 : 0);
});
