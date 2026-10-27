import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "kb_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only this goes in the database. */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
