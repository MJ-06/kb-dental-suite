// The clinic's own lists: Master, in other words.
//
// Every one of these was a tab that the app read whole and rewrote whole.
// They keep that shape — the Master screen still saves the entire list —
// but a rewrite is now one transaction, so a save that fails half way
// leaves the old list intact instead of a truncated one.
const { query, tx } = require("../db");
const { parseList, parseObject, nz, num, textArray } = require("../util");
const { putSetting, setting } = require("../auth");

// ── plain value lists ────────────────────────────────────────────────────
async function readPickList(name) {
  const r = await query(
    "SELECT value FROM pick_lists WHERE list_name = $1 ORDER BY sort_order, value",
    [name]
  );
  return r.rows.map((x) => x.value);
}

async function writePickList(name, values) {
  await tx(async (c) => {
    await c.query("DELETE FROM pick_lists WHERE list_name = $1", [name]);
    for (let i = 0; i < values.length; i++) {
      const v = String(values[i] == null ? "" : values[i]).trim();
      if (!v) continue;
      // The same value twice in one list is a typo, not two entries.
      await c.query(
        `INSERT INTO pick_lists (list_name, value, sort_order) VALUES ($1, $2, $3)
         ON CONFLICT (list_name, value) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [name, v, i]
      );
    }
  });
}

// Each entry: the action pair, the list's name in the table, and the key the
// browser expects its values under. Declared once rather than written out
// fourteen times.
const VALUE_LISTS = [
  ["ExpenseCategoriesList",  "expense_category",     "categories"],
  ["DocumentCategoriesList", "document_category",    "categories"],
  ["MedicineDosagesList",    "medicine_dosage",      "dosages"],
  ["MedicineFrequenciesList","medicine_frequency",   "frequencies"],
  ["MedicineDurationsList",  "medicine_duration",    "durations"],
  ["MedicineInstructionsList","medicine_instruction","instructions"],
  ["MedicineNotesList",      "medicine_note",        "medNotes"],
  ["PaymentModesList",       "payment_mode",         "modes"],
  ["ClinicalNoteTemplates",  "clinical_note_template","templates"]
];

function registerValueLists(reg) {
  for (const [suffix, listName, key] of VALUE_LISTS) {
    reg[`get${suffix}`] = async () => ({ success: true, [key]: await readPickList(listName) });
    reg[`save${suffix}`] = async (p) => {
      await writePickList(listName, parseList(p[key], suffix));
      return { success: true };
    };
  }
}

// ── people ───────────────────────────────────────────────────────────────
// A phone that is all digits used to leave the sheet as a NUMBER, and the
// app called .trim() on it and threw. Everything leaves here as text.
function person(row) {
  return {
    name: String(row.name || "").trim(),
    phone: String(row.phone || "").trim(),
    email: String(row.email || "").trim(),
    role: String(row.role || "").trim()
  };
}

async function replacePeople(table, rows) {
  await tx(async (c) => {
    await c.query(`UPDATE ${table} SET active = FALSE`);
    for (const d of rows) {
      const name = String((d && d.name) || "").trim();
      if (!name) continue;
      await c.query(
        `INSERT INTO ${table} (name, phone, email, role, active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (name) DO UPDATE
           SET phone = EXCLUDED.phone, email = EXCLUDED.email,
               role = EXCLUDED.role, active = TRUE`,
        [name, nz(d.phone), nz(d.email), nz(d.role)]
      );
    }
  });
}

// A doctor is never deleted, only deactivated: appointments and visits point
// at them, and a clinic that saw a patient in 2019 still has to be able to
// say who did. Deactivating keeps the history and takes them off the list.
async function readPeople(table) {
  const r = await query(
    `SELECT name, phone, email, role FROM ${table} WHERE active ORDER BY name`
  );
  return r.rows.map(person);
}

// ── the register ─────────────────────────────────────────────────────────
const actions = {};
registerValueLists(actions);

actions.getDoctorDetailsList = async () => ({ success: true, doctors: await readPeople("doctors") });
actions.saveDoctorDetailsList = async (p) => {
  await replacePeople("doctors", parseList(p.doctors, "doctor details"));
  return { success: true };
};

actions.getEmployeesList = async () => ({ success: true, employees: await readPeople("staff") });
actions.saveEmployeesList = async (p) => {
  await replacePeople("staff", parseList(p.employees, "employees"));
  return { success: true };
};

actions.getChairsList = async () => {
  const r = await query("SELECT name FROM chairs WHERE active ORDER BY id");
  return { success: true, chairs: r.rows.map((x) => x.name) };
};
actions.saveChairsList = async (p) => {
  const names = parseList(p.chairs, "chairs").map((x) => String(x).trim()).filter(Boolean);
  await tx(async (c) => {
    await c.query("UPDATE chairs SET active = FALSE");
    for (const n of names) {
      await c.query(
        `INSERT INTO chairs (name, active) VALUES ($1, TRUE)
         ON CONFLICT (name) DO UPDATE SET active = TRUE`,
        [n]
      );
    }
  });
  return { success: true };
};

actions.getPanelsList = async () => {
  const r = await query("SELECT name FROM panels WHERE active ORDER BY name");
  return { success: true, panels: r.rows.map((x) => x.name) };
};
actions.savePanelsList = async (p) => {
  const names = parseList(p.panels, "panels").map((x) => String(x).trim()).filter(Boolean);
  await tx(async (c) => {
    await c.query("UPDATE panels SET active = FALSE");
    for (const n of names) {
      await c.query(
        `INSERT INTO panels (name, active) VALUES ($1, TRUE)
         ON CONFLICT (name) DO UPDATE SET active = TRUE`,
        [n]
      );
    }
  });
  return { success: true };
};

actions.getImplantBrandsList = async () => {
  const r = await query("SELECT name, sizes FROM implant_brands ORDER BY name");
  // The form wants one comma-separated string; the column is a real array.
  return { success: true, brands: r.rows.map((x) => ({ name: x.name, sizes: (x.sizes || []).join(", ") })) };
};
actions.saveImplantBrandsList = async (p) => {
  const rows = parseList(p.brands, "implant brands");
  await tx(async (c) => {
    await c.query("DELETE FROM implant_brands");
    for (const b of rows) {
      const name = String((b && b.name) || "").trim();
      if (!name) continue;
      await c.query(
        `INSERT INTO implant_brands (name, sizes) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET sizes = EXCLUDED.sizes`,
        [name, textArray(b.sizes)]
      );
    }
  });
  return { success: true };
};

actions.getTreatmentsMaster = async () => {
  const r = await query("SELECT name, fee, department FROM treatments ORDER BY name");
  return {
    success: true,
    treatments: r.rows.map((x) => ({ name: x.name, fee: x.fee === null ? "" : Number(x.fee), department: x.department || "" }))
  };
};
actions.saveTreatmentsMaster = async (p) => {
  const rows = parseList(p.treatments, "treatments master");
  await tx(async (c) => {
    await c.query("DELETE FROM treatments");
    for (const t of rows) {
      const name = String((t && t.name) || "").trim();
      if (!name) continue;
      await c.query(
        `INSERT INTO treatments (name, fee, department) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET fee = EXCLUDED.fee, department = EXCLUDED.department`,
        [name, num(t.fee), nz(t.department)]
      );
    }
  });
  return { success: true };
};

actions.getMedicinesMaster = async () => {
  const r = await query(
    "SELECT name, default_dosage, default_frequency FROM medicines WHERE active ORDER BY name"
  );
  return {
    success: true,
    medicines: r.rows.map((x) => ({
      name: x.name, dosage: x.default_dosage || "", frequency: x.default_frequency || ""
    }))
  };
};
actions.saveMedicinesMaster = async (p) => {
  const rows = parseList(p.medicines, "medicines master");
  await tx(async (c) => {
    await c.query("UPDATE medicines SET active = FALSE");
    for (const m of rows) {
      const name = String((m && m.name) || "").trim();
      if (!name) continue;
      // (name, strength) is the key; the master screen has no strength
      // column, so these all carry a NULL one and collide on the name.
      await c.query(
        `INSERT INTO medicines (name, default_dosage, default_frequency, active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (name, strength) DO UPDATE
           SET default_dosage = EXCLUDED.default_dosage,
               default_frequency = EXCLUDED.default_frequency, active = TRUE`,
        [name, nz(m.dosage), nz(m.frequency)]
      );
    }
  });
  return { success: true };
};

actions.getReasonsList = async () => {
  const r = await query("SELECT name, steps FROM appointment_reasons WHERE active ORDER BY name");
  const steps = {};
  for (const x of r.rows) if ((x.steps || []).length) steps[x.name] = x.steps;
  return { success: true, reasons: r.rows.map((x) => x.name), reasonSteps: steps };
};
actions.saveReasonsList = async (p) => {
  const names = parseList(p.reasons, "appointment reasons").map((x) => String(x).trim()).filter(Boolean);
  let steps = {};
  if (p.reasonSteps) { try { steps = parseObject(p.reasonSteps, "reason steps"); } catch (_) { steps = {}; } }
  await tx(async (c) => {
    await c.query("UPDATE appointment_reasons SET active = FALSE");
    for (const n of names) {
      await c.query(
        `INSERT INTO appointment_reasons (name, steps, active) VALUES ($1, $2, TRUE)
         ON CONFLICT (name) DO UPDATE SET steps = EXCLUDED.steps, active = TRUE`,
        [n, textArray(steps[n] || [])]
      );
    }
  });
  return { success: true };
};

actions.getPanelRates = async (p) => {
  const panel = nz(p.panel);
  const r = await query(
    `SELECT pn.name AS panel, pr.procedure_code, pr.category, pr.rate
       FROM panel_rates pr JOIN panels pn ON pn.id = pr.panel_id
      WHERE $1::text IS NULL OR pn.name = $1
      ORDER BY pn.name, pr.procedure_code, pr.category`,
    [panel]
  );
  return {
    success: true,
    rates: r.rows.map((x) => ({
      panel: x.panel, procedure: x.procedure_code, category: x.category, rate: Number(x.rate)
    }))
  };
};
actions.savePanelRates = async (p) => {
  const rows = parseList(p.rates, "panel rates");
  const panel = nz(p.panel);
  let saved = 0;
  await tx(async (c) => {
    if (panel) {
      await c.query(
        "DELETE FROM panel_rates WHERE panel_id = (SELECT id FROM panels WHERE name = $1)",
        [panel]
      );
    }
    for (const r of rows) {
      const pname = String(r.panel || panel || "").trim();
      const code = String(r.procedure || r.procedureCode || "").trim();
      const cat = String(r.category || "").trim();
      const rate = num(r.rate);
      if (!pname || !code || !cat || rate === null) continue;
      const pid = await c.query(
        `INSERT INTO panels (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [pname]
      );
      await c.query(
        `INSERT INTO panel_rates (panel_id, procedure_code, category, rate)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (panel_id, procedure_code, category) DO UPDATE SET rate = EXCLUDED.rate`,
        [pid.rows[0].id, code, cat, rate]
      );
      saved++;
    }
  });
  return { success: true, saved, kept: saved };
};

// ── settings ─────────────────────────────────────────────────────────────
actions.getClinicProfile = async () => ({ success: true, profile: (await setting("clinic_profile")) || {} });
actions.saveClinicProfile = async (p) => {
  await putSetting("clinic_profile", parseObject(p.profile, "clinic profile"));
  return { success: true };
};

actions.getClinicTimings = async () => {
  const t = (await setting("clinic_timings")) || {};
  return { success: true, ...t };
};
actions.saveClinicTimings = async (p) => {
  const t = {};
  for (const k of ["openTime", "closeTime", "slotMinutes", "lunchFrom", "lunchTo"]) {
    if (p[k] !== undefined) t[k] = p[k];
  }
  // A screen that sends the whole object instead of loose fields.
  if (p.timings) Object.assign(t, parseObject(p.timings, "clinic timings"));
  await putSetting("clinic_timings", t);
  return { success: true };
};

actions.getWorkingDays = async () => {
  const weekOff = (await setting("week_off")) || [];
  const r = await query("SELECT holiday_date, name FROM holidays ORDER BY holiday_date");
  return {
    success: true,
    weekOff,
    holidays: r.rows.map((x) => ({ date: require("../util").dateISO(x.holiday_date), name: x.name }))
  };
};
actions.saveWorkingDays = async (p) => {
  const weekOff = p.weekOff === undefined ? [] : parseList(p.weekOff, "week offs");
  const holidays = p.holidays === undefined ? [] : parseList(p.holidays, "holidays");
  await tx(async (c) => {
    await c.query(
      `INSERT INTO clinic_settings (key, value) VALUES ('week_off', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(weekOff)]
    );
    await c.query("DELETE FROM holidays");
    for (const h of holidays) {
      const date = require("../util").dateISO(h && (h.date || h));
      if (!date) continue;
      await c.query(
        `INSERT INTO holidays (holiday_date, name) VALUES ($1, $2)
         ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name`,
        [date, String((h && h.name) || "Holiday")]
      );
    }
  });
  return { success: true };
};

// getSettings is the one the app asks for on every load: the loose odds and
// ends that have no table of their own.
actions.getSettings = async () => {
  const r = await query("SELECT key, value FROM clinic_settings");
  const out = {};
  for (const row of r.rows) {
    // Passwords live in the same table and must not leave it.
    if (/password/.test(row.key)) continue;
    out[row.key] = row.value;
  }
  return { success: true, settings: out, ...out };
};
actions.saveSettings = async (p) => {
  const s = parseObject(p.settings !== undefined ? p.settings : p, "settings");
  for (const [k, v] of Object.entries(s)) {
    if (k === "action" || k === "token" || /password/.test(k)) continue;
    await putSetting(k, v);
  }
  return { success: true };
};

actions.getSignatures = async () => {
  const r = await query("SELECT owner_name, image_data FROM signatures");
  const sigs = {};
  for (const x of r.rows) sigs[x.owner_name] = x.image_data;
  return { success: true, signatures: sigs };
};
actions.saveSignature = async (p) => {
  const owner = String(p.name || p.doctor || "clinic").trim() || "clinic";
  const data = String(p.signature || p.image || "");
  if (!data) return { success: false, error: "No signature image was sent" };
  await query(
    `INSERT INTO signatures (owner_name, image_data, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (owner_name) DO UPDATE
       SET image_data = EXCLUDED.image_data, updated_at = now()`,
    [owner, data]
  );
  return { success: true };
};

module.exports = { actions, readPickList, writePickList };
