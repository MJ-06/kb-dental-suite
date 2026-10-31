// Any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO...), with
// request signing done here (AWS Signature V4), so no SDK is needed. Path-style
// URLs by default, which every one of those accepts.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { assertKey, type Backend } from "./types.js";

export interface S3Config {
  /** Blank: AWS itself (https://s3.<region>.amazonaws.com). */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Prepended to every object name, e.g. "kb-dental/". */
  prefix?: string;
  /** false: bucket.host/key instead of host/bucket/key. */
  pathStyle?: boolean;
}
export interface S3Secret { accessKeyId: string; secretAccessKey: string }

// Uploads are capped at 25 MB; a little more allows for generated PDFs.
const MAX_OBJECT_BYTES = 30 * 1024 * 1024;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,30}$/;
const PREFIX = /^[A-Za-z0-9._\-/]{0,100}$/;

/**
 * The endpoint is typed by a clinic admin and the server will call it, so it
 * must not be a way to reach the server's own network: https only, a name and
 * not an address, and nothing that is plainly internal. Tests and local MinIO
 * set STORAGE_ALLOW_LOCAL_ENDPOINTS=true.
 */
export function assertEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("The storage address is not a valid web address"); }
  if (process.env.STORAGE_ALLOW_LOCAL_ENDPOINTS === "true") return url;
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") throw new Error("The storage address must start with https://");
  if (url.username || url.password) throw new Error("Do not put a user name or password in the storage address");
  if (isIP(host) || host.startsWith("[") || host === "localhost" || !host.includes(".") || /\.(local|internal|lan|home|corp|localhost)$/.test(host)) {
    throw new Error("The storage address must be a public name, not an internal address");
  }
  return url;
}


// Addresses a clinic's bucket must never resolve to: this machine, the local network, link-local
// (cloud metadata lives at 169.254.169.254), carrier-grade NAT, multicast.
const internal = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) internal.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["::ffff:0:0", 96],
  // forms that embed or tunnel an IPv4 address, which would otherwise slip past the IPv4 list
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2002::", 16], ["2001::", 32], ["100::", 64]] as const) internal.addSubnet(net, bits, "ipv6");

/** Resolves at connection time and refuses internal results, so the address checked is the address used (no rebinding gap). */
const publicLookup: typeof dnsLookup = ((host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
  const options = typeof opts === "object" && opts ? opts as { all?: boolean } : {};
  dnsLookup(host, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as unknown as { address: string; family: number }[];
    if (!list.length || list.some((a) => internal.check(a.address, a.family === 6 ? "ipv6" : "ipv4"))) {
      return cb(new Error("The storage address points to an internal network address"));
    }
    if (options.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}) as typeof dnsLookup;

interface Reply { ok: boolean; status: number; body: Buffer }

/** One signed request. No redirects are followed: they would carry the signature somewhere unchecked. */
function send(url: URL, method: string, headers: Record<string, string>, body: Buffer, maxReply: number): Promise<Reply> {
  const local = process.env.STORAGE_ALLOW_LOCAL_ENDPOINTS === "true";
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { ...headers, "content-length": String(body.length) }, lookup: local ? undefined : publicLookup, timeout: 60_000 }, (res) => {
      // The bucket is the clinic's to name, so a reply is read only up to what we could ever expect.
      if (Number(res.headers["content-length"] ?? 0) > maxReply) return req.destroy(new Error("The bucket sent a larger reply than expected"));
      const chunks: Buffer[] = [];
      let got = 0;
      res.on("data", (c: Buffer) => {
        got += c.length;
        if (got > maxReply) return req.destroy(new Error("The bucket sent a larger reply than expected"));
        chunks.push(c);
      }).on("end", () => {
        clearTimeout(deadline);
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, body: Buffer.concat(chunks) });
      });
    });
    // An idle timeout alone lets a slow trickle hold the request open for ever.
    const deadline = setTimeout(() => req.destroy(new Error("The bucket took too long to answer")), 120_000);
    req.on("timeout", () => req.destroy(new Error("The bucket did not answer in time")));
    req.on("error", (e) => { clearTimeout(deadline); reject(e); });
    req.end(body);
  });
}

export function validateS3Config(c: S3Config): void {
  if (!BUCKET.test(c.bucket)) throw new Error("The bucket name is not valid");
  if (!REGION.test(c.region)) throw new Error("The region is not valid (use e.g. ap-south-1, or auto for Cloudflare R2)");
  if (!PREFIX.test(c.prefix ?? "") || (c.prefix ?? "").includes("..")) throw new Error("The folder prefix may use letters, digits, . _ - and /");
  if (c.endpoint) assertEndpoint(c.endpoint);
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export function s3Backend(cfg: S3Config, secret: S3Secret): Backend {
  validateS3Config(cfg);
  const base = cfg.endpoint ? assertEndpoint(cfg.endpoint) : new URL(`https://s3.${cfg.region}.amazonaws.com`);
  const pathStyle = cfg.pathStyle !== false;
  const prefix = cfg.prefix ?? "";

  async function request(method: "PUT" | "GET", objectName: string, body: Buffer = Buffer.alloc(0), maxReply = 64 * 1024): Promise<Reply> {
    const host = pathStyle ? base.host : `${cfg.bucket}.${base.host}`;
    const path = (pathStyle ? `/${cfg.bucket}/` : "/") + objectName.split("/").map(enc).join("/");
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const payload = sha256(body);
    const signed = "host;x-amz-content-sha256;x-amz-date";
    const canonical = [method, path, "", `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amzDate}\n`, signed, payload].join("\n");
    const scope = `${day}/${cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac("AWS4" + secret.secretAccessKey, day), cfg.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
    return send(new URL(`${base.protocol}//${host}${path}`), method, {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${secret.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`
    }, body, maxReply);
  }

  const nameOf = (key: string) => (assertKey(key), `${prefix}clinics/${key}`);
  const fail = (what: string, res: Reply) => {
    const code = /<Code>([A-Za-z]+)<\/Code>/.exec(res.body.toString("utf8", 0, 2000))?.[1];
    return new Error(`The bucket refused ${what} (${res.status}${code ? ` ${code}` : ""})`);
  };

  return {
    kind: "s3",
    async put(key, bytes) {
      const res = await request("PUT", nameOf(key), bytes);
      if (!res.ok) throw fail("the upload", res);
      return null;
    },
    async get(key) {
      const res = await request("GET", nameOf(key), undefined, MAX_OBJECT_BYTES);
      if (!res.ok) throw fail("the download", res);
      return res.body;
    },
    async check() {
      const name = `${prefix}.kb-check`;
      const probe = randomBytes(8);
      const put = await request("PUT", name, probe);
      if (!put.ok) throw fail("a test upload", put);
      const got = await request("GET", name);
      if (!got.ok) throw fail("a test download", got);
      if (!got.body.equals(probe)) throw new Error("The bucket returned different data than was written");
      return `Bucket ${cfg.bucket} works`;
    }
  };
}
