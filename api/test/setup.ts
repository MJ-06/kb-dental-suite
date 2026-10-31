// Shared by every test file: a fresh test database, two clinics, and a way
// to sign in as anyone in them.
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import pg from "pg";
import { createClinic, createUser } from "../src/admin.js";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/index.js";
import type { DB } from "../src/db/schema.js";
import { required } from "../src/env.js";
import { migrate } from "../src/migrator.js";

export const OWNER_URL = required("TEST_OWNER_DATABASE_URL");
export const APP_URL = required("TEST_DATABASE_URL");
export const PASSWORD = "correct horse battery";

/** KB's year-month prefix for today in India, e.g. AL10 for October 2026. */
export function kbPrefix(now = new Date()): string {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" })
    .format(now).split("-").map(Number) as [number, number];
  const i = Math.max(0, y - 2015);
  return String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)) + String(m).padStart(2, "0");
}

export interface World {
  app: FastifyInstance;
  db: Kysely<DB>;
  clinicA: string;
  clinicB: string;
  close: () => Promise<void>;
}

export async function resetDatabase(): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
  await migrate(OWNER_URL, () => {});
}

export async function makeWorld(): Promise<World> {
  await resetDatabase();
  const clinicA = await createClinic(OWNER_URL, { code: "alpha", name: "Alpha Dental" });
  const clinicB = await createClinic(OWNER_URL, { code: "beta", name: "Beta Dental", uhidScheme: "sequential", uhidPrefix: "BE" });
  for (const [clinic, prefix] of [[clinicA, "a"], [clinicB, "b"]] as const) {
    await createUser(OWNER_URL, clinic, { username: `${prefix}-admin`, displayName: `${prefix} admin`, password: PASSWORD, role: "admin" });
    await createUser(OWNER_URL, clinic, { username: `${prefix}-desk`, displayName: `${prefix} desk`, password: PASSWORD, role: "reception" });
  }
  const db = createDb(APP_URL, 5);
  const app = await buildApp({ db, cookieSecure: false });
  return { app, db, clinicA, clinicB, close: async () => { await app.close(); await db.destroy(); } };
}

let ipCounter = 0;
export const nextIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;

/** Signs in and returns the cookie header to send with later requests. */
export async function signIn(app: FastifyInstance, clinic: string, username: string, password = PASSWORD): Promise<string> {
  // Each sign-in comes from its own address, so the per-address login limit never trips a test that signs in a lot.
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": nextIp() }, payload: { clinic, username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "kb_session");
  if (!cookie) throw new Error("no session cookie");
  return `kb_session=${cookie.value}`;
}
