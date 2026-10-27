// The CRM, and the inbox that feeds it.
//
// Two different things live here. The lead inbox is the clinic's: a patient
// registers, and the next time somebody opens the CRM they are waiting there
// as a consultation lead. The collections are the CRM application's own, and
// keep its shape — see the note in database/002-api.sql.
const { query, tx } = require("../db");
const { nz, parseList } = require("../util");

const COLLECTIONS = [
  "pipelines", "leads", "contacts", "companies",
  "followups", "products", "activities", "payments", "sources"
];

const actions = {};

// Never throws. A CRM that cannot read its inbox should look empty, not
// look as though it had lost its leads.
async function leadsWaiting() {
  try {
    const r = await query(
      `SELECT i.id, i.uhid, i.patient_name, i.mobile, i.panel,
              i.referred_by, i.referred_by_type,
              p.panel_category, p.card_id
         FROM crm_lead_inbox i
         LEFT JOIN patients p ON p.uhid = i.uhid
        WHERE i.taken_at IS NULL
        ORDER BY i.queued_at`
    );
    return r.rows.map((x) => ({
      id: String(x.id), uhid: x.uhid, name: x.patient_name,
      mobile: x.mobile || "", panel: x.panel || "",
      panelCategory: x.panel_category || "", cardId: x.card_id || "",
      referredBy: x.referred_by || "", referredByType: x.referred_by_type || ""
    }));
  } catch (e) {
    console.error("[crm] lead inbox unreadable:", e.message);
    return [];
  }
}

actions.getCrmLeadInbox = async () => ({ success: true, leadInbox: await leadsWaiting() });

actions.queueCrmLead = async (p) => {
  const uhid = String(p.uhid || "").trim().toUpperCase();
  if (!uhid) return { success: false, error: "A lead needs a UHID" };
  const r = await query(
    `INSERT INTO crm_lead_inbox (uhid, patient_name, mobile, panel, referred_by, referred_by_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (uhid) DO NOTHING
     RETURNING id`,
    [uhid, String(p.name || p.patientName || uhid), nz(p.mobile), nz(p.panel),
     nz(p.referredBy), nz(p.referredByType)]
  );
  if (!r.rowCount) return { success: true, queued: false, reason: "already queued" };
  return { success: true, queued: true, id: String(r.rows[0].id) };
};

// The CRM says which leads it has taken. They stop being offered — but the
// row stays, so the same patient is never queued a second time.
actions.markCrmLeadsTaken = async (p) => {
  const ids = (p.ids === undefined ? [] : parseList(p.ids, "lead ids")).map(String).filter(Boolean);
  if (!ids.length) return { success: true, marked: 0 };
  const r = await query(
    "UPDATE crm_lead_inbox SET taken_at = now() WHERE id = ANY($1::bigint[]) AND taken_at IS NULL",
    [ids]
  );
  return { success: true, marked: r.rowCount };
};

// ── the collections ──────────────────────────────────────────────────────
actions.getCrmData = async () => {
  const r = await query("SELECT collection, data FROM crm_documents ORDER BY collection, record_id");
  const out = {};
  for (const name of COLLECTIONS) out[name] = [];
  for (const row of r.rows) {
    if (!out[row.collection]) out[row.collection] = [];
    out[row.collection].push(row.data);
  }
  // Carried on the load the CRM already makes, rather than a second round
  // trip, so opening the screen needs only the one call.
  return { success: true, data: out, leadInbox: await leadsWaiting() };
};

actions.saveCrmCollection = async (p) => {
  const name = String(p.name || p.collection || "").trim();
  if (!COLLECTIONS.includes(name)) {
    return { success: false, error: `Unknown CRM collection: ${name || "(none)"}` };
  }
  const records = parseList(p.records, `CRM ${name}`);
  await tx(async (c) => {
    // The CRM saves a collection whole, as it always has. Doing it in one
    // transaction is the difference: a save that fails leaves the old
    // contacts there rather than half of them.
    await c.query("DELETE FROM crm_documents WHERE collection = $1", [name]);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i] || {};
      const id = String(rec.id || rec.ID || `row-${i + 1}`);
      await c.query(
        `INSERT INTO crm_documents (collection, record_id, data)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (collection, record_id) DO UPDATE
           SET data = EXCLUDED.data, updated_at = now()`,
        [name, id, JSON.stringify(rec)]
      );
    }
  });
  return { success: true, count: records.length };
};

module.exports = { actions, COLLECTIONS, leadsWaiting };
