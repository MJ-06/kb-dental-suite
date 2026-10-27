import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser } from "../src/admin.js";
import { makeWorld, OWNER_URL, PASSWORD, signIn, type World } from "./setup.js";

let w: World;
beforeAll(async () => {
  w = await makeWorld();
  await createUser(OWNER_URL, w.clinicA, { username: "a-accounts", displayName: "a accounts", password: PASSWORD, role: "accounts" });
});
afterAll(() => w.close());

describe("roles", () => {
  it("lets reception register a patient", async () => {
    const cookie = await signIn(w.app, "alpha", "a-desk");
    const res = await w.app.inject({ method: "POST", url: "/api/v1/patients", headers: { cookie }, payload: { full_name: "Desk Made" } });
    expect(res.statusCode).toBe(201);
  });

  it("lets accounts look a patient up but not edit them", async () => {
    const cookie = await signIn(w.app, "alpha", "a-accounts");
    expect((await w.app.inject({ url: "/api/v1/patients", headers: { cookie } })).statusCode).toBe(200);
    const res = await w.app.inject({ method: "POST", url: "/api/v1/patients", headers: { cookie }, payload: { full_name: "Nope" } });
    expect(res.statusCode).toBe(403);
  });

  it("does not let accounts book appointments", async () => {
    const cookie = await signIn(w.app, "alpha", "a-accounts");
    const res = await w.app.inject({
      method: "POST", url: "/api/v1/appointments", headers: { cookie },
      payload: { patient_name: "X", reason: "Consultation", starts_at: "2026-11-06T10:00:00+05:30", ends_at: "2026-11-06T10:30:00+05:30" }
    });
    expect(res.statusCode).toBe(403);
  });
});
