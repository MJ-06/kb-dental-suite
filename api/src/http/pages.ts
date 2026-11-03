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
import type { AppOptions } from "../app.js";
import { resumeSession } from "../db/index.js";
import { hashToken, SESSION_COOKIE } from "../auth/tokens.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url)); // the repo root, beside api/
const MODULES = fileURLToPath(new URL("../../node_modules/", import.meta.url));
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/register.html": "register.html",
  "/chatbot.html": "chatbot.html",
  "/expense.html": "expense.html",
  "/admin.html": "admin.html",
  "/system-log.html": "system-log.html",
  "/forms.html": "forms.html",
  "/roles.html": "roles.html"
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
const OVERRIDE = `<script>window.KB_SCRIPT_URL_OVERRIDE = location.origin + "/exec"; window.KB_SERVER_URL = window.KB_SCRIPT_URL_OVERRIDE;</script>`;

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

export const pageRoutes: FastifyPluginAsync<AppOptions> = async (app, opts) => {
  for (const [path, file] of Object.entries(PAGES)) {
    app.get(path, async (req, reply) => {
      const nonce = randomBytes(16).toString("base64");
      // Read on each request in development so an edit shows on refresh;
      // the files are small and this is not a hot path.
      let html = readFileSync(ROOT + file, "utf8");
      for (const [from, to] of CDN_SRC) html = html.replace(from, to);
      let head = OVERRIDE;
      const token = req.cookies[SESSION_COOKIE];
      const actor = token ? await opts.db.transaction().execute(tx => resumeSession(tx, hashToken(token))) : null;
      if(actor) head += `<script>window.KB_CLINIC_TIMEZONE = ${JSON.stringify(actor.timezone)};</script>`;
      if (actor?.organizationId) {
        const clinic = JSON.stringify({ id: actor.clinicId, revision: actor.clinicRevision });
        // Each page, including embedded blob forms, pins requests to its rendered
        // clinic. A second tab switching the cookie's context cannot retarget it.
        head += `<script>window.KB_CLINIC_CONTEXT = ${clinic};
window.KB_PIN_FETCH = function(w) {
  if (w.__kbClinicPinned) return;
  w.__kbClinicPinned = true;
  const original = w.fetch.bind(w), clinic = window.KB_CLINIC_CONTEXT;
  if (w !== window) {
    // Embedded mini-apps have their own storage helpers. Namespace those too,
    // without deleting old entries or changing the parent login preferences.
    for (const name of ['localStorage','sessionStorage']) {
      const store = w[name], prefix = 'kb_clinic_' + clinic.id + '_';
      const keys = () => Array.from({length:store.length},(_,i)=>store.key(i)).filter(k=>k && k.startsWith(prefix));
      const scoped = {
        getItem:k=>store.getItem(prefix+k), setItem:(k,v)=>store.setItem(prefix+k,String(v)),
        removeItem:k=>store.removeItem(prefix+k), key:i=>keys()[i]?.slice(prefix.length) ?? null,
        clear:()=>keys().forEach(k=>store.removeItem(k)), get length(){ return keys().length; }
      };
      Object.defineProperty(w,name,{ configurable:true, value:new Proxy(scoped,{
        get:(o,k)=>k in o ? Reflect.get(o,k) : typeof k === 'string' ? scoped.getItem(k) : undefined,
        set:(_o,k,v)=>{ scoped.setItem(String(k),v); return true; },
        deleteProperty:(_o,k)=>{ scoped.removeItem(String(k)); return true; }
      }) });
    }
  }
  w.fetch = function(input, init) {
    const url = new URL(typeof input === 'string' ? input : (input.url || input.href), location.origin);
    if (url.origin === location.origin && (url.pathname === '/exec' || url.pathname.startsWith('/api/'))) {
      const headers = new Headers((init && init.headers) || (input && input.headers));
      headers.set('X-KB-Clinic', clinic.id); headers.set('X-KB-Clinic-Revision', String(clinic.revision));
      init = Object.assign({}, init, {headers});
    }
    return original(input, init);
  };
}; window.KB_PIN_FETCH(window);</script>`;
      }
      if (file === "index.html") {
        head += EMBED_FIX(nonce);
        if (actor?.organizationId) {
          head += `<script>const embed = window.__kbEmbed; window.__kbEmbed = function(h) {
return embed(h).replace(/<head>/i, '<head><script nonce="${nonce}">parent.KB_PIN_FETCH(window);<\\/script>'); };</script>`;
        }
        // Decoded mini-apps get the nonce and local libraries (see EMBED_FIX).
        html = html.replace("return new TextDecoder('utf-8').decode(bytes);", "return window.__kbEmbed(new TextDecoder('utf-8').decode(bytes));");
        // The in-app chatbot opens the real chatbot page instead of a blob copy,
        // because that page, not a blob, is allowed to compile its JSX.
        html = html.replace("_chatbotBlobUrl = URL.createObjectURL(blob);", '_chatbotBlobUrl = location.origin + "/chatbot.html";');
      }
      html = html
        .replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`)
        .replace(/<head>/i, `<head>\n${head.replaceAll("<script>", `<script nonce="${nonce}">`)}`);
      const framedBySelf = file === "chatbot.html" || file === "roles.html";
      reply.header("Content-Security-Policy", csp(nonce, file === "chatbot.html", framedBySelf));
      if (framedBySelf) reply.header("X-Frame-Options", "SAMEORIGIN");
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
