// scrypt from Node's own crypto: no native module to build on Windows.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));

// N=2^15 costs ~100 ms here: slow enough to make guessing expensive, fast
// enough that a receptionist does not notice. Stored with the hash, so it
// can be raised later without breaking existing passwords.
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(plain, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(plain, Buffer.from(salt, "base64"), want.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return timingSafeEqual(want, got);
}

// Checked against when the username does not exist, so "no such user" takes
// as long as "wrong password" and the two cannot be told apart by timing.
let dummy: string | undefined;
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummy ??= await hashPassword("not-a-real-password");
  await verifyPassword(plain, dummy);
}
