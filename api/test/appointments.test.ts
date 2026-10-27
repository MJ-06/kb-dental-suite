import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTenant } from "../src/db/index.js";
import { makeWorld, signIn, type World } from "./setup.js";

let w: World;
let desk: string;
let chair1: string;
let betaChair: string;

beforeAll(async () => {
  w = await makeWorld();
  desk = await signIn(w.app, "alpha", "a-admin");
  const addChair = (clinic: string, name: string) => w.db.transaction().execute(async (tx) => {
    await setTenant(tx, clinic);
    return (await sql<{ id: string }>`INSERT INTO chairs (name) VALUES (${name}) RETURNING id`.execute(tx)).rows[0]!.id;
  });
  chair1 = await addChair(w.clinicA, "Chair 1");
  betaChair = await addChair(w.clinicB, "Beta Chair");
});
afterAll(() => w.close());

const book = (start: string, end: string, extra: Record<string, unknown> = {}, cookie = desk) =>
  w.app.inject({
    method: "POST", url: "/api/v1/appointments", headers: { cookie },
    payload: { patient_name: "Walk In", reason: "Consultation", starts_at: start, ends_at: end, chair_id: chair1, ...extra }
  });

describe("booking", () => {
  it("books a slot", async () => {
    const res = await book("2026-11-06T10:00:00+05:30", "2026-11-06T10:45:00+05:30");
    expect(res.statusCode).toBe(201);
  });

  it("refuses an overlapping booking in the same chair, not just the same start time", async () => {
    const res = await book("2026-11-06T10:30:00+05:30", "2026-11-06T11:00:00+05:30");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("slot_taken");
  });

  it("allows the next slot that starts when the last one ends", async () => {
    const res = await book("2026-11-06T10:45:00+05:30", "2026-11-06T11:15:00+05:30");
    expect(res.statusCode).toBe(201);
  });

  it("refuses a time with no timezone, rather than guessing one", async () => {
    const res = await book("2026-11-06T12:00:00", "2026-11-06T12:30:00");
    expect(res.statusCode).toBe(400);
  });

  it("refuses another clinic's chair", async () => {
    const res = await book("2026-11-06T15:00:00+05:30", "2026-11-06T15:30:00+05:30", { chair_id: betaChair });
    expect(res.statusCode).toBe(422);
  });
});

describe("the day's diary", () => {
  it("uses the clinic's own day: 11:30 pm IST is today, not tomorrow", async () => {
    await book("2026-11-07T23:30:00+05:30", "2026-11-07T23:50:00+05:30", { chair_id: null });
    const day = await w.app.inject({ url: "/api/v1/appointments?date=2026-11-07", headers: { cookie: desk } });
    const next = await w.app.inject({ url: "/api/v1/appointments?date=2026-11-08", headers: { cookie: desk } });
    expect(day.json().appointments).toHaveLength(1);
    expect(next.json().appointments).toHaveLength(0);
  });
});

describe("a visit through the day", () => {
  it("checks in, sits, completes, with the server's clock stamping each step", async () => {
    let a = (await book("2026-11-09T09:00:00+05:30", "2026-11-09T09:30:00+05:30")).json().appointment;
    for (const status of ["Checked In", "In Chair", "Completed"]) {
      const res = await w.app.inject({
        method: "POST", url: `/api/v1/appointments/${a.id}/status`, headers: { cookie: desk },
        payload: { version: a.version, status }
      });
      expect(res.statusCode).toBe(200);
      a = res.json().appointment;
    }
    expect(a.checkin_at && a.engaged_at && a.checkout_at).toBeTruthy();
  });

  it("refuses to skip from booked straight to completed", async () => {
    const a = (await book("2026-11-09T10:00:00+05:30", "2026-11-09T10:30:00+05:30")).json().appointment;
    const res = await w.app.inject({
      method: "POST", url: `/api/v1/appointments/${a.id}/status`, headers: { cookie: desk },
      payload: { version: a.version, status: "Completed" }
    });
    expect(res.statusCode).toBe(422);
  });

  it("refuses a cancellation with no reason", async () => {
    const a = (await book("2026-11-09T11:00:00+05:30", "2026-11-09T11:30:00+05:30")).json().appointment;
    const res = await w.app.inject({
      method: "POST", url: `/api/v1/appointments/${a.id}/status`, headers: { cookie: desk },
      payload: { version: a.version, status: "Cancelled" }
    });
    expect(res.statusCode).toBe(422);
  });

  it("frees the chair once a booking is cancelled", async () => {
    const a = (await book("2026-11-09T12:00:00+05:30", "2026-11-09T12:30:00+05:30")).json().appointment;
    await w.app.inject({
      method: "POST", url: `/api/v1/appointments/${a.id}/status`, headers: { cookie: desk },
      payload: { version: a.version, status: "Cancelled", cancel_reason: "Patient unwell" }
    });
    const res = await book("2026-11-09T12:00:00+05:30", "2026-11-09T12:30:00+05:30");
    expect(res.statusCode).toBe(201);
  });
});
