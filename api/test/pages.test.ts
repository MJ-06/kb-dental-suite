import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { makeWorld, PASSWORD, type World } from "./setup.js";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(() => w.close());

const page = (url: string) => w.app.inject({ method: "GET", url });

describe("page security", () => {
  it("sends a CSP whose nonce matches every script tag, with a new nonce each time", async () => {
    const a = await page("/");
    const nonce = /'nonce-([^']+)'/.exec(String(a.headers["content-security-policy"]))![1];
    const tags = a.body.match(/<script[^>]*>/gi)!;
    expect(tags.length).toBeGreaterThan(3);
    expect(tags.every((t) => t.includes(`nonce="${nonce}"`))).toBe(true);
    const b = await page("/");
    expect(String(b.headers["content-security-policy"])).not.toContain(nonce);
  });

  it("allows eval for the chatbot page only, and lets no page load a script from a CDN", async () => {
    const csp = async (u: string) => String((await page(u)).headers["content-security-policy"]);
    expect(await csp("/chatbot.html")).toContain("'unsafe-eval'");
    for (const u of ["/", "/register.html", "/expense.html"]) expect(await csp(u)).not.toContain("unsafe-eval");
    for (const u of ["/", "/chatbot.html"]) {
      const body = (await page(u)).body;
      expect(body).not.toMatch(/<script[^>]+src="https?:/i);
      expect(await csp(u)).not.toMatch(/script-src[^;]*https?:/);
    }
    expect(await csp("/")).toContain("frame-ancestors 'none'");
  });

  it("serves the pinned libraries from its own address", async () => {
    for (const f of ["react", "react-dom", "html2canvas", "jspdf", "babel"]) {
      const res = await page(`/vendor/${f}.js`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("javascript");
    }
    expect((await page("/vendor/../../.env")).statusCode).toBe(404);
  });

  it("marks the session cookie Secure and sends HSTS when configured", async () => {
    const secure = await buildApp({ db: w.db, cookieSecure: true });
    const res = await secure.inject({ method: "POST", url: "/api/v1/auth/login", payload: { clinic: "alpha", username: "a-admin", password: PASSWORD } });
    expect(res.cookies.find((c) => c.name === "kb_session")!.secure).toBe(true);
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect((await page("/health")).headers["strict-transport-security"]).toBeUndefined();
    await secure.close();
  });
});
