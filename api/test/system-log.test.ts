import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actions } from "../src/legacy/registry.js";
import { read } from "../src/legacy/types.js";
import { scrub } from "../src/syslog.js";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, type World } from "./setup.js";

let w: World;
let admin: string, desk: string, betaAdmin: string;
beforeAll(async () => {
  w = await makeWorld();
  admin = await execLogin(w, "alpha", "a-admin");
  desk = await execLogin(w, "alpha", "a-desk");
  betaAdmin = await execLogin(w, "beta", "b-admin");
  actions.__boom = read(async () => { throw new Error('duplicate key value violates unique constraint "x" Key (uhid)=(AL0705) 9899102136'); });
});
afterAll(() => { delete actions.__boom; return w.close(); });

const list = (cookie: string, q = "") => w.app.inject({ url: `/api/v1/system-log${q}`, headers: { cookie } });

describe("system log", () => {
  it("gives an unexpected failure a reference the screen shows, and keeps it for an admin", async () => {
    const res = await exec(w, desk, "__boom");
    expect(res.success).toBe(false);
    expect(res.ref).toMatch(/^E-[A-Z2-9]{6}$/);
    expect(res.error).toContain(res.ref);

    const rows = (await list(admin)).json().rows;
    const mine = rows.find((r: { ref: string }) => r.ref === res.ref);
    expect(mine).toMatchObject({ level: "error", kind: "legacy_action", action: "__boom", user: "a-desk", resolved_at: null });
    expect(mine.message).not.toContain("AL0705");       // patient values are scrubbed
    expect(mine.message).not.toContain("9899102136");
  });

  it("does not log a mistake the desk can fix", async () => {
    const before = (await list(admin, "?status=all")).json().counts;
    await exec(w, desk, "saveReceipt", { amount1: 0 }); // "Enter the amount received"
    expect((await list(admin, "?status=all")).json().counts).toEqual(before);
  });

  it("is for admins only, and each clinic sees only its own", async () => {
    expect((await list(desk)).statusCode).toBe(403);
    expect((await w.app.inject({ url: "/api/v1/system-log" })).statusCode).toBe(401);
    expect((await list(betaAdmin)).json().rows).toEqual([]);
  });

  it("finds a failure by its reference and lets an admin mark it resolved once", async () => {
    const res = await exec(w, desk, "__boom");
    const found = (await list(admin, `?ref=${res.ref.toLowerCase()}`)).json().rows;
    expect(found).toHaveLength(1);
    const post = (id: string) => w.app.inject({ method: "POST", url: `/api/v1/system-log/${id}/resolve`, headers: { cookie: admin, "content-type": "application/json" }, payload: { resolution: "Retried, worked" } });
    expect((await post(found[0].id)).statusCode).toBe(200);
    expect((await post(found[0].id)).statusCode).toBe(404);
    const after = (await list(admin, `?status=resolved&ref=${res.ref}`)).json().rows[0];
    expect(after).toMatchObject({ resolution: "Retried, worked", resolved_by: "a-admin" });
  });

  it("scrubs quoted values and long numbers from messages", () => {
    expect(scrub('Key (uhid)=(AL0705) already exists, mobile 9899102136, name \'Asha Rao\'')).toBe("Key (uhid)=(…) already exists, mobile …, name '…'");
  });

  it("serves the System log page", async () => {
    const page = await w.app.inject({ url: "/system-log.html" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("System log");
  });
});
