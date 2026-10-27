// The appointments screen, blocked slots and the Daily Register through /exec.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, type World } from "./setup.js";

let w: World;
let admin: string;
let desk: string;
let uhid: string;

beforeAll(async () => {
  w = await makeWorld();
  admin = await execLogin(w, "alpha", "a-admin");
  desk = await execLogin(w, "alpha", "a-desk");
  await exec(w, admin, "saveChairsList", { chairs: ["Chair 1", "Chair 2"] });
  await exec(w, admin, "saveDoctorDetailsList", { doctors: [{ name: "Dr. A" }] });
  await exec(w, admin, "saveWorkingDays", { weekOff: [0], holidays: [{ date: "2026-11-09", name: "Diwali" }] });
  ({ uhid } = await exec(w, desk, "getNextUHID"));
  await exec(w, desk, "saveRegistration", { uhid, name: "Diary Patient", mobile: "9811100000" });
});
afterAll(() => w.close());

const book = (extra: Record<string, unknown>) => exec(w, desk, "saveAppointment", {
  date: "2026-11-06", time: "10:00", uhid, patientName: "Diary Patient", type: "RCT", subType: "Access Opening",
  doctor: "Dr. A", chair: "Chair 1", mobile: "9811100000", ...extra
});

describe("booking", () => {
  it("books and lists a slot with the fields the screen reads", async () => {
    const res = await book({});
    expect(res.success).toBe(true);
    const list = (await exec(w, desk, "getAppointments", { date: "2026-11-06" })).appointments;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: res.id, date: "2026-11-06", time: "10:00", uhid, patientName: "Diary Patient",
      type: "RCT", subType: "Access Opening", doctor: "Dr. A", chair: "Chair 1", status: "Scheduled",
      checkinTime: "", plannedStages: [], completedStages: [] });
  });

  it("refuses a second patient in the same chair at the same time", async () => {
    const res = await book({ patientName: "Someone Else", uhid: "" });
    expect(res).toMatchObject({ success: false, error: "That chair is already booked for part of that time" });
  });

  it("allows the same time in another chair", async () => {
    expect((await book({ chair: "Chair 2" })).success).toBe(true);
  });

  it("refuses a weekly off day and a holiday, unless it is a walk-in", async () => {
    expect((await book({ date: "2026-11-08", time: "11:00" })).error).toMatch(/closed on 2026-11-08 — Sunday \(weekly off\)/);
    expect((await book({ date: "2026-11-09", time: "11:00" })).error).toMatch(/Diwali \(holiday\)/);
    expect((await book({ date: "2026-11-08", time: "11:00", walkIn: true })).success).toBe(true);
  });

  it("lists a date range", async () => {
    const res = await exec(w, desk, "getAppointments", { fromDate: "2026-11-01", toDate: "2026-11-07" });
    expect(res.appointments.length).toBe(2);
  });
});

describe("a visit through the day", () => {
  it("stamps check-in, chair and checkout in the clinic's time, and clears later stamps when stepped back", async () => {
    const { id } = await book({ date: "2026-11-10", time: "09:00" });
    for (const status of ["Checked In", "In Chair", "Completed"]) {
      expect(await exec(w, desk, "updateAppointmentStatus", { apptId: id, status })).toEqual({ success: true });
    }
    let a = (await exec(w, desk, "getAppointments", { date: "2026-11-10" })).appointments[0];
    expect(a.checkinTime).toMatch(/^\d{2}:\d{2}$/);
    expect(a.checkoutTime).toMatch(/^\d{2}:\d{2}$/);
    await exec(w, desk, "updateAppointmentStatus", { apptId: id, status: "Checked In" });
    a = (await exec(w, desk, "getAppointments", { date: "2026-11-10" })).appointments[0];
    expect(a).toMatchObject({ status: "Checked In", engagedTime: "", checkoutTime: "" });
  });

  it("completes a visit straight from the diary", async () => {
    const { id } = await book({ date: "2026-11-11", time: "09:00" });
    expect(await exec(w, desk, "updateAppointmentStatus", { apptId: id, status: "Completed" })).toEqual({ success: true });
  });

  it("asks for a reason before cancelling, then frees the chair", async () => {
    const { id } = await book({ date: "2026-11-12", time: "09:00" });
    expect((await exec(w, desk, "updateAppointmentStatus", { apptId: id, status: "Cancelled" })).error).toBe("Give a reason for the cancellation");
    await exec(w, desk, "updateAppointmentStatus", { apptId: id, status: "Cancelled", cancelReason: "Unwell" });
    expect((await book({ date: "2026-11-12", time: "09:00" })).success).toBe(true);
  });

  it("moves a booking and keeps its length", async () => {
    const { id } = await book({ date: "2026-11-13", time: "09:00" });
    await exec(w, desk, "updateAppointment", { apptId: id, time: "15:30", notes: "moved" });
    const a = (await exec(w, desk, "getAppointments", { date: "2026-11-13" })).appointments[0];
    expect(a).toMatchObject({ time: "15:30", notes: "moved", type: "RCT" });
  });

  it("deletes a booking", async () => {
    const { id } = await book({ date: "2026-11-14", time: "09:00" });
    expect(await exec(w, desk, "deleteAppointment", { apptId: id })).toEqual({ success: true });
    expect((await exec(w, desk, "deleteAppointment", { apptId: id })).success).toBe(false);
  });
});

describe("blocked slots", () => {
  it("blocks and unblocks part of a day", async () => {
    const { id } = await exec(w, desk, "saveBlockedSlot", { date: "2026-11-06", chair: "Chair 2", fromTime: "13:00", toTime: "14:00", reason: "Lunch" });
    expect((await exec(w, desk, "getBlockedSlots", { date: "2026-11-06" })).blocks).toEqual([
      { date: "2026-11-06", chair: "Chair 2", fromTime: "13:00", toTime: "14:00", reason: "Lunch", id, blockType: "chair", doctor: "" }
    ]);
    await exec(w, desk, "deleteBlockedSlot", { id });
    expect((await exec(w, desk, "getBlockedSlots", { date: "2026-11-06" })).blocks).toEqual([]);
  });
});

describe("the Daily Register", () => {
  it("keeps one row per patient per day and merges what each screen adds", async () => {
    await exec(w, desk, "saveToDailyRegister", { date: "2026-11-06", uhid, patientName: "Diary Patient", timeWalkIn: "09:50", procedureDone: "RCT" });
    const second = await exec(w, desk, "saveToDailyRegister", { date: "2026-11-06", uhid, timeWalkIn: "11:00", procedureDone: "Scaling", workDone: "Access opening" });
    expect(second.merged).toBe(true);
    await exec(w, desk, "saveToDailyRegister", { date: "2026-11-06", uhid, procedureDone: "RCT" });
    const entries = (await exec(w, desk, "getDailyRegister", { fromDate: "2026-11-06", toDate: "2026-11-06" })).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ month: "November", timeWalkIn: "09:50", procedureDone: "RCT | Scaling", workDone: "Access opening" });
  });
});

describe("follow-ups", () => {
  it("answers with the three lists the dashboard reads", async () => {
    const res = await exec(w, desk, "getFollowUps");
    expect(res).toMatchObject({ success: true, postTreatment: expect.any(Array), recall: expect.any(Array), missed: expect.any(Array) });
  });
});
