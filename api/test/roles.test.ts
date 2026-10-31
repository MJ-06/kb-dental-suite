import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "../src/admin.js";
import { OWNER_URL, makeWorld, nextIp, PASSWORD, signIn, type World } from "./setup.js";

let w: World;
let admin: string, desk: string;
beforeAll(async () => {
  w = await makeWorld();
  await createUser(OWNER_URL, w.clinicA, { username: "a-doc", displayName: "a doc", password: PASSWORD, role: "doctor" });
  admin = await signIn(w.app, "alpha", "a-admin");
  desk = await signIn(w.app, "alpha", "a-desk");
});
afterAll(() => w.close());

const call = (cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
  w.app.inject({ method, url: `/api/v1/access${url}`, headers: { cookie }, payload });
const json = <T = any>(res: { body: string }) => JSON.parse(res.body) as T;

async function roles(cookie = admin) {
  return json<{ roles: { id: string; name: string; permissions: string[]; users: number }[] }>(await call(cookie, "GET", "/roles")).roles;
}
async function staff(cookie = admin) {
  return json<{ staff: { id: string; username: string; role: string; role_id: string; active: boolean }[] }>(await call(cookie, "GET", "/staff")).staff;
}
const roleId = async (name: string, cookie = admin) => (await roles(cookie)).find((r) => r.name === name)!.id;
const userId = async (username: string, cookie = admin) => (await staff(cookie)).find((u) => u.username === username)!.id;

describe("starting roles", () => {
  it("gives each clinic its own copy of the four built-in roles", async () => {
    expect((await roles()).map((r) => r.name).sort()).toEqual(["accounts", "admin", "doctor", "reception"]);
    const b = await signIn(w.app, "beta", "b-admin");
    expect((await roles(b)).map((r) => r.name).sort()).toEqual(["accounts", "admin", "doctor", "reception"]);
    expect((await roles()).find((r) => r.name === "doctor")!.permissions).toContain("clinical:write");
  });

  it("tells the screens what the signed-in person may do", async () => {
    const me = json((await w.app.inject({ url: "/api/v1/auth/me", headers: { cookie: desk } })));
    expect(me.user.role).toBe("reception");
    expect(me.user.permissions).toContain("payments:collect");
    expect(me.user.permissions).not.toContain("roles:manage");
  });
});

describe("who may open it", () => {
  it("refuses everyone without roles:manage", async () => {
    const doc = await signIn(w.app, "alpha", "a-doc");
    for (const [m, u] of [["GET", "/roles"], ["GET", "/staff"], ["GET", "/activity"], ["GET", "/permissions"]] as const) {
      expect((await call(desk, m, u)).statusCode).toBe(403);
      expect((await call(doc, m, u)).statusCode).toBe(403);
    }
    expect((await call(desk, "POST", "/roles", { name: "Sneaky", permissions: ["roles:manage"] })).statusCode).toBe(403);
    expect((await call(desk, "PATCH", `/staff/${await userId("a-desk")}`, { role_id: await roleId("admin") })).statusCode).toBe(403);
  });

  it("refuses a signed-out caller", async () => {
    expect((await w.app.inject({ url: "/api/v1/access/roles" })).statusCode).toBe(401);
  });
});

describe("clinic isolation", () => {
  it("never lists or touches another clinic's roles or staff", async () => {
    const b = await signIn(w.app, "beta", "b-admin");
    const bRole = await roleId("doctor", b), bUser = await userId("b-desk", b);
    expect((await staff()).map((u) => u.username)).not.toContain("b-desk");
    expect((await roles()).map((r) => r.id)).not.toContain(bRole);

    expect((await call(admin, "PATCH", `/roles/${bRole}`, { name: "Hijacked" })).statusCode).toBe(404);
    expect((await call(admin, "DELETE", `/roles/${bRole}`)).statusCode).toBe(404);
    expect((await call(admin, "PATCH", `/staff/${bUser}`, { active: false })).statusCode).toBe(404);
    expect((await call(admin, "POST", `/staff/${bUser}/reset-password`, {})).statusCode).toBe(404);
    // A login here cannot be put on a role that belongs to the other clinic either.
    expect((await call(admin, "PATCH", `/staff/${await userId("a-desk")}`, { role_id: bRole })).statusCode).toBe(404);
    expect((await call(admin, "POST", "/staff", { username: "x-spy", display_name: "Spy", role_id: bRole })).statusCode).toBe(404);
    expect((await call(admin, "POST", "/roles", { name: "Copy", copy_from: bRole })).statusCode).toBe(404);

    // Untouched on their side.
    expect((await roles(b)).find((r) => r.id === bRole)!.name).toBe("doctor");
    expect((await staff(b)).find((u) => u.id === bUser)!.active).toBe(true);
  });

  it("lets two clinics use the same role name", async () => {
    const b = await signIn(w.app, "beta", "b-admin");
    expect((await call(admin, "POST", "/roles", { name: "Dental nurse", permissions: ["patients:read"] })).statusCode).toBe(201);
    expect((await call(b, "POST", "/roles", { name: "Dental nurse", permissions: ["patients:read"] })).statusCode).toBe(201);
    expect((await call(admin, "POST", "/roles", { name: "dental NURSE" })).statusCode).toBe(409);
  });
});

describe("a role's permissions apply immediately", () => {
  it("lets an admin tick a permission and the user can act on their very next click", async () => {
    const create = await call(admin, "POST", "/roles", { name: "Front desk", permissions: ["patients:read"] });
    expect(create.statusCode).toBe(201);
    const { id } = json(create);
    await call(admin, "POST", "/staff", { username: "a-front", display_name: "Front", role_id: id, password: PASSWORD });
    const front = await signIn(w.app, "alpha", "a-front");
    const register = () => w.app.inject({ method: "POST", url: "/api/v1/patients", headers: { cookie: front }, payload: { full_name: "Role Test" } });

    expect((await register()).statusCode).toBe(403);
    expect((await call(admin, "PATCH", `/roles/${id}`, { permissions: ["patients:read", "patients:write"] })).statusCode).toBe(200);
    expect((await register()).statusCode).toBe(201);
    expect((await call(admin, "PATCH", `/roles/${id}`, { permissions: ["patients:read"] })).statusCode).toBe(200);
    expect((await register()).statusCode).toBe(403);
  });

  it("starts a new role from a copy of an existing one", async () => {
    const res = await call(admin, "POST", "/roles", { name: "Reception plus", copy_from: await roleId("reception") });
    expect(json(res).permissions).toEqual((await roles()).find((r) => r.name === "reception")!.permissions);
  });

  it("refuses a permission that does not exist", async () => {
    const res = await call(admin, "POST", "/roles", { name: "Bad", permissions: ["patients:read", "everything:all"] });
    expect(res.statusCode).toBe(400);
  });

  it("renames a role", async () => {
    const { id } = json(await call(admin, "POST", "/roles", { name: "Temp name" }));
    expect((await call(admin, "PATCH", `/roles/${id}`, { name: "Final name" })).statusCode).toBe(200);
    expect((await roles()).map((r) => r.name)).toContain("Final name");
    expect((await call(admin, "PATCH", `/roles/${id}`, { name: "doctor" })).statusCode).toBe(409);
  });
});

describe("deleting a role", () => {
  it("refuses while anyone is on it, and allows it once nobody is", async () => {
    const { id } = json(await call(admin, "POST", "/roles", { name: "Locum" }));
    const made = await call(admin, "POST", "/staff", { username: "a-locum", display_name: "Locum", role_id: id });
    const res = await call(admin, "DELETE", `/roles/${id}`);
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe("role_in_use");

    await call(admin, "PATCH", `/staff/${json(made).id}`, { role_id: await roleId("reception") });
    expect((await call(admin, "DELETE", `/roles/${id}`)).statusCode).toBe(200);
    expect((await roles()).map((r) => r.id)).not.toContain(id);
  });
});

describe("staff logins", () => {
  it("creates a login with a generated password shown once, and the person can sign in", async () => {
    const res = await call(admin, "POST", "/staff", { username: "New.Hire", display_name: "New Hire", role_id: await roleId("reception") });
    expect(res.statusCode).toBe(201);
    const { password, username } = json(res);
    expect(username).toBe("new.hire");
    expect(password.length).toBeGreaterThanOrEqual(12);
    await signIn(w.app, "alpha", "new.hire", password);
    expect((await call(admin, "POST", "/staff", { username: "new.hire", display_name: "Dup", role_id: await roleId("reception") })).statusCode).toBe(409);
    expect(JSON.stringify(await staff())).not.toContain(password);
  });

  it("refuses a short typed password", async () => {
    const res = await call(admin, "POST", "/staff", { username: "short-pw", display_name: "S", role_id: await roleId("reception"), password: "abc" });
    expect(res.statusCode).toBe(400);
  });

  it("resets a password: the old one stops working, sessions end, a lock is lifted", async () => {
    await call(admin, "POST", "/staff", { username: "a-reset", display_name: "Reset Me", role_id: await roleId("reception"), password: PASSWORD });
    const old = await signIn(w.app, "alpha", "a-reset");
    for (let i = 0; i < 5; i++) {
      await w.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": nextIp() }, payload: { clinic: "alpha", username: "a-reset", password: "wrong-wrong" } });
    }
    expect((await staff()).find((u) => u.username === "a-reset")).toMatchObject({ active: true });
    const locked = await w.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": nextIp() }, payload: { clinic: "alpha", username: "a-reset", password: PASSWORD } });
    expect(locked.statusCode).toBe(401);

    const res = await call(admin, "POST", `/staff/${await userId("a-reset")}/reset-password`, {});
    expect(res.statusCode).toBe(200);
    const fresh = json(res).password as string;
    expect((await w.app.inject({ url: "/api/v1/auth/me", headers: { cookie: old } })).statusCode).toBe(401);
    expect((await w.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": nextIp() }, payload: { clinic: "alpha", username: "a-reset", password: PASSWORD } })).statusCode).toBe(401);
    await signIn(w.app, "alpha", "a-reset", fresh);
  });

  it("deactivating signs the person out and blocks sign-in until reactivated", async () => {
    await call(admin, "POST", "/staff", { username: "a-leaver", display_name: "Leaver", role_id: await roleId("reception"), password: PASSWORD });
    const cookie = await signIn(w.app, "alpha", "a-leaver");
    const id = await userId("a-leaver");
    expect((await call(admin, "PATCH", `/staff/${id}`, { active: false })).statusCode).toBe(200);
    expect((await w.app.inject({ url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
    await expect(signIn(w.app, "alpha", "a-leaver")).rejects.toThrow(/login failed/);
    await call(admin, "PATCH", `/staff/${id}`, { active: true });
    await signIn(w.app, "alpha", "a-leaver");
  });
});

describe("the clinic always keeps an administrator", () => {
  // Beta has exactly one admin and one reception login.
  let b: string;
  beforeAll(async () => { b = await signIn(w.app, "beta", "b-admin"); });

  it("will not deactivate the last admin, even if it is yourself", async () => {
    const res = await call(b, "PATCH", `/staff/${await userId("b-admin", b)}`, { active: false });
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe("last_admin");
    expect((await staff(b)).find((u) => u.username === "b-admin")!.active).toBe(true);
  });

  it("will not demote the last admin", async () => {
    const res = await call(b, "PATCH", `/staff/${await userId("b-admin", b)}`, { role_id: await roleId("reception", b) });
    expect(res.statusCode).toBe(409);
    expect((await staff(b)).find((u) => u.username === "b-admin")!.role).toBe("admin");
  });

  it("will not take Roles & access off the only admin role", async () => {
    const adminRole = (await roles(b)).find((r) => r.name === "admin")!;
    const res = await call(b, "PATCH", `/roles/${adminRole.id}`, { permissions: adminRole.permissions.filter((p) => p !== "roles:manage") });
    expect(res.statusCode).toBe(409);
    expect((await roles(b)).find((r) => r.name === "admin")!.permissions).toContain("roles:manage");
    // Renaming it, or changing other ticks, is fine.
    expect((await call(b, "PATCH", `/roles/${adminRole.id}`, { name: "owner" })).statusCode).toBe(200);
    await call(b, "PATCH", `/roles/${adminRole.id}`, { name: "admin" });
  });

  it("counts only active admins", async () => {
    // A second admin who is then deactivated no longer counts as a spare.
    const spare = json(await call(b, "POST", "/staff", { username: "b-spare", display_name: "Spare", role_id: await roleId("admin", b), password: PASSWORD }));
    expect((await call(b, "PATCH", `/staff/${spare.id}`, { active: false })).statusCode).toBe(200);
    expect((await call(b, "PATCH", `/staff/${await userId("b-admin", b)}`, { active: false })).statusCode).toBe(409);
  });

  it("allows demoting an admin once another active one exists, then protects the remaining one", async () => {
    const second = json(await call(b, "POST", "/staff", { username: "b-second", display_name: "Second", role_id: await roleId("admin", b), password: PASSWORD }));
    expect((await call(b, "PATCH", `/staff/${await userId("b-admin", b)}`, { role_id: await roleId("reception", b) })).statusCode).toBe(200);
    // b-admin is now reception; b-second is the last administrator.
    const sole = await signIn(w.app, "beta", "b-second");
    expect((await call(sole, "PATCH", `/staff/${second.id}`, { role_id: await roleId("doctor", sole) })).statusCode).toBe(409);
    expect((await call(sole, "PATCH", `/staff/${second.id}`, { active: false })).statusCode).toBe(409);
  });

  it("holds when two admins try to remove each other at once", async () => {
    const c = await signIn(w.app, "alpha", "a-admin");
    const other = json(await call(c, "POST", "/staff", { username: "a-admin2", display_name: "Admin Two", role_id: await roleId("admin", c), password: PASSWORD }));
    const c2 = await signIn(w.app, "alpha", "a-admin2");
    const mine = await userId("a-admin", c);
    const [r1, r2] = await Promise.all([
      call(c, "PATCH", `/staff/${other.id}`, { active: false }),
      call(c2, "PATCH", `/staff/${mine}`, { active: false })
    ]);
    // One wins. The other is either refused (409) or already signed out because the winner
    // deactivated it first (401); both leave exactly one administrator.
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([401, 409]).toContain(codes[1]);
    const n = await owner(`SELECT count(*)::int AS n FROM app_users u JOIN roles r ON r.id = u.role_id
                            WHERE u.clinic_id = $1 AND u.active AND 'roles:manage' = ANY (r.permissions)`, [w.clinicA]);
    expect(n[0].n).toBe(1);
  });
});

async function owner(query: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [params[0] ?? ""]);
    const r = await c.query(query, params);
    await c.query("COMMIT");
    return r.rows;
  } finally { await c.end(); }
}

describe("audit", () => {
  it("records each change in plain words, with who made it, and keeps secrets out", async () => {
    const act = json<{ activity: { message: string; by: string; action: string }[] }>(await call(admin, "GET", "/activity")).activity;
    const actions = act.map((a) => a.action);
    for (const a of ["role.created", "role.updated", "role.deleted", "staff.created", "staff.updated", "staff.password_reset"]) {
      expect(actions).toContain(a);
    }
    expect(act.every((a) => a.by === "a-admin" || a.by === "a-admin2")).toBe(true);
    expect(act.find((a) => a.action === "role.updated" && /added Register and edit patients/.test(a.message))).toBeTruthy();
  });

  it("writes row-level audit entries for roles and logins, with no password hash", async () => {
    const rows = await owner(
      `SELECT table_name, action, before_row, after_row FROM audit_log WHERE clinic_id = $1 AND table_name IN ('roles','app_users')`, [w.clinicA]);
    expect(rows.some((r) => r.table_name === "roles" && r.action === "update")).toBe(true);
    expect(rows.some((r) => r.table_name === "roles" && r.action === "delete")).toBe(true);
    expect(rows.some((r) => r.table_name === "app_users" && r.action === "update")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("password_hash");
    const log = await owner(`SELECT message, detail FROM system_log WHERE clinic_id = $1 AND kind = 'access'`, [w.clinicA]);
    expect(JSON.stringify(log)).not.toMatch(/scrypt\$/);
  });
});

describe("resetting your own password", () => {
  it("ends your other sessions but keeps the one you are using", async () => {
    await call(admin, "POST", "/staff", { username: "a-self", display_name: "Self", role_id: await roleId("admin"), password: PASSWORD });
    const here = await signIn(w.app, "alpha", "a-self"), elsewhere = await signIn(w.app, "alpha", "a-self");
    const res = await call(here, "POST", `/staff/${await userId("a-self")}/reset-password`, { password: "a brand new password" });
    expect(res.statusCode).toBe(200);
    expect((await w.app.inject({ url: "/api/v1/auth/me", headers: { cookie: here } })).statusCode).toBe(200);
    expect((await w.app.inject({ url: "/api/v1/auth/me", headers: { cookie: elsewhere } })).statusCode).toBe(401);
  });
});
