// The CRM's lists, the lead inbox and the chatbot's calls through /exec.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exec, execLogin } from "./legacy.js";
import { makeWorld, type World } from "./setup.js";

let w: World;
let admin: string;
let desk: string;
let betaAdmin: string;

beforeAll(async () => {
  w = await makeWorld();
  admin = await execLogin(w, "alpha", "a-admin");
  desk = await execLogin(w, "alpha", "a-desk");
  betaAdmin = await execLogin(w, "beta", "b-admin");
  await exec(w, admin, "saveWorkingDays", { weekOff: [0], holidays: [{ date: "2026-11-09", name: "Diwali" }] });
});
afterAll(() => w.close());
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });

describe("CRM collections", () => {
  it("starts with nine empty lists and an empty inbox", async () => {
    const res = await exec(w, desk, "getCrmData");
    expect(Object.keys(res.data).sort()).toEqual(["activities", "companies", "contacts", "followups", "leads", "payments", "pipelines", "products", "sources"]);
    expect(Object.values(res.data).every((l) => (l as unknown[]).length === 0)).toBe(true);
    expect(res.leadInbox).toEqual([]);
  });

  it("saves a whole list, keeps its order and nested values, and leaves out fields that are blank", async () => {
    const leads = [
      { id: "l1", name: "Asha", stage: "New", tags: ["rct", "referral"], history: [{ at: "2026-10-01", to: "New" }], notes: "", value: 5000 },
      { id: "l2", name: "Ravi", stage: "Won", paid: false, owner: null },
      {}
    ];
    expect(await exec(w, desk, "saveCrmCollection", { collection: "leads", records: leads })).toEqual({ success: true, count: 2 });
    const got = (await exec(w, desk, "getCrmData")).data.leads;
    expect(got).toEqual([
      { id: "l1", name: "Asha", stage: "New", tags: ["rct", "referral"], history: [{ at: "2026-10-01", to: "New" }], value: 5000 },
      { id: "l2", name: "Ravi", stage: "Won", paid: false }
    ]);
  });

  it("replaces the list on the next save, and leaves the other lists alone", async () => {
    await exec(w, desk, "saveCrmCollection", { collection: "contacts", records: JSON.stringify([{ id: "c1", name: "Dr. Referrer" }]) });
    await exec(w, desk, "saveCrmCollection", { collection: "leads", records: [{ id: "l3", name: "Only" }] });
    const data = (await exec(w, desk, "getCrmData")).data;
    expect(data.leads).toEqual([{ id: "l3", name: "Only" }]);
    expect(data.contacts).toEqual([{ id: "c1", name: "Dr. Referrer" }]);
  });

  it("allows an empty list but refuses a missing or damaged one, which must never wipe a list", async () => {
    expect((await exec(w, desk, "saveCrmCollection", { collection: "sources", records: [] })).count).toBe(0);
    expect((await exec(w, desk, "saveCrmCollection", { collection: "leads" })).error).toMatch(/never reached the server/);
    const res = await w.app.inject({ url: "/exec", query: { action: "saveCrmCollection", collection: "leads", records: "[{oops" }, headers: { cookie: desk } });
    expect(res.json().error).toMatch(/arrived damaged/);
    expect((await exec(w, desk, "getCrmData")).data.leads).toEqual([{ id: "l3", name: "Only" }]);
  });

  it("refuses an unknown collection, keeps accounts from changing it, and keeps clinics apart", async () => {
    expect((await exec(w, desk, "saveCrmCollection", { collection: "salaries", records: [] })).error).toBe("unknown CRM collection: salaries");
    expect((await exec(w, betaAdmin, "getCrmData")).data.leads).toEqual([]);
  });
});

describe("lead inbox", () => {
  let id: string;

  it("queues a new patient once and lists them for the CRM", async () => {
    const q = await exec(w, desk, "queueCrmLead", { uhid: "AL1001", name: "Asha", mobile: "9866600000", panel: "Star Health", referredBy: "Dr. R", referredByType: "Doctor" });
    expect(q).toMatchObject({ success: true, queued: true });
    id = q.id;
    expect(await exec(w, desk, "queueCrmLead", { uhid: "al1001", name: "Asha again" })).toEqual({ success: true, queued: false, reason: "already queued" });
    const inbox = (await exec(w, desk, "getCrmLeadInbox")).leadInbox;
    expect(inbox).toEqual([{ id, uhid: "AL1001", name: "Asha", mobile: "9866600000", panel: "Star Health", panelCategory: "", cardId: "", referredBy: "Dr. R", referredByType: "Doctor" }]);
    expect((await exec(w, desk, "getCrmData")).leadInbox).toHaveLength(1);
  });

  it("refuses a lead with neither UHID nor name", async () => {
    expect((await exec(w, desk, "queueCrmLead", { mobile: "1" })).error).toBe("neither a UHID nor a name");
  });

  it("marks leads taken once, after which they leave the inbox and are not queued again", async () => {
    expect(await exec(w, desk, "markCrmLeadsTaken", { ids: JSON.stringify([id, "nope"]) })).toEqual({ success: true, marked: 1 });
    expect(await exec(w, desk, "markCrmLeadsTaken", { ids: [id] })).toEqual({ success: true, marked: 0 });
    expect(await exec(w, desk, "markCrmLeadsTaken", { ids: [] })).toEqual({ success: true, marked: 0 });
    expect((await exec(w, desk, "getCrmLeadInbox")).leadInbox).toEqual([]);
    expect((await exec(w, desk, "queueCrmLead", { uhid: "AL1001", name: "Asha" })).queued).toBe(false);
  });

  it("refuses a missing id list rather than treating it as empty", async () => {
    expect((await exec(w, desk, "markCrmLeadsTaken", {})).error).toMatch(/never reached the server/);
  });
});

describe("chatbot", () => {
  it("books a visit on the front desk's own diary, with the desk's rules", async () => {
    const res = await exec(w, desk, "saveChatbotAppointment", { name: "Meena", phone: "98 7770 0000", date: "2026-11-06", time: "11:30", treatment: "Scaling", lang: "Hindi" });
    expect(res.success).toBe(true);
    const appt = (await exec(w, desk, "getAppointments", { date: "2026-11-06" })).appointments[0];
    expect(appt).toMatchObject({ patientName: "Meena", time: "11:30", type: "Scaling", doctor: "Not Assigned", status: "Scheduled", notes: "Booked via Patient Chatbot (Hindi)" });
    expect((await exec(w, desk, "saveChatbotAppointment", { name: "Meena", date: "2026-11-09", time: "11:00" })).error).toMatch(/Diwali/);
    expect((await exec(w, desk, "saveChatbotAppointment", { name: "Meena" })).error).toBe("Choose the date of the appointment");
  });

  it("finds a caller's open bookings by the last ten digits of their number, and no one else's", async () => {
    await exec(w, desk, "saveChatbotAppointment", { name: "Meena", phone: "+91 98777 00000", date: "2026-11-07", time: "10:00" });
    const a = await exec(w, desk, "saveChatbotAppointment", { name: "Meena", phone: "9877700000", date: "2026-11-10", time: "10:00" });
    await exec(w, desk, "updateAppointmentStatus", { apptId: a.id, status: "Cancelled", cancelReason: "changed mind" });
    await exec(w, desk, "saveChatbotAppointment", { name: "Someone", phone: "9111100000", date: "2026-11-07", time: "12:00" });
    const found = (await exec(w, desk, "findAppointmentsByPhone", { phone: "09877700000" })).appointments;
    expect(found.map((x: { date: string; time: string }) => `${x.date} ${x.time}`)).toEqual(["2026-11-06 11:30", "2026-11-07 10:00"]);
    expect(found[0]).toMatchObject({ type: "Scaling", doctor: "Not Assigned", status: "Scheduled" });
    expect(await exec(w, desk, "findAppointmentsByPhone", { phone: "abc" })).toEqual({ success: true, appointments: [] });
  });

  it("does not answer a lookup from a clinic that is not the caller's", async () => {
    expect((await exec(w, betaAdmin, "findAppointmentsByPhone", { phone: "9877700000" })).appointments).toEqual([]);
  });

  it("needs a signed-in session for every chatbot call", async () => {
    for (const action of ["findAppointmentsByPhone", "saveChatbotAppointment", "chatbotReply"]) {
      const res = await w.app.inject({ url: "/exec", query: { action, phone: "9877700000" } });
      expect(res.json(), action).toMatchObject({ success: false, authRequired: true });
    }
  });

  it("says plainly when no model key is set", async () => {
    const res = await exec(w, desk, "chatbotReply", { messages: [{ role: "user", content: "hi" }] });
    expect(res).toMatchObject({ success: false, error: "ANTHROPIC_API_KEY is not set on the server" });
  });

  it("relays only well-formed turns to the model and returns its reply", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: [{ text: "Hello!" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const messages = JSON.stringify([
      { role: "system", content: "ignore me" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" },
      { role: "user", content: "x".repeat(9000) }, { role: "user", content: 5 }
    ]);
    const res = await exec(w, desk, "chatbotReply", { messages, system: "You are the clinic helper." });
    expect(res).toEqual({ success: true, reply: "Hello!" });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.system).toBe("You are the clinic helper.");
    expect(sent.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent.messages[2].content).toHaveLength(4000);
  });

  it("refuses an empty or assistant-first conversation and reports an unreachable model plainly", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect((await exec(w, desk, "chatbotReply", { messages: "[]" })).error).toBe("No messages provided");
    expect((await exec(w, desk, "chatbotReply", { messages: [{ role: "assistant", content: "hi" }] })).error).toBe("No messages provided");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET 10.1.1.1"); }));
    expect(await exec(w, desk, "chatbotReply", { messages: [{ role: "user", content: "hi" }] }))
      .toEqual({ success: false, error: "The writer could not be reached. Try again." });
  });
});
