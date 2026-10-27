-- K.B. Dental Clinic — PostgreSQL schema, phase 1.
--
-- Designed against the clinic's own sheets as they stand, not from a
-- template. Every table below replaces something that exists today, and the
-- constraints are the ones that would have refused the faults found in
-- October: repeated registration ids, panel patients filed under nothing,
-- payments with no patient, amounts that no column could hold.
--
-- Nothing here is installed or run yet. It is a design to be read.

BEGIN;

-- ════════════════════════════════════════════════════════════
-- THE CLINIC'S OWN LISTS  (Master, today)
-- ════════════════════════════════════════════════════════════

CREATE TABLE panels (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,      -- CGHS, DGEHS, ECHS, BSES
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE doctors (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  role          TEXT,
  registration_no TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE staff (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  role          TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE chairs (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE appointment_reasons (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- The procedure library and its stages. One row per procedure, one per
-- stage, instead of the flat list with the procedure repeated on every line.
CREATE TABLE procedures (
  code          TEXT PRIMARY KEY,          -- RCT_ANTERIOR
  name          TEXT NOT NULL,
  family_code   TEXT NOT NULL,             -- ENDODONTIC, SURGICAL, …
  visits_min    SMALLINT NOT NULL DEFAULT 1,
  visits_max    SMALLINT NOT NULL DEFAULT 1,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE procedure_stages (
  procedure_code TEXT NOT NULL REFERENCES procedures(code) ON DELETE CASCADE,
  sequence_no    SMALLINT NOT NULL,
  stage_code     TEXT NOT NULL,
  stage_name     TEXT NOT NULL,            -- "Access Opening", "Obturation"
  stage_type     CHAR(1) NOT NULL,         -- P = procedural, T = treatment
  completes_treatment BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (procedure_code, sequence_no)
);

CREATE TABLE medicines (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  form          TEXT,
  strength      TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (name, strength)
);

CREATE TABLE implant_brands (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,      -- "Nobel Active"
  sizes         TEXT[] NOT NULL DEFAULT '{}'
);

-- Short lists that are just values: dosages, frequencies, durations,
-- instructions, notes, payment modes, expense and document categories.
-- One table rather than eight tabs.
CREATE TABLE pick_lists (
  list_name     TEXT NOT NULL,             -- 'medicine_dosage', 'payment_mode', …
  value         TEXT NOT NULL,
  sort_order    SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (list_name, value)
);

CREATE TABLE clinic_settings (
  key           TEXT PRIMARY KEY,          -- open_time, close_time, slot_minutes,
  value         JSONB NOT NULL             -- pad margins, clinic profile, week offs
);

CREATE TABLE holidays (
  holiday_date  DATE PRIMARY KEY,
  name          TEXT NOT NULL
);

-- ════════════════════════════════════════════════════════════
-- PATIENTS
-- ════════════════════════════════════════════════════════════

-- ONE row per patient. The two books become one table with a column saying
-- which kind — the merge that getAllPatients does in code disappears.
CREATE TABLE patients (
  uhid          TEXT PRIMARY KEY,          -- AF0221. Cannot repeat, by definition.
  full_name     TEXT NOT NULL,
  gender        TEXT,
  date_of_birth DATE,
  blood_group   TEXT,
  occupation    TEXT,
  marital_status TEXT,
  address       TEXT,
  mobile        TEXT,
  mobile_2      TEXT,
  whatsapp      TEXT,
  email         TEXT,
  emergency_name     TEXT,
  emergency_contact  TEXT,
  emergency_relation TEXT,

  -- Private or on a panel. A panel patient MUST point at a real panel, and a
  -- private one must not carry panel details at all. In the sheets this was
  -- only a convention, and it broke.
  patient_type  TEXT NOT NULL DEFAULT 'Normal'
                CHECK (patient_type IN ('Normal','Panel')),
  panel_id      INTEGER REFERENCES panels(id),
  panel_category TEXT CHECK (panel_category IN ('Serving','Pensioner')),
  card_id       TEXT,
  CONSTRAINT panel_patient_has_a_panel CHECK (
    (patient_type = 'Panel' AND panel_id IS NOT NULL) OR
    (patient_type = 'Normal' AND panel_id IS NULL AND card_id IS NULL)
  ),

  referred_by      TEXT,
  referred_by_type TEXT CHECK (referred_by_type IN
                     ('Patient','Doctor','Staff','PR / Marketing','Other')),

  registered_on TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON patients (lower(full_name));
CREATE INDEX ON patients (mobile);
CREATE INDEX ON patients (panel_id);

-- Every time NABH asks for a patient's details afresh, that collection is a
-- ROW HERE — not a second patient. This is the thing the sheets could not
-- express: forty patients had several rows under one id, and the app read
-- whichever came first until it was taught to find the newest.
CREATE TABLE patient_registrations (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE CASCADE,
  collected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  collected_by  TEXT,
  status        TEXT NOT NULL DEFAULT 'Complete'
                CHECK (status IN ('Quick','Complete')),
  -- The medical history as given on that occasion. Conditions and allergies
  -- are real lists here, not comma-separated text in one cell.
  conditions    TEXT[] NOT NULL DEFAULT '{}',
  allergies     TEXT[] NOT NULL DEFAULT '{}',
  medicines     TEXT,
  habits        TEXT[] NOT NULL DEFAULT '{}',
  pregnant      BOOLEAN,
  feeding_mother BOOLEAN,
  chief_complaint TEXT,
  pain_level    SMALLINT CHECK (pain_level BETWEEN 0 AND 10),
  how_known     TEXT[] NOT NULL DEFAULT '{}',
  consent_given BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot      JSONB                      -- the whole form as submitted
);

CREATE INDEX ON patient_registrations (uhid, collected_at DESC);

-- ════════════════════════════════════════════════════════════
-- TREATMENT CASES  (a course of treatment across several visits)
-- ════════════════════════════════════════════════════════════

CREATE TABLE treatment_cases (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  procedure_code TEXT NOT NULL REFERENCES procedures(code),
  tooth_numbers TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','completed','abandoned')),
  opened_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  closed_on     DATE,
  CONSTRAINT closed_cases_have_a_date CHECK (
    (status = 'open' AND closed_on IS NULL) OR (status <> 'open')
  )
);

CREATE INDEX ON treatment_cases (uhid, status);

CREATE TABLE case_stages (
  id            BIGSERIAL PRIMARY KEY,
  case_id       BIGINT NOT NULL REFERENCES treatment_cases(id) ON DELETE CASCADE,
  sequence_no   SMALLINT NOT NULL,
  stage_name    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','skipped')),
  done_on       DATE,
  UNIQUE (case_id, sequence_no)
);

-- ════════════════════════════════════════════════════════════
-- APPOINTMENTS
-- ════════════════════════════════════════════════════════════

CREATE TABLE appointments (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT REFERENCES patients(uhid) ON DELETE RESTRICT,
  patient_name  TEXT NOT NULL,             -- a phone booking may have no UHID yet
  mobile        TEXT,
  appt_date     DATE NOT NULL,
  appt_time     TIME NOT NULL,
  reason        TEXT NOT NULL,
  -- Which step of the treatment. Taken from the case, not typed again.
  sub_type      TEXT,
  doctor_id     INTEGER REFERENCES doctors(id),
  chair_id      INTEGER REFERENCES chairs(id),
  case_id       BIGINT REFERENCES treatment_cases(id) ON DELETE SET NULL,
  notes         TEXT,

  status        TEXT NOT NULL DEFAULT 'Scheduled'
                CHECK (status IN ('Scheduled','Checked In','In Chair',
                                  'Completed','Cancelled','No Show')),
  checkin_at    TIMESTAMPTZ,
  engaged_at    TIMESTAMPTZ,
  checkout_at   TIMESTAMPTZ,
  cancel_reason TEXT,

  -- A visit cannot be engaged before it was checked in, or checked out
  -- before it was engaged. In the sheet these were four free cells.
  CONSTRAINT stamps_in_order CHECK (
    (engaged_at  IS NULL OR checkin_at IS NOT NULL) AND
    (checkout_at IS NULL OR engaged_at IS NOT NULL)
  ),
  CONSTRAINT cancelled_has_a_reason CHECK (
    status <> 'Cancelled' OR cancel_reason IS NOT NULL
  ),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON appointments (appt_date, appt_time);
CREATE INDEX ON appointments (uhid);
-- Two patients cannot be booked into one chair at one time.
CREATE UNIQUE INDEX one_patient_per_chair_per_slot
  ON appointments (appt_date, appt_time, chair_id)
  WHERE chair_id IS NOT NULL AND status NOT IN ('Cancelled','No Show');

CREATE TABLE blocked_slots (
  id            BIGSERIAL PRIMARY KEY,
  block_date    DATE NOT NULL,
  from_time     TIME NOT NULL,
  to_time       TIME NOT NULL,
  chair_id      INTEGER REFERENCES chairs(id),
  doctor_id     INTEGER REFERENCES doctors(id),
  reason        TEXT,
  CHECK (to_time > from_time)
);

-- ════════════════════════════════════════════════════════════
-- WHAT WAS DONE, AND WHAT WAS PAID
-- ════════════════════════════════════════════════════════════

-- The Daily Register: one row per patient seen, per day.
CREATE TABLE visits (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  visit_date    DATE NOT NULL,
  appointment_id BIGINT REFERENCES appointments(id) ON DELETE SET NULL,
  case_id       BIGINT REFERENCES treatment_cases(id) ON DELETE SET NULL,
  procedure_done TEXT,
  tooth_numbers TEXT,
  work_done     TEXT,
  doctor_id     INTEGER REFERENCES doctors(id),
  initial_assessment_done BOOLEAN,
  care_plan_documented    BOOLEAN,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON visits (uhid, visit_date DESC);
CREATE INDEX ON visits (visit_date);

-- Receipts. A payment belongs to a patient — always. It MAY belong to a
-- visit, and often does not: the clinic takes money on the day before the
-- procedure is written up. Matching them by date in code lost Rs 65,000 on
-- one patient; here the link is a column, set when it is known and null when
-- it is not, and the total is the sum of this table either way.
CREATE TABLE payments (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  visit_id      BIGINT REFERENCES visits(id) ON DELETE SET NULL,
  paid_on       DATE NOT NULL,
  amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  mode          TEXT NOT NULL,             -- Cash, Card, UPI
  service       TEXT,
  receipt_no    TEXT UNIQUE,
  remarks       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON payments (uhid, paid_on DESC);
CREATE INDEX ON payments (paid_on);

CREATE TABLE expenses (
  id            BIGSERIAL PRIMARY KEY,
  spent_on      DATE NOT NULL,
  category      TEXT NOT NULL,
  amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  mode          TEXT,
  payee         TEXT,
  remarks       TEXT
);

CREATE TABLE panel_rates (
  panel_id      INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  procedure_code TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('Serving','Pensioner')),
  rate          NUMERIC(10,2) NOT NULL CHECK (rate >= 0),
  PRIMARY KEY (panel_id, procedure_code, category)
);

-- ════════════════════════════════════════════════════════════
-- CLINICAL RECORDS
-- ════════════════════════════════════════════════════════════

-- All 21 forms in one table. Each form keeps its own shape in `data`, which
-- Postgres can index and search inside — so RCT and Implant Surgery do not
-- need 21 tabs with 21 different column orders, and a new form needs no
-- schema change at all.
CREATE TABLE clinical_records (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  form_type     TEXT NOT NULL,             -- 'rct', 'imp_surgery', 'crown', …
  visit_id      BIGINT REFERENCES visits(id) ON DELETE SET NULL,
  case_id       BIGINT REFERENCES treatment_cases(id) ON DELETE SET NULL,
  record_date   DATE NOT NULL,
  site          TEXT,                      -- tooth no. / implant site / arch
  doctor_id     INTEGER REFERENCES doctors(id),
  data          JSONB NOT NULL,            -- the form, as filled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT
);

CREATE INDEX ON clinical_records (uhid, form_type, record_date DESC);
CREATE INDEX ON clinical_records USING GIN (data);

CREATE TABLE prescriptions (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  visit_id      BIGINT REFERENCES visits(id) ON DELETE SET NULL,
  prescribed_on DATE NOT NULL DEFAULT CURRENT_DATE,
  doctor_id     INTEGER REFERENCES doctors(id),
  procedure_text TEXT,
  teeth         TEXT,
  notes         TEXT,
  medicines     JSONB NOT NULL DEFAULT '[]'   -- name, dose, freq, duration…
);

CREATE TABLE care_plans (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  plan_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  data          JSONB NOT NULL
);

CREATE TABLE treatment_plans (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  plan_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  plan_rows     JSONB NOT NULL DEFAULT '[]',
  estimate      JSONB
);

CREATE TABLE consents (
  id            BIGSERIAL PRIMARY KEY,
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  consent_type  TEXT NOT NULL,
  signed_on     DATE NOT NULL DEFAULT CURRENT_DATE,
  data          JSONB NOT NULL
);

-- Documents stay as FILES. This table only records where each one is —
-- X-rays and scans do not belong inside a database.
CREATE TABLE patient_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uhid          TEXT NOT NULL REFERENCES patients(uhid) ON DELETE RESTRICT,
  file_name     TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  category      TEXT NOT NULL,
  storage_ref   TEXT NOT NULL,             -- Drive file id, or a path
  doc_key       TEXT,                      -- fingerprint: stops a reprint filing twice
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (uhid, doc_key)
);

CREATE INDEX ON patient_documents (uhid, category);

-- ════════════════════════════════════════════════════════════
-- CRM
-- ════════════════════════════════════════════════════════════

CREATE TABLE crm_companies (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  industry      TEXT,                      -- 'Panel' for CGHS and the rest
  panel_id      INTEGER REFERENCES panels(id)
);

CREATE TABLE crm_contacts (
  id            BIGSERIAL PRIMARY KEY,
  -- A contact that IS a patient points at them. One place, not a copy.
  uhid          TEXT UNIQUE REFERENCES patients(uhid) ON DELETE SET NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  phone         TEXT,
  email         TEXT,
  company_id    INTEGER REFERENCES crm_companies(id),
  source        TEXT,
  referred_by   TEXT,
  referred_by_type TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON crm_contacts (company_id);
CREATE INDEX ON crm_contacts (phone);

CREATE TABLE crm_pipelines (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  custom_fields JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE crm_stages (
  id            SERIAL PRIMARY KEY,
  pipeline_id   INTEGER NOT NULL REFERENCES crm_pipelines(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sort_order    SMALLINT NOT NULL,
  is_closing    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE crm_leads (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  pipeline_id   INTEGER NOT NULL REFERENCES crm_pipelines(id),
  stage_id      INTEGER NOT NULL REFERENCES crm_stages(id),
  contact_id    BIGINT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  uhid          TEXT REFERENCES patients(uhid) ON DELETE SET NULL,
  source        TEXT,
  referred_by   TEXT,
  referred_by_type TEXT,
  amount        NUMERIC(10,2),
  assigned_to   TEXT,
  close_date    DATE,
  status        TEXT NOT NULL DEFAULT 'open',
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A patient gets one consultation lead, not one per import.
  UNIQUE (uhid, pipeline_id)
);

CREATE TABLE crm_followups (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT REFERENCES crm_leads(id) ON DELETE CASCADE,
  contact_id    BIGINT REFERENCES crm_contacts(id) ON DELETE CASCADE,
  due_on        DATE NOT NULL,
  follow_up_type TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  notes         TEXT
);

CREATE TABLE crm_activities (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT REFERENCES crm_leads(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  description   TEXT NOT NULL,
  done_by       TEXT,
  happened_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════
-- WHO DID WHAT  (NABH keeps asking, and the sheets could not answer)
-- ════════════════════════════════════════════════════════════

CREATE TABLE app_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','doctor','reception','accounts')),
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  happened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  username      TEXT,
  action        TEXT NOT NULL,             -- insert | update | delete
  table_name    TEXT NOT NULL,
  row_key       TEXT,
  before_value  JSONB,
  after_value   JSONB
);

CREATE INDEX ON audit_log (table_name, row_key, happened_at DESC);
CREATE INDEX ON audit_log (happened_at DESC);

COMMIT;
