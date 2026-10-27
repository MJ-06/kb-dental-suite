import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { DB } from "./db/schema.js";
import { errorHandler } from "./http/errors.js";
import { appointmentRoutes } from "./routes/appointments.js";
import { pageRoutes } from "./http/pages.js";
import { legacyRoutes } from "./legacy/route.js";
import { authRoutes } from "./routes/auth.js";
import { patientRoutes } from "./routes/patients.js";

export interface AppOptions {
  db: Kysely<DB>;
  cookieSecure: boolean;
}

export async function buildApp(opts: AppOptions & { logger?: boolean }) {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1024 * 1024, // files go to object storage, not through JSON
    trustProxy: "127.0.0.1", // nginx on the same machine sets X-Forwarded-For
    // Fastify's default silently drops unknown fields. Refusing them instead
    // means a screen that sends `uhid` learns it cannot set one.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", useDefaults: true } }
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler(errorHandler);
  await app.register(cookie);
  // Global ceiling per address; login sets its own, much lower one.
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });

  // A body must be JSON. A cross-site form can send text/plain or form
  // encodings but not JSON, so together with the SameSite=Strict cookie
  // this closes CSRF. /exec is the exception: today's screens post JSON as
  // text/plain, and there the Strict cookie alone keeps other sites out
  // (a cross-site request arrives without it and is refused).
  app.addHook("onRequest", async (req, reply) => {
    const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
    const type = String(req.headers["content-type"] ?? "");
    const ok = type.startsWith("application/json") || (req.url.startsWith("/exec") && type.startsWith("text/plain"));
    if (hasBody && !ok) {
      return reply.status(415).send({ error: { code: "json_only", message: "Send JSON" } });
    }
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cache-Control", "no-store");
  });

  app.get("/health", async () => {
    await sql`SELECT 1`.execute(opts.db);
    return { status: "ok" };
  });

  await app.register(authRoutes, { ...opts, prefix: "/api/v1/auth" });
  await app.register(patientRoutes, { ...opts, prefix: "/api/v1/patients" });
  await app.register(appointmentRoutes, { ...opts, prefix: "/api/v1/appointments" });
  await app.register(legacyRoutes, opts);
  await app.register(pageRoutes);

  return app;
}
