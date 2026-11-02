// Staff sign-in, and the three screen passwords.
//
// The contract the browser already speaks is unchanged: staffLogin returns a
// token, every later call carries it. What changes is where it is kept — a
// table, not a script property — and that passwords are stored hashed, so
// reading the database does not hand somebody the master password.
const crypto = require("crypto");
const { query } = require("./db");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours, as before

// Documents are ALWAYS behind a session, whatever the rollout flag says.
// These files are reachable no other way, so leaving them open would move
// the exposure rather than remove it.
const DOCUMENT_ACTIONS = new Set([
  "uploadPatientDocument", "getPatientDocuments", "deletePatientDocument",
  "getPatientDocumentContent", "createDocumentPDF"
]);

// Login itself, and the patient-facing chatbot — those users have no account
// by design.
const PUBLIC_ACTIONS = new Set([
  "staffLogin", "staffLogout", "authStatus", "ping",
  "chatbotReply", "saveChatbotAppointment", "findAppointmentsByPhone",
  "patientLookup", "patientCompleteRegistration"
]);

function hashPassword(plain, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(plain), s, 32).toString("hex");
  return `scrypt$${s}$${h}`;
}

function passwordMatches(plain, stored) {
  if (!stored) return false;
  const parts = String(stored).split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const want = Buffer.from(parts[2], "hex");
  const got = crypto.scryptSync(String(plain), parts[1], want.length);
  // Constant time: a password check must not leak how much of it was right.
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

async function setting(key) {
  const r = await query("SELECT value FROM clinic_settings WHERE key = $1", [key]);
  return r.rowCount ? r.rows[0].value : null;
}

async function putSetting(key, value) {
  await query(
    `INSERT INTO clinic_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

async function authRequired() {
  return (await setting("require_auth")) === true;
}

async function isValidSession(token) {
  if (!token) return false;
  const r = await query(
    "SELECT 1 FROM sessions WHERE token = $1 AND expires_at > now()",
    [String(token)]
  );
  return r.rowCount > 0;
}

// How many wrong passwords from one place before it has to wait, and how
// long. Anyone on the clinic's WiFi could otherwise try passwords as fast as
// the server answers them, which for a six-character password is minutes.
//
// Kept in memory on purpose: a restart clearing it is the right trade. The
// alternative is a write to disk on every failed attempt, which is itself a
// way to make the server unwell from outside.
const LOGIN_MAX_TRIES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();   // key -> {count, first, until}

function loginBlockedFor(key) {
  const a = loginAttempts.get(key);
  if (!a || !a.until) return 0;
  const left = a.until - Date.now();
  if (left <= 0) { loginAttempts.delete(key); return 0; }
  return left;
}

function noteLoginFailure(key) {
  const now = Date.now();
  const a = loginAttempts.get(key);
  if (!a || now - a.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now, until: 0 });
    return;
  }
  a.count++;
  // Each failure past the limit doubles the wait, up to an hour. A person who
  // has mistyped their password notices after one minute; a script trying a
  // list does not get through the list.
  if (a.count >= LOGIN_MAX_TRIES) {
    const over = a.count - LOGIN_MAX_TRIES;
    a.until = now + Math.min(60 * 60 * 1000, 60 * 1000 * Math.pow(2, over));
  }
}

async function staffLogin(p) {
  const from = String(p._from || "unknown");
  const waitMs = loginBlockedFor(from);
  if (waitMs > 0) {
    const mins = Math.ceil(waitMs / 60000);
    return {
      success: false,
      error: `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`
    };
  }

  const given = String(p.password || "");
  if (!given) { noteLoginFailure(from); return { success: false, error: "Incorrect password" }; }

  // A named account first, so the audit log can say who did something.
  const users = await query(
    "SELECT username, password_hash FROM app_users WHERE active",
    []
  );
  let username = null;
  for (const u of users.rows) {
    if (passwordMatches(given, u.password_hash)) { username = u.username; break; }
  }

  if (!username) {
    const shared = await setting("app_password");
    if (!shared) return { success: false, error: "No app password is set yet" };
    if (!passwordMatches(given, shared)) {
      noteLoginFailure(from);
      return { success: false, error: "Incorrect password" };
    }
    username = "staff";
  }

  loginAttempts.delete(from);

  // Expired tokens go now rather than on a schedule — there is no cron on a
  // clinic PC, and this is the one moment the table is certainly being used.
  await query("DELETE FROM sessions WHERE expires_at <= now()");

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await query(
    "INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, to_timestamp($3))",
    [token, username, expiresAt / 1000]
  );
  // setCookie is the server's to act on, not the browser's to read: it is
  // stripped from the reply before it is sent. The cookie is HttpOnly, so a
  // script injected into the page cannot read the token out of it — which is
  // the one thing sessionStorage cannot promise. The app still keeps its own
  // copy for now and sends it as a header; when it stops, this is already here.
  return { success: true, token, expiresAt, username, setCookie: token };
}

async function staffLogout(p) {
  const token = String(p.token || "");
  if (token) await query("DELETE FROM sessions WHERE token = $1", [token]);
  return { success: true, clearCookie: true };
}

// Where the token is, in the order it should be trusted.
//
// A header first: that is where the app puts it, and a header is not written
// into an access log or a browser's history. Then the cookie, for a page that
// has stopped holding one itself. The query string and the body come last,
// because Apps Script could use nothing else and the rollback has to work.
function tokenFrom(params, headers) {
  const h = (headers && (headers["x-kb-token"] || headers["X-KB-Token"])) || "";
  if (h) return String(h).trim();

  const raw = (headers && headers.cookie) || "";
  for (const part of String(raw).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "kb_session") {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }

  return String((params && params.token) || "").trim();
}

async function usernameFor(token) {
  if (!token) return "";
  const r = await query(
    "SELECT username FROM sessions WHERE token = $1 AND expires_at > now()",
    [String(token)]
  );
  return r.rowCount ? r.rows[0].username : "";
}

// The Finance / Master / Reports screens each sit behind their own password.
// Nothing set means nothing to unlock — the same rule as before, so turning
// the server on cannot lock the clinic out of its own screens.
function screenPassword(settingKey) {
  return {
    async save(p) {
      const plain = String(p.password || "");
      await putSetting(settingKey, plain ? hashPassword(plain) : null);
      return { success: true };
    },
    async verify(p) {
      const stored = await setting(settingKey);
      if (!stored) return { success: true, correct: true };
      return { success: true, correct: passwordMatches(String(p.password || ""), stored) };
    }
  };
}

module.exports = {
  SESSION_TTL_MS, DOCUMENT_ACTIONS, PUBLIC_ACTIONS,
  hashPassword, passwordMatches, setting, putSetting,
  authRequired, isValidSession, staffLogin, staffLogout, usernameFor,
  screenPassword, tokenFrom,
  LOGIN_MAX_TRIES, loginAttempts
};
