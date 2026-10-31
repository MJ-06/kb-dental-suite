// Per-clinic attachment storage: server folder, S3-compatible bucket and Google
// Drive, against fake S3 and Drive servers on loopback (no network, no account).
import { createHash, createHmac, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTenant } from "../src/db/index.js";
import { open, seal } from "../src/secrets.js";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, type World } from "./setup.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

const body = (req: IncomingMessage) => new Promise<Buffer>((res) => {
  const c: Buffer[] = [];
  req.on("data", (d) => c.push(d)).on("end", () => res(Buffer.concat(c)));
});

// ── a fake S3 that checks the request signature with its own copy of the algorithm ──
const S3_KEY = { accessKeyId: "AKIATESTTESTTEST", secretAccessKey: "s3cr3t-s3cr3t-s3cr3t" };
const s3Objects = new Map<string, Buffer>();
let s3BadSignatures = 0;

async function fakeS3(req: IncomingMessage, res: ServerResponse) {
  const data = await body(req);
  const auth = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(String(req.headers.authorization));
  const url = new URL(req.url!, "http://x");
  const fail = (code: string, status = 403) => { res.statusCode = status; res.end(`<Error><Code>${code}</Code></Error>`); };
  if (!auth) return fail("MissingSecurityHeader");
  const [, id, day, region, signed, sig] = auth;
  if (id !== S3_KEY.accessKeyId) return fail("InvalidAccessKeyId");
  const hdr = (h: string) => String(req.headers[h]);
  const canonical = [req.method, url.pathname, url.search.slice(1),
    signed!.split(";").map((h) => `${h}:${hdr(h)}\n`).join(""), signed, sha(data)].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", hdr("x-amz-date"), `${day}/${region}/s3/aws4_request`, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + S3_KEY.secretAccessKey, day!), region!), "s3"), "aws4_request");
  if (hdr("x-amz-content-sha256") !== sha(data) || createHmac("sha256", key).update(toSign).digest("hex") !== sig) {
    s3BadSignatures++;
    return fail("SignatureDoesNotMatch");
  }
  if (req.method === "PUT") { s3Objects.set(url.pathname, data); return res.end(); }
  const got = s3Objects.get(url.pathname);
  if (!got) return fail("NoSuchKey", 404);
  res.end(got);
}

// ── a fake Drive: token endpoint (OAuth and service-account), folders, multipart upload, download ──
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = { type: "service_account", client_email: "robot@kb-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
const OAUTH = { type: "oauth", client_id: "cid", client_secret: "csecret", refresh_token: "rtoken" };
interface DFile { id: string; name: string; parents: string[]; mime: string; bytes: Buffer }
const driveFiles = new Map<string, DFile>();
const driveTokens = new Set<string>();

function parts(buf: Buffer, boundary: string): { head: string; data: Buffer }[] {
  const out: { head: string; data: Buffer }[] = [];
  const marker = Buffer.from(`--${boundary}`);
  let at = buf.indexOf(marker);
  while (at >= 0) {
    const next = buf.indexOf(marker, at + marker.length);
    if (next < 0) break;
    const chunk = buf.subarray(at + marker.length + 2, next - 2); // drop CRLF either side
    const split = chunk.indexOf("\r\n\r\n");
    out.push({ head: chunk.subarray(0, split).toString(), data: chunk.subarray(split + 4) });
    at = next;
  }
  return out;
}

async function fakeDrive(req: IncomingMessage, res: ServerResponse) {
  const data = await body(req);
  const url = new URL(req.url!, "http://x");
  const json = (o: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
  if (url.pathname === "/token") {
    const f = new URLSearchParams(data.toString());
    if (f.get("grant_type") === "refresh_token") {
      if (f.get("refresh_token") !== OAUTH.refresh_token || f.get("client_secret") !== OAUTH.client_secret) return json({ error: "invalid_grant" }, 400);
    } else {
      const [h, c, s] = String(f.get("assertion")).split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s ?? "", "base64url"));
      const claims = JSON.parse(Buffer.from(c ?? "", "base64url").toString());
      if (!ok || claims.iss !== SA.client_email || !String(claims.scope).endsWith("/auth/drive")) return json({ error: "invalid_grant" }, 400);
    }
    const t = "tok-" + randomBytes(6).toString("hex");
    driveTokens.add(t);
    return json({ access_token: t, expires_in: 3600 });
  }
  if (!driveTokens.has(String(req.headers.authorization).replace("Bearer ", ""))) return json({ error: { message: "Invalid Credentials" } }, 401);

  if (url.pathname === "/drive/v3/files" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const files = [...driveFiles.values()].filter((f) => f.mime === "application/vnd.google-apps.folder" && f.name === name && (!parent || f.parents.includes(parent)));
    return json({ files: files.map((f) => ({ id: f.id, name: f.name })) });
  }
  if (url.pathname === "/drive/v3/files" && req.method === "POST") {
    const m = JSON.parse(data.toString());
    const f = { id: "d" + randomBytes(5).toString("hex"), name: m.name, parents: m.parents ?? [], mime: m.mimeType, bytes: Buffer.alloc(0) };
    driveFiles.set(f.id, f);
    return json({ id: f.id });
  }
  if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
    const boundary = /boundary=(.+)$/.exec(String(req.headers["content-type"]))![1]!;
    const [meta, file] = parts(data, boundary);
    const m = JSON.parse(meta!.data.toString());
    const f = { id: "d" + randomBytes(5).toString("hex"), name: m.name, parents: m.parents, mime: /content-type: (.+)/i.exec(file!.head)![1]!, bytes: Buffer.from(file!.data) };
    driveFiles.set(f.id, f);
    return json({ id: f.id });
  }
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (one && req.method === "GET") {
    const f = driveFiles.get(one[1]!);
    if (!f) return json({ error: { message: "File not found" } }, 404);
    res.end(f.bytes);
    return;
  }
  json({ error: { message: "not handled" } }, 404);
}

const listen = (handler: (q: IncomingMessage, s: ServerResponse) => void) => new Promise<Server>((r) => { const s = createServer(handler); s.listen(0, "127.0.0.1", () => r(s)); });
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

/** Path of a Drive file as "root/folder/folder/name". */
function drivePath(f: DFile): string {
  const names = [f.name];
  let p = f.parents[0];
  while (p && driveFiles.has(p)) { const d = driveFiles.get(p)!; names.unshift(d.name); p = d.parents[0]; }
  return names.join("/");
}

describe("storage", () => {
  const store = mkdtempSync(join(tmpdir(), "kb-store-"));
  let w: World;
  let s3: Server;
  let drive: Server;
  let admin: string;
  let desk: string;
  let betaAdmin: string;
  const uhids: string[] = [];

  const api = (cookie: string, method: "GET" | "PUT" | "POST", url: string, payload?: unknown) =>
    w.app.inject({ method, url: `/api/v1/storage${url}`, headers: { cookie, ...(payload ? { "content-type": "application/json" } : {}) }, payload: payload as object | undefined });
  const upload = async (uhid: string, extra: Record<string, unknown> = {}) =>
    exec(w, admin, "uploadPatientDocument", { uhid, fileName: "opg.png", mimeType: "image/png", category: "OPG", base64Data: PNG.toString("base64"), ...extra });
  const s3Setup = () => ({ config: { endpoint: urlOf(s3), region: "auto", bucket: "kb-test", prefix: "kb/" }, secret: S3_KEY });
  /** Rows are visible only inside a clinic, so direct reads here name alpha as the tenant. */
  const rows = async <T>(query: ReturnType<typeof sql<T>>) =>
    w.db.transaction().execute(async (tx) => { await setTenant(tx, w.clinicA); return (await query.execute(tx)).rows; });

  beforeAll(async () => {
    process.env.DOCUMENT_DIR = store;
    process.env.KB_SECRETS_KEY = randomBytes(32).toString("base64");
    process.env.STORAGE_ALLOW_LOCAL_ENDPOINTS = "true";
    s3 = await listen(fakeS3);
    drive = await listen(fakeDrive);
    process.env.DRIVE_API_BASE = urlOf(drive);
    process.env.DRIVE_TOKEN_URL = urlOf(drive) + "/token";
    w = await makeWorld();
    admin = await execLogin(w, "alpha", "a-admin");
    desk = await execLogin(w, "alpha", "a-desk");
    betaAdmin = await execLogin(w, "beta", "b-admin");
    for (const name of ["Asha Rao", "Bina Shah", "Chetan Das"]) {
      const { uhid } = await exec(w, desk, "getNextUHID");
      await exec(w, desk, "saveRegistration", { uhid, name, mobile: "9855500001" });
      uhids.push(uhid);
    }
  });
  afterAll(async () => {
    await w.close();
    s3.close(); drive.close();
    for (const k of ["DOCUMENT_DIR", "KB_SECRETS_KEY", "STORAGE_ALLOW_LOCAL_ENDPOINTS", "DRIVE_API_BASE", "DRIVE_TOKEN_URL"]) delete process.env[k];
    rmSync(store, { recursive: true, force: true });
  });

  it("seals a secret so it cannot be read or altered without the key", () => {
    const sealed = seal({ a: 1 });
    expect(sealed).not.toContain("secretAccessKey");
    expect(open(sealed)).toEqual({ a: 1 });
    const bits = sealed.split(".");
    bits[3] = Buffer.from("tampered").toString("base64");
    expect(() => open(bits.join("."))).toThrow(/could not be opened/);
  });

  it("keeps files in the server folder until a clinic chooses otherwise", async () => {
    const state = (await api(admin, "GET", "")).json();
    expect(state).toMatchObject({ active: "local", backends: {} });
    for (const uhid of uhids) expect(await upload(uhid)).toMatchObject({ success: true });
    expect(readdirSync(store).length).toBe(1); // one sub-folder, the clinic's
    expect((await api(admin, "GET", "")).json().documents).toEqual({ local: 3 });
  });

  it("is for administrators only, and each clinic sees only its own setting", async () => {
    expect((await api(desk, "GET", "")).statusCode).toBe(403);
    expect((await api(desk, "PUT", "/s3", s3Setup())).statusCode).toBe(403);
    expect((await api(betaAdmin, "GET", "")).json()).toMatchObject({ active: "local", backends: {} });
  });

  describe("S3-compatible bucket", () => {
    it("refuses an unsafe address, an unusable bucket and an untested switch", async () => {
      process.env.STORAGE_ALLOW_LOCAL_ENDPOINTS = "false";
      const internal = await api(admin, "PUT", "/s3", { ...s3Setup(), config: { ...s3Setup().config, endpoint: "http://169.254.169.254" } });
      process.env.STORAGE_ALLOW_LOCAL_ENDPOINTS = "true";
      expect(internal.statusCode).toBe(400);
      expect((await api(admin, "PUT", "/s3", { ...s3Setup(), config: { ...s3Setup().config, bucket: "Bad Bucket!" } })).statusCode).toBe(400);
      expect((await api(admin, "PUT", "/s3", { config: s3Setup().config })).statusCode).toBe(400); // no keys yet
      expect((await api(admin, "POST", "/active", { kind: "s3" })).statusCode).toBe(409);
    });

    it("saves sealed credentials, never shows them, and keeps them out of the audit log", async () => {
      expect((await api(admin, "PUT", "/s3", s3Setup())).json()).toEqual({ success: true });
      const shown = (await api(admin, "GET", "")).body;
      expect(shown).not.toContain(S3_KEY.secretAccessKey);
      expect(JSON.parse(shown).backends.s3).toMatchObject({ secretSet: true, active: false, config: { bucket: "kb-test" } });
      const stored = JSON.stringify(await rows(sql`SELECT secret_enc FROM clinic_storage WHERE kind = 's3'`));
      expect(stored).not.toContain(S3_KEY.secretAccessKey);
      const audit = await rows(sql`SELECT after_row FROM audit_log WHERE table_name = 'clinic_storage'`);
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toContain("secret_enc");
    });

    it("reports a bad key from the bucket in words, and a good one passes", async () => {
      await api(admin, "PUT", "/s3", { config: s3Setup().config, secret: { ...S3_KEY, secretAccessKey: "wrong" } });
      const bad = (await api(admin, "POST", "/s3/check")).json();
      expect(bad).toMatchObject({ success: false, message: expect.stringContaining("SignatureDoesNotMatch") });
      expect((await api(admin, "POST", "/active", { kind: "s3" })).statusCode).toBe(409);
      await api(admin, "PUT", "/s3", s3Setup());
      expect((await api(admin, "POST", "/s3/check")).json()).toMatchObject({ success: true, message: "Bucket kb-test works" });
      expect(s3BadSignatures).toBeGreaterThan(0);
    });

    it("moves existing files with checksums, logs the one that fails, and carries on", async () => {
      const broken = (await rows(sql<{ id: string; storage_key: string }>`SELECT id, storage_key FROM patient_documents ORDER BY id`))[1]!;
      writeFileSync(join(store, ...broken.storage_key.split("/")), Buffer.from("not the scan any more"));
      const r = (await api(admin, "POST", "/copy", { to: "s3" })).json();
      expect(r).toMatchObject({ success: true, moved: 2, failed: 1, remaining: 1, lastId: null });
      expect(r.failures[0].id).toBe(broken.id);
      const log = (await api(admin, "GET", "").then(() => w.app.inject({ url: "/api/v1/system-log", headers: { cookie: admin } }))).json();
      expect(log.rows.some((x: { kind: string; ref: string }) => x.kind === "storage_copy" && x.ref === r.failures[0].ref)).toBe(true);
      expect(JSON.stringify(log)).not.toMatch(/Asha|Bina|Chetan/); // names stay out of the log
      expect([...s3Objects.keys()].filter((k) => !k.endsWith(".kb-check")).every((k) => k.startsWith("/kb-test/kb/clinics/"))).toBe(true);
      expect((await api(admin, "GET", "")).json().documents).toEqual({ local: 1, s3: 2 });
    });

    it("sends new uploads to the bucket and reads every file from where it is", async () => {
      expect((await api(admin, "POST", "/active", { kind: "s3" })).json()).toEqual({ success: true, active: "s3" });
      const before = s3Objects.size;
      const up = await upload(uhids[0]!, { fileName: "new.png" });
      expect(up.success).toBe(true);
      expect(s3Objects.size).toBe(before + 1);
      expect(readdirSync(join(store, readdirSync(store)[0]!)).length).toBe(3); // nothing new on disk
      const docs = (await exec(w, admin, "getPatientDocuments", { uhid: uhids[0] })).documents as { id: string }[];
      for (const d of docs) {
        const got = await exec(w, admin, "getPatientDocumentContent", { id: d.id });
        expect(got, JSON.stringify(got)).toMatchObject({ success: true });
        expect(Buffer.from(got.base64, "base64").equals(PNG)).toBe(true);
      }
    });

    it("refuses a file whose stored copy no longer matches its checksum", async () => {
      const [name] = [...s3Objects.keys()].filter((k) => k.includes("/clinics/"));
      s3Objects.set(name!, Buffer.from("tampered"));
      const all = await rows(sql<{ id: string; storage_key: string }>`SELECT id, storage_key FROM patient_documents WHERE storage_backend = 's3'`);
      const hit = all.find((d) => name!.endsWith(d.storage_key))!;
      expect(await exec(w, admin, "getPatientDocumentContent", { id: hit.id })).toMatchObject({ success: false, error: expect.stringContaining("integrity") });
      s3Objects.set(name!, PNG); // put the real file back
    });
  });

  describe("Google Drive", () => {
    it.each([["OAuth", OAUTH], ["a service account", SA]])("signs in with %s", async (_n, cred) => {
      expect((await api(admin, "PUT", "/drive", { config: { folderName: "KB Dental - Patient Documents" }, secret: cred })).json()).toEqual({ success: true });
      expect((await api(admin, "POST", "/drive/check")).json()).toMatchObject({ success: true });
    });

    it("rejects incomplete or wrong sign-in details", async () => {
      expect((await api(admin, "PUT", "/drive", { config: {}, secret: { type: "oauth", client_id: "x" } })).statusCode).toBe(400);
      await api(admin, "PUT", "/drive", { config: {}, secret: { ...OAUTH, refresh_token: "revoked" } });
      expect((await api(admin, "POST", "/drive/check")).json()).toMatchObject({ success: false, message: expect.stringContaining("refused the sign-in") });
      expect((await api(admin, "POST", "/active", { kind: "drive" })).statusCode).toBe(409);
      await api(admin, "PUT", "/drive", { config: { folderName: "KB Dental - Patient Documents" }, secret: OAUTH });
      expect((await api(admin, "POST", "/drive/check")).json().success).toBe(true);
    });

    it("moves the bucket's files to Drive under the familiar folders, and new uploads follow", async () => {
      let after: string | null = null;
      let moved = 0;
      let failed = 0;
      let batches = 0;
      do {
        const r: { moved: number; failed: number; lastId: string | null } = (await api(admin, "POST", "/copy", { to: "drive", limit: 2, after })).json();
        moved += r.moved; failed += r.failed; after = r.lastId; batches++;
      } while (after);
      expect(batches).toBeGreaterThan(1); // it really did go a few at a time
      expect({ moved, failed }).toEqual({ moved: 3, failed: 1 }); // the damaged local file is the one left behind
      expect((await api(admin, "POST", "/active", { kind: "drive" })).json().active).toBe("drive");
      const up = await upload(uhids[2]!, { category: "Reports" });
      const paths = [...driveFiles.values()].filter((f) => f.mime !== "application/vnd.google-apps.folder").map(drivePath);
      expect(paths).toContain(`KB Dental - Patient Documents/${uhids[2]}_Chetan Das/Reports/${up.fileName}`);
      expect(paths.every((p) => p.startsWith("KB Dental - Patient Documents/"))).toBe(true);
      // one root folder, however many uploads asked for it
      expect([...driveFiles.values()].filter((f) => f.name === "KB Dental - Patient Documents")).toHaveLength(1);
      const docs = (await exec(w, admin, "getPatientDocuments", { uhid: uhids[2] })).documents as { id: string }[];
      for (const d of docs) {
        const got = await exec(w, admin, "getPatientDocumentContent", { id: d.id });
        expect(Buffer.from(got.base64, "base64").equals(PNG)).toBe(true);
      }
    });
  });

  it("can switch back to the server folder, and files stay readable wherever they are", async () => {
    expect((await api(admin, "POST", "/active", { kind: "local" })).json().active).toBe("local");
    const up = await upload(uhids[1]!, { fileName: "back.png" });
    const got = await exec(w, admin, "getPatientDocumentContent", { id: up.id });
    expect(Buffer.from(got.base64, "base64").equals(PNG)).toBe(true);
    const kinds = (await api(admin, "GET", "")).json().documents;
    expect(kinds.local).toBeGreaterThanOrEqual(2);
    expect((kinds.s3 ?? 0) + (kinds.drive ?? 0)).toBeGreaterThan(0);
  });
});
