// The CRM drained the queue only when it LOADED, so a screen left open all
// day never saw the patients registered while it sat there. The desk is not
// going to reload the CRM to find out, so it asks.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "\n          " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     "got " + JSON.stringify(got) + ", want " + JSON.stringify(want));

const a = html.indexOf("const CRM_B64 =");
const CRM = Buffer.from((html.slice(a, html.indexOf(";\n", a)).match(/"([^"]*)"/g) || [])
  .map(s => s.slice(1, -1)).join(""), "base64").toString("utf8");
const CODE = CRM.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
                .replace(/^\s*\/\/.*$/gm, "");

// ── the watcher, pulled out and run on a fake clock ──────────────────────
const WATCH = CODE.slice(CODE.indexOf("var drainRef = useRef(null);"),
                         CODE.indexOf("function drainLeadInbox("));

function runWatcher(opts) {
  const o = opts || {};
  let timer = null, listener = null;
  const asked = [];
  const drained = [];
  const doc = { visibilityState: o.hidden ? "hidden" : "visible",
                addEventListener: (t, f) => { if (t === "visibilitychange") listener = f; },
                removeEventListener: () => { listener = null; } };
  let effect = null, cleanup = null;
  const env = {
    useRef: () => ({ current: null }),
    useEffect: (fn) => { effect = fn; },
    document: doc,
    setInterval: (fn, ms) => { timer = { fn, ms }; return 1; },
    clearInterval: () => { timer = null; },
    crmInbox: () => {
      asked.push(1);
      return o.reject ? Promise.reject(new Error("no")) 
                      : Promise.resolve(o.reply !== undefined ? o.reply : { ok: true, leadInbox: o.waiting || [] });
    },
    // The real drain, replaced by a recorder; what matters here is WHEN and
    // with WHAT it is called.
    drainLeadInbox: (inbox, loaded) => { drained.push({ inbox, loaded }); }
  };
  const keys = Object.keys(env);
  new Function(...keys, WATCH)(...keys.map(k => env[k]));
  cleanup = effect();
  return { tick: () => timer && timer.fn(), timer: () => timer, asked, drained,
           show: (v) => { doc.visibilityState = v; if (listener) listener(); },
           cleanup };
}

// ── it looks, on a timer ─────────────────────────────────────────────────
let w = runWatcher({ waiting: [{ id: "li1", uhid: "KB1", name: "A B" }] });
eq("nothing is asked until the timer fires", w.asked.length, 0);
ok("it checks about once a minute", w.timer().ms === 60000, w.timer() && w.timer().ms);
w.tick();
eq("a tick asks the clinic book what is waiting", w.asked.length, 1);

(async () => {
  await new Promise(r => setImmediate(r));
  eq("and a patient who walked in since is drained", (w.drained[0] || {}).inbox.length, 1);
  ok("against the CRM's live state, not a snapshot handed to it",
     w.drained[0].loaded === null, JSON.stringify(w.drained[0].loaded));

  // ── nothing waiting, nothing done ──────────────────────────────────────
  w = runWatcher({ waiting: [] });
  w.tick();
  await new Promise(r => setImmediate(r));
  eq("an empty queue drains nothing", w.drained.length, 0);

  // ── it is quiet when nobody is looking ────────────────────────────────
  w = runWatcher({ hidden: true, waiting: [{ id: "li1" }] });
  w.tick();
  eq("a hidden tab asks the clinic book for nothing", w.asked.length, 0);
  w.show("visible");
  eq("coming back to the tab checks at once, without waiting out the minute",
     w.asked.length, 1);
  await new Promise(r => setImmediate(r));
  eq("and drains what was waiting", w.drained.length, 1);

  w = runWatcher({ waiting: [{ id: "li1" }] });
  w.show("hidden");
  eq("going away does not trigger a check", w.asked.length, 0);

  // ── two checks never overlap ──────────────────────────────────────────
  let release;
  w = runWatcher({ reply: new Promise(r => { release = r; }) });
  w.tick(); w.tick(); w.tick();
  eq("a slow answer does not stack up three more requests behind it", w.asked.length, 1);
  release({ ok: true, leadInbox: [] });
  await new Promise(r => setImmediate(r));
  w.tick();
  eq("and once it answers, checking resumes", w.asked.length, 2);

  // ── failure is survivable ─────────────────────────────────────────────
  w = runWatcher({ reject: true });
  w.tick();
  await new Promise(r => setImmediate(r));
  eq("a failed check drains nothing", w.drained.length, 0);
  w.tick();
  eq("and does not wedge the watcher for good", w.asked.length, 2);

  w = runWatcher({ reply: { ok: false, error: "AUTH_REQUIRED" } });
  w.tick();
  await new Promise(r => setImmediate(r));
  eq("a refused read is not treated as an empty queue", w.drained.length, 0);

  // ── it stops when the screen does ─────────────────────────────────────
  w = runWatcher({ waiting: [{ id: "li1" }] });
  w.cleanup();
  ok("closing the CRM stops the timer", w.timer() === null);
  w.show("visible");
  eq("and a closed screen does not keep checking", w.asked.length, 0);

  // ── the stale-closure trap ────────────────────────────────────────────
  // The interval is set up once. A drain captured on the first render would
  // go on reading that render's leads for the rest of the day and open a
  // second lead for everyone it had already dealt with.
  ok("the drain is reached through a ref, not captured by the interval",
     /drainRef\.current\(/.test(CODE) && /drainRef\.current = drainLeadInbox/.test(CODE));
  ok("and the ref is refreshed every render, outside the effect",
     CODE.indexOf("drainRef.current = drainLeadInbox") < CODE.indexOf("useEffect(function(){\n    var alive = true, busy = false;"));
  ok("the watcher is set up once, not on every change",
     /\}, \[\]\);/.test(CODE.slice(CODE.indexOf("var drainRef = useRef(null);"),
                                  CODE.indexOf("function drainLeadInbox("))));

  // ── it asks for the queue alone ───────────────────────────────────────
  ok("the check reads the waiting list only, not all nine collections",
     /function crmInbox\(\)\{ return crmAsk\(\{type:'KB_CRM_INBOX'\}/.test(CODE));
  ok("the host passes that through", /d\.type === "KB_CRM_INBOX"/.test(html));
  ok("to an action of its own", /api\("getCrmLeadInbox"\)/.test(html));

  console.log("==============================================================================");
  console.log("  " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
