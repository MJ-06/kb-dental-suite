// Conversions between what the screens send (everything a string, lists as
// JSON in a query string) and what Postgres stores. Mirrors the Apps Script
// helpers of the same purpose so behaviour at the desk does not change.
import { DeskError } from "./types.js";

/** Trimmed text, "" for null/undefined. */
export function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

/** Trimmed text, or null when empty: "" must not land in a DATE column. */
export function nz(v: unknown): string | null {
  const s = str(v);
  return s === "" ? null : s;
}

/** "₹1,500" and "1500.00" alike; null when there is no number. */
export function num(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * A list sent as an array or as JSON text. A missing or damaged payload is
 * refused, never read as "empty the list": that is how a dropped connection
 * used to wipe a master list. An empty list is allowed.
 */
export function parseList(raw: unknown, label: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || raw === "") throw new DeskError(`the ${label} never reached the server`);
  let arr: unknown;
  try { arr = JSON.parse(String(raw)); } catch {
    throw new DeskError(`the ${label} arrived damaged — ${String(raw).length} characters, cut short in transit`);
  }
  if (!Array.isArray(arr)) throw new DeskError(`the ${label} was not a list`);
  return arr;
}

export function parseObject(raw: unknown, label: string): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (raw === undefined || raw === null || raw === "") throw new DeskError(`the ${label} never reached the server`);
  let o: unknown;
  try { o = JSON.parse(String(raw)); } catch { o = null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new DeskError(`the ${label} arrived damaged and was not saved`);
  return o as Record<string, unknown>;
}

/** "HH:MM" or "" (the sheets' hhmm_). */
export function hhmm(v: unknown): string {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(str(v));
  if (!m) return "";
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** "yyyy-mm-dd" or "". */
export function isoDay(v: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

export function uhidOf(v: unknown): string {
  return str(v).toUpperCase();
}
