-- 0006 The diary and the Daily Register, as today's screens use them.

-- What the booking screen carries beyond the slot itself. Doctor and chair
-- are linked by id when they are on the clinic's lists; the name is kept
-- too, because old bookings name people and chairs that are no longer there.
ALTER TABLE appointments
  ADD COLUMN legacy_id        text,       -- APT-1729… for bookings imported from the sheet
  ADD COLUMN doctor_name      text,
  ADD COLUMN chair_name       text,
  ADD COLUMN walk_in          boolean NOT NULL DEFAULT false,
  ADD COLUMN case_ref         text,
  ADD COLUMN procedure_code   text,
  ADD COLUMN procedure_name   text,
  ADD COLUMN family_code      text,
  ADD COLUMN planned_stages   jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN completed_stages jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN visit_counter    text;
CREATE UNIQUE INDEX appointments_legacy_id ON appointments (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- A chair, or a doctor, unavailable for part of a day.
CREATE TABLE blocked_slots (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  legacy_id   text,
  block_date  date NOT NULL,
  block_type  text NOT NULL DEFAULT 'chair' CHECK (block_type IN ('chair','doctor','clinic')),
  chair_name  text,
  doctor_name text,
  from_time   text,      -- "HH:MM", as the screen sends it
  to_time     text,
  reason      text,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid
);
CREATE INDEX blocked_slots_day ON blocked_slots (clinic_id, block_date);
SELECT enable_tenant_table('blocked_slots');

-- The Daily Register: one row per patient per day, which several screens
-- add to over the visit. The columns are the register's own, as text,
-- because that is what NABH inspects and what the clinic has always kept;
-- the patient is linked when the UHID is known.
CREATE TABLE daily_register (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id            uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  visit_date           date NOT NULL,
  month                text,
  uhid                 text,
  patient_id           uuid,
  patient_name         text,
  phone_no             text,
  age                  text,
  time_walk_in         text,
  consultation_time    text,
  tat                  text,
  initial_assessment   text,
  care_plan_documented text,
  procedure_done       text,
  tooth_no             text,
  work_done            text,
  operating_doctor     text,
  delay_reason         text,
  mode_of_payment      text,
  serial_no            integer,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
-- One row per patient per day: the merge the sheet did by hand, as a rule.
CREATE UNIQUE INDEX daily_register_patient_day ON daily_register (clinic_id, uhid, visit_date) WHERE uhid IS NOT NULL AND uhid <> '';
CREATE INDEX daily_register_day ON daily_register (clinic_id, visit_date);
SELECT enable_tenant_table('daily_register');
