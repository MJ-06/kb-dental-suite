// Serves today's screens from the same address as the API, so the browser
// never crosses origins: no CORS, no mixed content, and the session cookie
// rides along on its own.
//
// Each page gets one line injected ahead of its own scripts that points it
// at /exec instead of the Apps Script URL baked into its source.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync } from "fastify";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url)); // the repo root, beside api/
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/register.html": "register.html",
  "/chatbot.html": "chatbot.html",
  "/expense.html": "expense.html"
};
const OVERRIDE = `<script>window.KB_SCRIPT_URL_OVERRIDE = location.origin + "/exec";</script>`;

export const pageRoutes: FastifyPluginAsync = async (app) => {
  for (const [path, file] of Object.entries(PAGES)) {
    app.get(path, async (_req, reply) => {
      // Read on each request in development so an edit shows on refresh;
      // the files are small and this is not a hot path.
      const html = readFileSync(ROOT + file, "utf8").replace(/<head>/i, `<head>\n${OVERRIDE}`);
      return reply.type("text/html; charset=utf-8").send(html);
    });
  }
};
