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

async function staffLogin(p) {
  const given = String(p.password || "");
  if (!given) return { success: false, error: "Incorrect password" };

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
    if (!passwordMatches(given, shared)) return { success: false, error: "Incorrect password" };
    username = "staff";
  }

  // Expired tokens go now rather than on a schedule — there is no cron on a
  // clinic PC, and this is the one moment the table is certainly being used.
  await query("DELETE FROM sessions WHERE expires_at <= now()");

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await query(
    "INSERT INTO sessions (token, username, expires_at) VALUES ($1, $2, to_timestamp($3))",
    [token, username, expiresAt / 1000]
  );
  return { success: true, token, expiresAt };
}

async function staffLogout(p) {
  if (p.token) await query("DELETE FROM sessions WHERE token = $1", [String(p.token)]);
  return { success: true };
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
  screenPassword
};
