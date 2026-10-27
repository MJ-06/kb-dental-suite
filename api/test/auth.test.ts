import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, PASSWORD, signIn, type World } from "./setup.js";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(() => w.close());

const login = (clinic: string, username: string, password: string, ip = "10.0.0.1") =>
  w.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { clinic, username, password }, remoteAddress: ip });

describe("signing in", () => {
  it("sets an HttpOnly, SameSite=Strict cookie and never returns the token in the body", async () => {
    const res = await login("alpha", "a-admin", PASSWORD);
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "kb_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    expect(res.body).not.toContain(cookie.value);
    expect(res.json().user).toMatchObject({ username: "a-admin", role: "admin" });
  });

  it("gives the same answer for a wrong clinic, a wrong user and a wrong password", async () => {
    const msgs = await Promise.all([
      login("nope", "a-admin", PASSWORD, "10.0.0.2"),
      login("alpha", "nobody", PASSWORD, "10.0.0.2"),
      login("alpha", "a-admin", "wrong", "10.0.0.2")
    ]);
    expect(new Set(msgs.map((m) => m.json().error.message)).size).toBe(1);
    expect(msgs.every((m) => m.statusCode === 401)).toBe(true);
  });

  it("does not let a user of one clinic sign in to another", async () => {
    const res = await login("beta", "a-admin", PASSWORD, "10.0.0.3");
    expect(res.statusCode).toBe(401);
  });

  it("pauses an account after five wrong passwords, refusing even the right one", async () => {
    for (let i = 0; i < 5; i++) await login("alpha", "a-desk", "wrong", `10.0.1.${i}`);
    const res = await login("alpha", "a-desk", PASSWORD, "10.0.1.9");
    expect(res.statusCode).toBe(401);
  });

  it("answers a paused account exactly as a wrong password, so guessing teaches nothing", async () => {
    const right = await login("alpha", "a-desk", PASSWORD, "10.0.1.10");
    const wrong = await login("alpha", "a-desk", "still wrong", "10.0.1.11");
    expect(right.json()).toEqual(wrong.json());
  });

  it("counts parallel guesses, so a burst cannot slip past the pause", async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => login("beta", "b-desk", "wrong", `10.0.2.${i}`)));
    const res = await login("beta", "b-desk", PASSWORD, "10.0.2.9");
    expect(res.statusCode).toBe(401);
  });

  it("slows down one address that keeps trying", async () => {
    const tries = [];
    for (let i = 0; i < 12; i++) tries.push(await login("beta", "b-admin", "wrong", "10.9.9.9"));
    expect(tries.at(-1)!.statusCode).toBe(429);
  });
});

describe("signing out", () => {
  it("ends the session on the server, not just in the browser", async () => {
    const cookie = await signIn(w.app, "alpha", "a-admin"); // b-admin is locked by the test above
    await w.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    const res = await w.app.inject({ url: "/api/v1/auth/me", headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });
});
