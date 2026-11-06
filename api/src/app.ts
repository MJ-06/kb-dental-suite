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
import { formRoutes } from "./routes/forms.js";
import { patientRoutes } from "./routes/patients.js";
import { adminReportRoutes } from "./routes/admin-reports.js";
import { accessRoutes } from "./routes/access.js";
import { storageRoutes } from "./routes/storage.js";
import { systemLogRoutes } from "./routes/system-log.js";
import { configureSystemLog } from "./syslog.js";
import {asActor} from "./http/context.js";
import {capabilities} from "./entitlements.js";
import {archiveRoutes} from './routes/archives.js';
import {usageRoutes} from './routes/usage.js';

export interface AppOptions {
  db: Kysely<DB>;
  cookieSecure: boolean;
  publicDemo?: boolean;
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

  configureSystemLog(opts.db);
  app.setErrorHandler(errorHandler);
  app.get('/api/v1/capabilities',async req=>asActor(opts.db,req,null,(tx,actor)=>capabilities(tx,actor)));
  await app.register(cookie);
  // Global ceiling per address; login sets its own, much lower one.
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  if(opts.publicDemo) app.addHook("preHandler",async(req,reply)=>{
    if(req.url.startsWith("/api/v1/storage") && !["GET","HEAD"].includes(req.method)) return reply.code(403).send({error:{code:"demo_disabled",message:"External storage configuration is disabled in the synthetic public demo"}});
    const input={...(req.query as Record<string,unknown>),...(req.body && typeof req.body==="object" ? req.body as Record<string,unknown> : {})};
    const action=String(input.action ?? "");
    if(["generateSOAPNotes","chatbotReply","createDocumentPDF"].includes(action)) return reply.send({success:false,error:"External AI and server PDF generation are disabled in the synthetic review demo"});
    if(req.method==="GET" && (/^(save|delete|update|queue|mark|start|resolve|append|switch|open|attach)/.test(action)||action==="getNextUHID"||/^verify.*Password$/.test(action))) return reply.code(405).send({success:false,error:"Send this operation in a POST body"});
  });

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
    if (!reply.hasHeader("X-Frame-Options")) reply.header("X-Frame-Options", "DENY");
    reply.header("Cache-Control", "no-store");
    if (opts.cookieSecure) reply.header("Strict-Transport-Security", "max-age=15552000");
  });

  app.get("/health", async () => {
    await sql`SELECT 1`.execute(opts.db);
    return { status: "ok" };
  });

  await app.register(authRoutes, { ...opts, prefix: "/api/v1/auth" });
  await app.register(patientRoutes, { ...opts, prefix: "/api/v1/patients" });
  await app.register(appointmentRoutes, { ...opts, prefix: "/api/v1/appointments" });
  await app.register(formRoutes, { ...opts, prefix: "/api/v1/forms" });
  await app.register(adminReportRoutes, { ...opts, prefix: "/api/v1/admin" });
  await app.register(accessRoutes, { ...opts, prefix: "/api/v1/access" });
  await app.register(storageRoutes, { ...opts, prefix: "/api/v1/storage" });
  await app.register(systemLogRoutes, { ...opts, prefix: "/api/v1/system-log" });
  await app.register(archiveRoutes, { ...opts, prefix: "/api/v1/archives" });
  await app.register(usageRoutes, { ...opts, prefix: "/api/v1/usage" });
  await app.register(legacyRoutes, opts);
  await app.register(pageRoutes, opts);

  return app;
}
