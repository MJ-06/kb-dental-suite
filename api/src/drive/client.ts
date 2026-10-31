// A small Google Drive client over the REST API (no SDK), shared by anything
// that talks to Drive: clinic attachment storage and the daily backup.
//
// Two ways to sign in, so the choice between them stays open:
//   service_account  a key file for a robot account. Its files count against
//                    the robot's own quota, so it needs a Shared Drive (or a
//                    folder in one); it cannot fill a personal "My Drive".
//   oauth            a person's one-time consent, kept as a refresh token. Files
//                    land in that person's Drive and use their storage.
// The caller hands over the credential; this module never stores it.
//
// Only the scope "drive" is used: the clinic's existing folder was created by
// a person, and the narrower "drive.file" scope cannot see files the app did
// not make itself.
import { createSign, randomBytes } from "node:crypto";

export type DriveCredential =
  | { type: "service_account"; client_email: string; private_key: string }
  | { type: "oauth"; client_id: string; client_secret: string; refresh_token: string };

export class DriveError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

/** Overridable by the operator (and by tests); never by a clinic. */
const apiBase = () => process.env.DRIVE_API_BASE ?? "https://www.googleapis.com";
const tokenUrl = () => process.env.DRIVE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
/** Drive query strings quote with a single quote and escape with a backslash. */
const q = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function parseCredential(raw: unknown): DriveCredential {
  const c = raw as Record<string, unknown> | null;
  const s = (k: string) => (typeof c?.[k] === "string" ? (c[k] as string).trim() : "");
  if (c?.type === "service_account" && s("client_email") && s("private_key")) {
    return { type: "service_account", client_email: s("client_email"), private_key: s("private_key") };
  }
  if (c?.type === "oauth" && s("client_id") && s("client_secret") && s("refresh_token")) {
    return { type: "oauth", client_id: s("client_id"), client_secret: s("client_secret"), refresh_token: s("refresh_token") };
  }
  throw new DriveError("The Google Drive sign-in details are incomplete");
}

export class DriveClient {
  private token: { value: string; expires: number } | null = null;
  constructor(private cred: DriveCredential) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams();
    if (this.cred.type === "oauth") {
      body.set("grant_type", "refresh_token");
      body.set("client_id", this.cred.client_id);
      body.set("client_secret", this.cred.client_secret);
      body.set("refresh_token", this.cred.refresh_token);
    } else {
      const now = Math.floor(Date.now() / 1000);
      const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const claims = b64url(JSON.stringify({ iss: this.cred.client_email, scope: SCOPE, aud: tokenUrl(), iat: now, exp: now + 3600 }));
      const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(this.cred.private_key);
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
      body.set("assertion", `${head}.${claims}.${b64url(sig)}`);
    }
    const res = await fetch(tokenUrl(), { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !json.access_token) {
      throw new DriveError(`Google refused the sign-in (${json.error_description ?? json.error ?? res.status})`, res.status);
    }
    this.token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  /** One request, retried a few times when Google is busy. */
  private async call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    let last: DriveError | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(apiBase() + path, { ...init, headers: { ...init.headers, authorization: `Bearer ${await this.accessToken()}` } });
      if (res.ok) return res;
      const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      last = new DriveError(`Google Drive: ${j.error?.message ?? res.statusText} (${res.status})`, res.status);
      if (res.status === 401) this.token = null;
      if (res.status !== 429 && res.status < 500 && res.status !== 401) break;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
    throw last!;
  }

  /** Cheap check that the sign-in works and Drive answers. */
  async ping(): Promise<void> {
    await this.call("/drive/v3/files?pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true");
  }

  async findFolder(name: string, parentId?: string): Promise<string | null> {
    const parent = parentId ? ` and ${q(parentId)} in parents` : "";
    const query = `mimeType = '${FOLDER_MIME}' and name = ${q(name)} and trashed = false${parent}`;
    const res = await this.call(`/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=2&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    const files = ((await res.json()) as { files?: { id: string }[] }).files ?? [];
    return files[0]?.id ?? null;
  }

  async ensureFolder(name: string, parentId?: string): Promise<string> {
    const found = await this.findFolder(name, parentId);
    if (found) return found;
    const res = await this.call("/drive/v3/files?fields=id&supportsAllDrives=true", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) })
    });
    return ((await res.json()) as { id: string }).id;
  }

  async upload(p: { name: string; parentId: string; mime: string; bytes: Buffer }): Promise<string> {
    const boundary = "kb" + randomBytes(12).toString("hex");
    const meta = JSON.stringify({ name: p.name, parents: [p.parentId] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${p.mime}\r\n\r\n`),
      p.bytes,
      Buffer.from(`\r\n--${boundary}--`)
    ]);
    const res = await this.call("/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true", {
      method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body
    });
    return ((await res.json()) as { id: string }).id;
  }

  async download(fileId: string): Promise<Buffer> {
    const res = await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Moves a file to Drive's bin (recoverable for 30 days); never a permanent delete. */
  async trash(fileId: string): Promise<void> {
    await this.call(`/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashed: true })
    });
  }
}
