// Seals a small secret (a bucket's access key, a Drive credential) before it is
// stored in the database, so a database backup alone does not give access to a
// clinic's storage. AES-256-GCM; the key is KB_SECRETS_KEY (32 random bytes,
// base64) in api/.env, never in git. Lose the key and the stored credentials
// must be entered again; the documents themselves are not affected.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.KB_SECRETS_KEY;
  const k = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (k.length !== 32) {
    throw new Error("KB_SECRETS_KEY is not set (32 random bytes, base64). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
  }
  return k;
}

export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return [VERSION, iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function open<T = unknown>(sealed: string): T {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== VERSION || !iv || !tag || !body) throw new Error("stored credentials are unreadable");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  try {
    return JSON.parse(Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8")) as T;
  } catch {
    throw new Error("stored credentials could not be opened (was KB_SECRETS_KEY changed?)");
  }
}
