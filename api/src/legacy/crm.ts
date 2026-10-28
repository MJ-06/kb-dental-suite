// The CRM's collections and the lead inbox, and the patient chatbot's three
// calls, answering as the live Apps Script does.
//
// Chatbot rule (Diya): it never looks a patient up without a login. Every
// call here needs a signed-in staff session like everything else on /exec;
// there is no public lookup by phone number.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { callLimiter, complete, LlmError, type ChatMessage } from "../llm.js";
import { diary } from "./diary.js";
import { read, write, DeskError, type ActionTable } from "./types.js";
import { isoDay, nz, parseList, str } from "./util.js";

const COLLECTIONS = ["pipelines", "leads", "contacts", "companies", "followups", "products", "activities", "payments", "sources"] as const;
const MAX_COLLECTION_BYTES = 20 * 1024 * 1024;

type Rec = Record<string, unknown>;

/** A field the record never had reads as absent, not as "": the CRM expects a list where it has none, and "" has no .map. */
function stripBlank(r: Rec): Rec {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "" && v !== null && v !== undefined));
}

async function waiting(tx: Tx) {
  const r = await sql<{ inbox_ref: string; uhid: string | null; name: string | null; mobile: string | null; panel: string | null;
                        panel_category: string | null; card_id: string | null; referred_by: string | null; referred_by_type: string | null }>`
    SELECT inbox_ref, uhid, name, mobile, panel, panel_category, card_id, referred_by, referred_by_type
      FROM crm_lead_inbox WHERE taken_at IS NULL ORDER BY created_at, id`.execute(tx);
  return r.rows.map((x) => ({
    id: x.inbox_ref, uhid: x.uhid ?? "", name: x.name ?? "", mobile: x.mobile ?? "", panel: x.panel ?? "",
    panelCategory: x.panel_category ?? "", cardId: x.card_id ?? "", referredBy: x.referred_by ?? "", referredByType: x.referred_by_type ?? ""
  }));
}

const chatAllowed = callLimiter(60, 10 * 60_000);

export const crm: ActionTable = {
  getCrmData: read(async (_p, { tx }) => {
    const r = await sql<{ collection: string; data: Rec }>`SELECT collection, data FROM crm_records ORDER BY collection, position`.execute(tx);
    const data: Record<string, Rec[]> = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
    for (const row of r.rows) data[row.collection]!.push(row.data);
    return { success: true, data, leadInbox: await waiting(tx) };
  }, "patients:read"),

  // Replaces one collection with the list the CRM holds, as it always has.
  saveCrmCollection: write("patients:write", async (p, { tx }) => {
    const name = str(p.collection);
    if (!(COLLECTIONS as readonly string[]).includes(name)) return { success: false, error: `unknown CRM collection: ${name}` };
    const list = parseList(p.records, name);
    const records = list.filter((r): r is Rec => !!r && typeof r === "object" && !Array.isArray(r)).map(stripBlank).filter((r) => Object.keys(r).length);
    const json = JSON.stringify(records);
    if (json.length > MAX_COLLECTION_BYTES) throw new DeskError(`the ${name} list is too large to save`);

    // Two desks saving the same list must not interleave their rows.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${"crm:" + name}, 0))`.execute(tx);
    await sql`DELETE FROM crm_records WHERE collection = ${name}`.execute(tx);
    if (records.length) {
      await sql`
        INSERT INTO crm_records (collection, position, data)
        SELECT ${name}, ord::int, d FROM jsonb_array_elements(${json}::jsonb) WITH ORDINALITY AS t(d, ord)`.execute(tx);
    }
    return { success: true, count: records.length };
  }),

  getCrmLeadInbox: read(async (_p, { tx }) => ({ success: true, leadInbox: await waiting(tx) }), "patients:read"),

  // Called by the desk the moment a new patient is registered.
  queueCrmLead: write("patients:write", async (p, { tx }) => {
    const uhid = str(p.uhid), name = str(p.name);
    if (!uhid && !name) return { success: false, error: "neither a UHID nor a name" };
    // Someone already queued, or queued and taken, is not queued again: coming
    // back after a long gap is the same person, not a new lead.
    const ref = `li${Date.now()}${randomUUID().slice(0, 3)}`;
    const r = await sql<{ inbox_ref: string }>`
      INSERT INTO crm_lead_inbox (inbox_ref, uhid, name, mobile, panel, panel_category, card_id, referred_by, referred_by_type)
      VALUES (${ref}, ${nz(uhid)}, ${nz(name)}, ${nz(p.mobile)}, ${nz(p.panel)}, ${nz(p.panelCategory)}, ${nz(p.cardId)},
              ${nz(p.referredBy)}, ${nz(p.referredByType)})
      ON CONFLICT DO NOTHING RETURNING inbox_ref`.execute(tx);
    return r.rows[0] ? { success: true, queued: true, id: r.rows[0].inbox_ref } : { success: true, queued: false, reason: "already queued" };
  }),

  // Stamped once the CRM has made leads of them, so a second load does not make them again.
  markCrmLeadsTaken: write("patients:write", async (p, { tx }) => {
    const ids = parseList(p.ids, "lead inbox ids").map((x) => str(x)).filter(Boolean);
    if (!ids.length) return { success: true, marked: 0 };
    const r = await sql`
      UPDATE crm_lead_inbox SET taken_at = now() WHERE inbox_ref = ANY(${ids}::text[]) AND taken_at IS NULL RETURNING id`.execute(tx);
    return { success: true, marked: r.rows.length };
  }),

  // ── the patient chatbot ────────────────────────────────────────────────

  // A patient's own bookings that are still open, found by the mobile number.
  findAppointmentsByPhone: read(async (p, { tx, actor }) => {
    const phone = str(p.phone).replace(/\D/g, "").slice(-10);
    if (!phone) return { success: true, appointments: [] };
    const r = await sql<{ id: string; date: string; time: string; type: string; doctor: string | null; status: string }>`
      SELECT coalesce(legacy_id, id::text) AS id, (starts_at AT TIME ZONE ${actor.timezone})::date::text AS date,
             to_char(starts_at AT TIME ZONE ${actor.timezone}, 'HH24:MI') AS time, reason AS type,
             coalesce(doctor_name, '') AS doctor, status
        FROM appointments
       WHERE right(regexp_replace(coalesce(mobile, ''), '[^0-9]', '', 'g'), 10) = ${phone}
         AND status NOT IN ('Cancelled', 'Completed')
       ORDER BY starts_at`.execute(tx);
    return { success: true, appointments: r.rows.map((a) => ({ ...a, doctor: a.doctor ?? "" })) };
  }, "appointments:read"),

  // A booking the chatbot completed lands on the front desk's own diary, with
  // the same rules (closed days, chair clashes); doctor and chair are left
  // for the desk, since the chatbot does not ask for them.
  saveChatbotAppointment: write("appointments:write", async (p, ctx) => {
    if (!isoDay(p.date)) return { success: false, error: "Choose the date of the appointment" };
    const lang = str(p.lang);
    return diary.saveAppointment!.run({
      date: p.date, time: p.time, patientName: p.name, type: str(p.treatment) || "Consultation", doctor: "Not Assigned",
      mobile: p.phone, notes: "Booked via Patient Chatbot" + (lang ? ` (${lang})` : ""), status: "Scheduled"
    }, ctx);
  }),

  // Relays the chatbot's turn to the language model, so the key never sits in a page.
  chatbotReply: read(async (p, { actor }) => {
    if (!process.env.ANTHROPIC_API_KEY) return { success: false, error: "ANTHROPIC_API_KEY is not set on the server" };
    let raw: unknown = p.messages ?? "[]";
    if (typeof raw === "string") { try { raw = JSON.parse(raw || "[]"); } catch { raw = []; } }
    const messages: ChatMessage[] = (Array.isArray(raw) ? raw : [])
      .filter((m): m is { role: string; content: unknown } => !!m && typeof m === "object")
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-40).map((m) => ({ role: m.role as ChatMessage["role"], content: String(m.content).slice(0, 4000) }));
    if (!messages.length || messages[0]!.role !== "user") return { success: false, error: "No messages provided" };
    if (!chatAllowed(actor.userId)) return { success: false, error: "Too many messages. Wait a few minutes and try again." };
    try {
      const reply = await complete({
        model: process.env.CHATBOT_MODEL ?? "claude-haiku-5-5", maxTokens: 700, system: str(p.system).slice(0, 8000), messages
      });
      return { success: true, reply };
    } catch (e) {
      if (e instanceof LlmError) return { success: false, error: e.message };
      throw e;
    }
  }, "appointments:read")
};

