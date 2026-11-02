// The server the app talks to.
//
// It speaks exactly what Apps Script spoke: a GET with the action in the
// query string, or a POST with it in a JSON body, answering
// {success: true, …} either way. That is deliberate. The browser needs no
// change at all beyond the one line that says where to send requests —
// KB_INSTANCE.scriptUrl — which was already configuration.
//
// Node's own http module, and one dependency (pg). This has to be installed
// on a clinic PC and kept running by people who are not programmers; every
// package added is something that can need updating on a Tuesday morning.
const http = require("http");
const { URL } = require("url");
const { actions, missingActions } = require("./registry");
const auth = require("./auth");
const db = require("./db");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
// The app is served from GitHub Pages today and from the clinic PC later;
// both have to be allowed to call this.
const ALLOWED_ORIGINS = (process.env.KB_ALLOWED_ORIGINS ||
  "https://kbdental.github.io,http://localhost:8000").split(",").map((s) => s.trim());

const BATCH_MAX = 25;
const MAX_BODY = 32 * 1024 * 1024;   // an X-ray arrives as base64
// Only behind a reverse proxy that sets it. On a clinic LAN there is none,
// and believing the header would let anyone defeat the login rate limit by
// sending a different one each try.
const TRUST_FORWARDED_FOR = process.env.KB_TRUST_FORWARDED_FOR === "true";

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // X-KB-Token has to be named here or a cross-origin request carrying it
    // is refused at the preflight, before it ever reaches an action. Not
    // Allow-Credentials: the session cookie is SameSite=Strict and so is not
    // sent cross-site by design — the header is the cross-origin path, the
    // cookie is the same-origin one.
    "Access-Control-Allow-Headers": "Content-Type, X-KB-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function send(res, status, body, origin) {
  // setCookie and clearCookie are instructions to this layer, not part of the
  // answer. They are acted on and removed, so the token never appears in a
  // reply body the page could read back out.
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(origin)
  };
  if (body && typeof body === "object") {
    const base = "kb_session=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d";
    if (body.setCookie) {
      headers["Set-Cookie"] =
        base.replace("%s", encodeURIComponent(body.setCookie))
            .replace("%d", String(Math.floor(auth.SESSION_TTL_MS / 1000)));
      body = { ...body }; delete body.setCookie;
    } else if (body.clearCookie) {
      headers["Set-Cookie"] = base.replace("%s", "").replace("%d", "0");
      body = { ...body }; delete body.clearCookie;
    }
  }
  const text = JSON.stringify(body);
  headers["Content-Length"] = Buffer.byteLength(text);
  res.writeHead(status, headers);
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("That file is too large to upload")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// One action. Auth is checked here, so a batched read is checked exactly as
// it would be on its own.
async function route(p) {
  const action = String(p.action || "").trim();
  if (!action) return { success: false, error: "No action given" };

  // Patient documents are ALWAYS behind a session, whatever the rollout
  // flag says.
  if (auth.DOCUMENT_ACTIONS.has(action) && !(await auth.isValidSession(p.token))) {
    return { success: false, error: "AUTH_REQUIRED", authRequired: true };
  }
  if (await auth.authRequired()) {
    if (!auth.PUBLIC_ACTIONS.has(action) && !(await auth.isValidSession(p.token))) {
      return { success: false, error: "AUTH_REQUIRED", authRequired: true };
    }
  }

  if (action === "batch") return batch(p);

  const fn = actions[action];
  if (typeof fn !== "function") return { success: false, error: `Unknown action: ${action}` };

  try {
    return await fn(p);
  } catch (e) {
    // A message written for the desk goes through; anything else is logged
    // in full here and reported plainly there. A constraint violation is
    // not something a receptionist can act on.
    console.error(`[${action}]`, e);
    if (e.clientSafe) return { success: false, error: e.message };
    if (e.code === "23505") return { success: false, error: "That record already exists" };
    if (e.code === "23503") return { success: false, error: "That refers to something that does not exist" };
    if (e.code === "23514") return { success: false, error: "That would leave the record in a state the clinic does not allow" };
    return { success: false, error: "Something went wrong saving that. It has been logged." };
  }
}

// Several reads in one round trip. The Master page asks for eighteen lists;
// as eighteen requests they queued.
async function batch(p) {
  let entries = [];
  try { entries = JSON.parse(p.actions || "[]"); } catch (_) { entries = []; }
  if (!Array.isArray(entries) || !entries.length) {
    return { success: false, error: "batch: no actions given" };
  }
  if (entries.length > BATCH_MAX) {
    return { success: false, error: `batch: at most ${BATCH_MAX} actions, got ${entries.length}` };
  }

  const out = {};
  const jobs = entries.map(async (entry) => {
    const isObj = entry && typeof entry === "object";
    const name = String((isObj ? entry.action : entry) || "").trim();
    const key = String((isObj && entry.key) || name || "?");

    if (!name || name === "batch") { out[key] = { success: false, error: "batch: not allowed" }; return; }
    // Reads only. A half-applied batch of writes is a worse problem than a
    // slow page, and nothing this is for needs to write.
    if (!name.startsWith("get")) { out[key] = { success: false, error: "batch: reads only" }; return; }

    // action and token are the batch's own, never the entry's: letting an
    // entry set them would let one read carry a different session than the
    // request was authorised with.
    const payload = { action: name, token: p.token };
    if (isObj && entry.params && typeof entry.params === "object") {
      for (const [k, v] of Object.entries(entry.params)) {
        if (k !== "action" && k !== "token") payload[k] = v;
      }
    }
    try {
      out[key] = await route(payload);
    } catch (e) {
      out[key] = { success: false, error: String((e && e.message) || e) };
    }
  });

  // They run together. Eighteen reads of eighteen indexes is not eighteen
  // waits — this is most of why the Master page will open at once.
  await Promise.all(jobs);
  return { success: true, results: out };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // A plain health check for whoever is keeping the service running.
    if (url.pathname === "/health") {
      await db.query("SELECT 1");
      send(res, 200, { success: true, status: "ok" }, origin);
      return;
    }

    let params = {};
    if (req.method === "GET") {
      for (const [k, v] of url.searchParams) params[k] = v;
    } else if (req.method === "POST") {
      const raw = await readBody(req);
      try { params = JSON.parse(raw || "{}"); } catch (_) { params = {}; }
      // A POST may still carry its action in the query string, as the app's
      // own apiPost fallback does.
      for (const [k, v] of url.searchParams) if (params[k] === undefined) params[k] = v;
    } else {
      send(res, 405, { success: false, error: "Use GET or POST" }, origin);
      return;
    }

    // Where the token came from is this layer's business; everything past
    // here reads params.token and does not care. The app sends a header, so
    // the token stops appearing in URLs and therefore in access logs and
    // browser history; a query-string token still works, because the rollback
    // to Apps Script has to.
    params.token = auth.tokenFrom(params, req.headers);
    // Who is trying, for the login rate limit. A proxy's forwarded address is
    // trusted only when one is configured, since a header anybody can set is
    // no identity at all.
    params._from = (TRUST_FORWARDED_FOR && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim())
      || (req.socket && req.socket.remoteAddress) || "unknown";

    send(res, 200, await route(params), origin);
  } catch (e) {
    console.error("[http]", e);
    // 200 with success:false, like Apps Script: the app reads the body, and
    // a status code it has never seen would show as a network error.
    send(res, 200, { success: false, error: e.message || "Request failed" }, origin);
  }
});

async function start() {
  // Say out loud, at startup, which of the app's actions are not
  // implemented. Finding that out at the desk is not acceptable.
  const missing = missingActions();
  if (missing.length) {
    console.warn(`[startup] ${missing.length} action(s) the app calls are NOT implemented:`);
    for (const m of missing) console.warn(`           ${m}`);
  } else {
    console.log("[startup] every action the app calls is implemented");
  }

  try {
    const v = await db.query("SELECT current_database() AS db, version() AS v");
    console.log(`[startup] connected to ${v.rows[0].db}`);
  } catch (e) {
    console.error(`[startup] cannot reach PostgreSQL: ${e.message}`);
    process.exit(1);
  }

  server.listen(PORT, HOST, () => console.log(`[startup] listening on ${HOST}:${PORT}`));
}

// A clinic PC gets shut down at the end of the day. Finish what is in
// flight, then let go of the pool.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[shutdown] ${sig}`);
    server.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

if (require.main === module) start();

module.exports = { server, route, batch, start };
