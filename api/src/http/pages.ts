// Serves today's screens from the same address as the API, so the browser
// never crosses origins: no CORS, no mixed content, and the session cookie
// rides along on its own.
//
// Each page gets one line injected ahead of its own scripts that points it
// at /exec instead of the Apps Script URL baked into its source. The
// third-party libraries the pages load from CDNs are served from
// node_modules at /vendor/ instead, at the exact versions pinned in
// package.json, so a CDN cannot change what runs on a page with a session.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync } from "fastify";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url)); // the repo root, beside api/
const MODULES = fileURLToPath(new URL("../../node_modules/", import.meta.url));
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/register.html": "register.html",
  "/chatbot.html": "chatbot.html",
  "/expense.html": "expense.html"
};
// CDN address (as written in the pages) -> file inside node_modules.
const VENDOR: Record<string, string> = {
  "react.js": "react/umd/react.production.min.js",
  "react-dom.js": "react-dom/umd/react-dom.production.min.js",
  "html2canvas.js": "html2canvas/dist/html2canvas.min.js",
  "jspdf.js": "jspdf/dist/jspdf.umd.min.js",
  "babel.js": "@babel/standalone/babel.min.js"
};
const CDN_SRC = [
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react\/[^"']+/g, "/vendor/react.js"],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/[^"']+/g, "/vendor/react-dom.js"],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/html2canvas\/[^"']+/g, "/vendor/html2canvas.js"],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/[^"']+/g, "/vendor/jspdf.js"],
  [/https:\/\/unpkg\.com\/react@[^"']+/g, "/vendor/react.js"],
  [/https:\/\/unpkg\.com\/react-dom@[^"']+/g, "/vendor/react-dom.js"],
  [/https:\/\/unpkg\.com\/@babel\/standalone[^"']*/g, "/vendor/babel.js"]
] as const;
const OVERRIDE = `<script>window.KB_SCRIPT_URL_OVERRIDE = location.origin + "/exec";</script>`;

// index.html carries its mini-apps (CRM, the clinical forms) as base64 HTML and opens
// them in blob: iframes. A blob document inherits the page's CSP, so its inline
// scripts need the page's nonce and its CDN libraries must come from /vendor/.
// The page's own b64decode is patched to do that to anything that decodes to HTML.
const EMBED_FIX = (nonce: string) => String.raw`<script>window.__kbEmbed = function (h) {
  if (!/<script/i.test(h)) return h;
  var o = location.origin;
  return h.replace(/<script(?=[\s>])/gi, '<script nonce="${nonce}"')
    .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react\/[^"']+/g, o + "/vendor/react.js")
    .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/[^"']+/g, o + "/vendor/react-dom.js")
    .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/html2canvas\/[^"']+/g, o + "/vendor/html2canvas.js")
    .replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/[^"']+/g, o + "/vendor/jspdf.js")
    .replace(/https:\/\/unpkg\.com\/react@[^"']+/g, o + "/vendor/react.js")
    .replace(/https:\/\/unpkg\.com\/react-dom@[^"']+/g, o + "/vendor/react-dom.js");
};</script>`;

// Only scripts carrying this request's random nonce run, so a script a
// stranger manages to store in a patient field is inert. Babel (chatbot
// page only) compiles JSX with eval, which needs 'unsafe-eval'. Styles stay
// inline because the screens build print layouts that way.
function csp(nonce: string, needsEval: boolean, framedBySelf = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${needsEval ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    framedBySelf ? "frame-ancestors 'self'" : "frame-ancestors 'none'"
  ].join("; ");
}

export const pageRoutes: FastifyPluginAsync = async (app) => {
  for (const [path, file] of Object.entries(PAGES)) {
    app.get(path, async (_req, reply) => {
      const nonce = randomBytes(16).toString("base64");
      // Read on each request in development so an edit shows on refresh;
      // the files are small and this is not a hot path.
      let html = readFileSync(ROOT + file, "utf8");
      for (const [from, to] of CDN_SRC) html = html.replace(from, to);
      let head = OVERRIDE;
      if (file === "index.html") {
        head += EMBED_FIX(nonce);
        // Decoded mini-apps get the nonce and local libraries (see EMBED_FIX).
        html = html.replace("return new TextDecoder('utf-8').decode(bytes);", "return window.__kbEmbed(new TextDecoder('utf-8').decode(bytes));");
        // The in-app chatbot opens the real chatbot page instead of a blob copy,
        // because that page, not a blob, is allowed to compile its JSX.
        html = html.replace("_chatbotBlobUrl = URL.createObjectURL(blob);", '_chatbotBlobUrl = location.origin + "/chatbot.html";');
      }
      html = html
        .replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`)
        .replace(/<head>/i, `<head>\n${head.replaceAll("<script>", `<script nonce="${nonce}">`)}`);
      reply.header("Content-Security-Policy", csp(nonce, file === "chatbot.html", file === "chatbot.html"));
      if (file === "chatbot.html") reply.header("X-Frame-Options", "SAMEORIGIN"); // the main app shows it in a frame
      return reply.type("text/html; charset=utf-8").send(html);
    });
  }

  for (const [name, file] of Object.entries(VENDOR)) {
    app.get(`/vendor/${name}`, async (_req, reply) =>
      reply
        .type("application/javascript; charset=utf-8")
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .send(readFileSync(MODULES + file))
    );
  }
};
