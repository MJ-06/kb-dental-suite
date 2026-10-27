// Small shared conversions.
//
// The browser sends everything as strings — it always did, because Apps
// Script had no types. Postgres does have types, so every value crosses a
// line here exactly once.

// "" and undefined both mean "not given". Postgres wants NULL for that;
// writing "" into a DATE column is an error, not an empty date.
function nz(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  // Amounts arrive as "₹1,500" or "1500.00" depending on which screen typed
  // them. Strip anything that is not part of a number.
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "done"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return null;
}

// Always yyyy-mm-dd, never a Date. The sheets handed back
// "1899-12-30T05:35:50.000Z" for a time cell and the clinic saw it on screen;
// nothing leaves here as a Date object.
function dateISO(v) {
  if (!v) return "";
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : dateISO(d);
}

// "HH:MM", or "" — never a Date, never seconds.
function timeHM(v) {
  if (!v) return "";
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(v.getHours())}:${p(v.getMinutes())}`;
  }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${String(m[1]).padStart(2, "0")}:${m[2]}` : "";
}

// A time for Postgres: "" must become NULL, not '00:00'.
function timeOrNull(v) {
  const t = timeHM(v);
  return t || null;
}

// A list that arrived either as a real array or as JSON in a query string.
// A payload that was cut off in transit must not read as "the list is now
// empty" — that is how a master list gets wiped by a dropped connection, so
// a string that will not parse is an error, never [].
function parseList(v, what) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null || String(v).trim() === "") {
    const e = new Error(`the ${what} never reached the server`);
    e.clientSafe = true;
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(String(v)); } catch (_) { parsed = undefined; }
  if (!Array.isArray(parsed)) {
    const e = new Error(`the ${what} arrived damaged and was not saved`);
    e.clientSafe = true;
    throw e;
  }
  return parsed;
}

function parseObject(v, what) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  if (v === undefined || v === null || String(v).trim() === "") {
    const e = new Error(`the ${what} never reached the server`);
    e.clientSafe = true;
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(String(v)); } catch (_) { parsed = undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const e = new Error(`the ${what} arrived damaged and was not saved`);
    e.clientSafe = true;
    throw e;
  }
  return parsed;
}

// A text array for a TEXT[] column, from an array or from "a, b, c".
function textArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v == null ? "" : v).trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const a = JSON.parse(s);
      if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean);
    } catch (_) { /* fall through to the comma split */ }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function uhidOf(v) {
  return String(v || "").trim().toUpperCase();
}

// Two letters for the year (AA = 2015), then the month, then that month's
// running number. AL0777 is the 77th new patient of July 2026.
function uhidYearCode(year) {
  const i = Math.max(0, year - 2015);
  return String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
}

function uhidPrefix(now) {
  const d = now || new Date();
  return uhidYearCode(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, "0");
}

// Age in whole years, the way a receptionist would say it.
function ageFrom(dob) {
  if (!dob) return "";
  const d = dob instanceof Date ? dob : new Date(dob);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? String(age) : "";
}

// Walk-in to consultation, as "1h 05m" — the register's TAT column.
function tatBetween(walkIn, consult) {
  const a = timeHM(walkIn), b = timeHM(consult);
  if (!a || !b) return "";
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let d = mins(b) - mins(a);
  if (d < 0) d += 24 * 60;            // consultation after midnight
  const h = Math.floor(d / 60), m = d % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

module.exports = {
  nz, num, bool, dateISO, timeHM, timeOrNull,
  parseList, parseObject, textArray,
  uhidOf, uhidYearCode, uhidPrefix, ageFrom, tatBetween
};
