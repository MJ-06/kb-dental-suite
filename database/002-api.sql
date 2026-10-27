-- Phase 2 addendum: the columns and tables writing the API showed were missing.
--
-- Phase 1 was a design read against the sheets. Writing the 135 actions
-- against it found a handful of real gaps — things the app stores today that
-- the design had nowhere to put. They are added here rather than edited into
-- schema.sql so the two can be read in order: what was designed, and what
-- building it taught us.
--
-- Safe to run more than once.

BEGIN;

-- ── Masters the app keeps more about than phase 1 allowed ───────────────

-- Master > Doctor Details holds a phone and an email per doctor, and the
-- same for staff. Appointments pick a doctor by name, so the name stays the
-- unique key.
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE staff   ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE staff   ADD COLUMN IF NOT EXISTS email TEXT;

-- Medicines Master carries the dose and frequency the prescription form
-- fills in by default.
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS default_dosage    TEXT;
ALTER TABLE medicines ADD COLUMN IF NOT EXISTS default_frequency TEXT;

-- Treatments & Fees. Phase 1 had `procedures` (the multi-visit library) but
-- not the clinic's price list, which is a different thing: a name, a fee and
-- a department, shown on the estimate.
CREATE TABLE IF NOT EXISTS treatments (
  name          TEXT PRIMARY KEY,
  fee           NUMERIC(10,2),
  department    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Appointment reasons can have steps (RCT → Access Opening, BMP, Obturation).
ALTER TABLE appointment_reasons ADD COLUMN IF NOT EXISTS steps TEXT[] NOT NULL DEFAULT '{}';

-- ── The Daily Register's own columns ────────────────────────────────────
--
-- Age and phone are NOT added: they are the patient's, and reading them from
-- `patients` is the whole point of having a database. These four are facts
-- about the visit itself and have nowhere else to live.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS walk_in_at      TIME;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS consultation_at TIME;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS delay_reason    TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS payment_note    TEXT;
-- One register row per patient per day — the merge saveToDailyRegister does
-- by hand today, made a rule.
CREATE UNIQUE INDEX IF NOT EXISTS one_register_row_per_patient_per_day
  ON visits (uhid, visit_date);

-- ── Case stages: what a visit's outcome actually does to them ───────────
--
-- Phase 1 had the stage list. It did not have the three outcomes: a stage
-- that needs an adjustment inserts one AFTER it without renumbering
-- everything behind, which is why the sequence number cannot be a whole
-- number. 1.1 sits between 1 and 2 and leaves both alone.
ALTER TABLE case_stages ALTER COLUMN sequence_no TYPE NUMERIC(6,2);
ALTER TABLE case_stages ADD COLUMN IF NOT EXISTS stage_code          TEXT;
ALTER TABLE case_stages ADD COLUMN IF NOT EXISTS completes_treatment BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE case_stages ADD COLUMN IF NOT EXISTS completed_in_appointment BIGINT;
-- 'skipped' was already allowed; 'completed' is what the app calls 'done'.
ALTER TABLE case_stages DROP CONSTRAINT IF EXISTS case_stages_status_check;
ALTER TABLE case_stages ADD  CONSTRAINT case_stages_status_check
  CHECK (status IN ('pending','completed','skipped'));

-- How many visits this case has taken so far. Shown as "visit 3 of 5".
ALTER TABLE treatment_cases ADD COLUMN IF NOT EXISTS visit_counter SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE treatment_cases ADD COLUMN IF NOT EXISTS patient_name  TEXT;

-- ── Signatures ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signatures (
  owner_name    TEXT PRIMARY KEY,          -- a doctor's name, or 'clinic'
  image_data    TEXT NOT NULL,             -- data: URL, as the forms store it
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Prescriptions: the printed copy ─────────────────────────────────────
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS document_id UUID
  REFERENCES patient_documents(id) ON DELETE SET NULL;

-- ── Staff sessions ──────────────────────────────────────────────────────
--
-- Apps Script kept these in a script property, so they survived nothing and
-- grew without bound. A table means a restart of the server does not sign
-- the whole clinic out mid-morning.
CREATE TABLE IF NOT EXISTS sessions (
  token         TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- ── The CRM's own collections ───────────────────────────────────────────
--
-- A deliberate exception, and worth saying why.
--
-- The CRM is a separate application that happens to be served inside the
-- app. It keeps nine collections of records whose fields it defines itself,
-- including custom fields the clinic adds from its own settings screen.
-- Phase 1 designed relational tables for it — crm_contacts, crm_leads and
-- the rest — and those are the right shape for the day the CRM is rewritten
-- to use them.
--
-- It is not the right thing to do two weeks before launch to 2,501 live
-- contacts. So the CRM keeps its own shape here, one row per record, and
-- moves onto the relational tables as its own piece of work. Everything the
-- clinic actually queries across — a patient, their panel, their payments —
-- is relational already.
CREATE TABLE IF NOT EXISTS crm_documents (
  collection    TEXT NOT NULL,             -- 'contacts', 'leads', 'companies', …
  record_id     TEXT NOT NULL,
  data          JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, record_id)
);
CREATE INDEX IF NOT EXISTS crm_documents_data ON crm_documents USING GIN (data);

-- ── CRM lead inbox ──────────────────────────────────────────────────────
--
-- A new patient becomes a lead the next time the CRM tab is open. Until it
-- is, the lead waits here.
CREATE TABLE IF NOT EXISTS crm_lead_inbox (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE CASCADE,
  patient_name  TEXT NOT NULL,
  mobile        TEXT,
  panel         TEXT,
  referred_by   TEXT,
  referred_by_type TEXT,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  taken_at      TIMESTAMPTZ,
  -- A patient is queued once. Re-registering does not queue them again.
  UNIQUE (uhid)
);
CREATE INDEX IF NOT EXISTS crm_lead_inbox_waiting ON crm_lead_inbox (queued_at)
  WHERE taken_at IS NULL;

COMMIT;
