// Organization-scoped entry point. Settings come only from the selected process
// environment (normally Node --env-file); never load the legacy clinic .env here.
import { buildOrganizationApp } from "./organization/app.js";
import { createDb } from "./db/index.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the organization server`);
  return value;
}

const code = required("KB_ORGANIZATION_CODE");
const hostname = required("KB_ORGANIZATION_HOSTNAME");
const documentRoot = required("KB_DOCUMENT_ROOT");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8091);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
const cookieSecure = process.env.COOKIE_SECURE !== "false";
if (!cookieSecure && !(process.env.KB_LOCAL_DEMO === "1" && host === "127.0.0.1" && /^[a-z0-9-]+[.]localhost(?::[0-9]+)?$/i.test(hostname))) {
  throw new Error("Insecure cookies require an explicitly local demo bound to loopback with a .localhost hostname");
}

const db = createDb(required("DATABASE_URL"), 5);
try {
  const app = await buildOrganizationApp({ db, code, hostname, documentRoot, cookieSecure, logger: true });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      await db.destroy();
    });
  }
  await app.listen({ host, port });
} catch (error) {
  await db.destroy();
  throw error;
}
