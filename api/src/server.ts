import { required } from "./env.js";
import { buildApp } from "./app.js";
import { createDb } from "./db/index.js";

const db = createDb(required("DATABASE_URL"));
const app = await buildApp({ db, cookieSecure: process.env.COOKIE_SECURE !== "false", logger: true });

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });

// Finish what is in flight, then let go of the pool.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig}: shutting down`);
    await app.close();
    await db.destroy();
    process.exit(0);
  });
}
