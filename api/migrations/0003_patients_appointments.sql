-- 0003 The first clinical slice: masters, patients, registrations,
-- appointments. The rest of the 37 tables follow the same pattern.
--
-- Cross-clinic references are impossible by construction: every foreign key
-- to a tenant table includes clinic_id, so a patient of clinic A cannot point
-- at a panel of clinic B even if the API asked it to.

-- ── Masters ─────────────────────────────────────────────────────────────

CREATE TABLE panels (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  UNIQUE (clinic_id, id)
);
CREATE UNIQUE INDEX panels_name ON panels (clinic_id, lower(name));
SELECT enable_tenant_table('panels');

CREATE TABLE doctors (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id       uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  user_id         uuid,
  name            text NOT NULL,
  registration_no text,
  phone           text,
  email           text,
  active          boolean NOT NULL DEFAULT true,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, user_id) REFERENCES app_users (clinic_id, id)
);
CREATE UNIQUE INDEX doctors_name ON doctors (clinic_id, lower(name));
SELECT enable_tenant_table('doctors');

CREATE TABLE chairs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  UNIQUE (clinic_id, id)
);
CREATE UNIQUE INDEX chairs_name ON chairs (clinic_id, lower(name));
SELECT enable_tenant_table('chairs');

-- ── UHIDs ───────────────────────────────────────────────────────────────
-- One counter row per clinic per numbering period (a month for KB's
-- scheme, 'all' for a plain running number). UPDATE ... RETURNING takes a
-- row lock, so two desks registering in the same instant queue for a few
-- microseconds and get different numbers. No read-then-write, no race.
--
-- A period's counter starts from the highest UHID already issued in it, so
-- patients imported from the sheets are never given a number again.

CREATE TABLE uhid_counters (
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  period      text NOT NULL,
  last_value  integer NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (clinic_id, period)
);
ALTER TABLE uhid_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE uhid_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON uhid_counters
  USING (clinic_id = app_clinic_id()) WITH CHECK (clinic_id = app_clinic_id());

-- The current clinic's own row, readable by kb_app without listing others.
CREATE FUNCTION clinic_profile()
RETURNS TABLE (id uuid, code text, name text, uhid_scheme text, uhid_prefix text, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, code, name, uhid_scheme, uhid_prefix, timezone FROM clinics WHERE id = app_clinic_id()
$$;

-- The prefix and period the next UHID belongs to, without taking a number.
-- AA = 2015, AB = 2016 ... AL = 2026, then BA after AZ.
CREATE FUNCTION uhid_period(OUT prefix text, OUT period text, OUT width int)
LANGUAGE plpgsql STABLE AS $$
DECLARE c record; local_now timestamp; y int;
BEGIN
  SELECT * INTO c FROM clinic_profile();
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'No clinic is set for this transaction' USING ERRCODE = '42501';
  END IF;
  IF c.uhid_scheme = 'sequential' THEN
    prefix := c.uhid_prefix; period := 'all'; width := 4;
  ELSE
    local_now := now() AT TIME ZONE c.timezone;
    y := greatest(0, extract(year FROM local_now)::int - 2015);
    prefix := chr(65 + y / 26) || chr(65 + y % 26) || to_char(local_now, 'MM');
    period := to_char(local_now, 'YYYY-MM');
    width := 2;  -- a month past 99 grows to three digits rather than wrapping
  END IF;
END $$;

-- What the next UHID would be, for showing on a blank form. Not reserved:
-- the real one is taken by next_uhid() when the patient is saved.
CREATE FUNCTION peek_uhid() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE u record; n int;
BEGIN
  SELECT * INTO u FROM uhid_period();
  SELECT greatest(
           coalesce((SELECT last_value FROM uhid_counters WHERE clinic_id = app_clinic_id() AND period = u.period), 0),
           coalesce((SELECT max(substring(uhid FROM length(u.prefix) + 1)::int) FROM patients
                      WHERE uhid ~ ('^' || u.prefix || '[0-9]+$')), 0)) + 1
    INTO n;
  RETURN u.prefix || lpad(n::text, u.width, '0');
END $$;

-- The counter row is locked first, so the max() below is read by one desk
-- at a time; taking the greater of the two means a patient added by an
-- import or by hand is never handed out again.
CREATE FUNCTION next_uhid() RETURNS text
LANGUAGE plpgsql AS $$
DECLARE u record; n int;
BEGIN
  SELECT * INTO u FROM uhid_period();
  INSERT INTO uhid_counters (period) VALUES (u.period) ON CONFLICT (clinic_id, period) DO NOTHING;
  PERFORM 1 FROM uhid_counters WHERE clinic_id = app_clinic_id() AND period = u.period FOR UPDATE;
  UPDATE uhid_counters
     SET last_value = greatest(last_value,
           coalesce((SELECT max(substring(uhid FROM length(u.prefix) + 1)::int) FROM patients
                      WHERE uhid ~ ('^' || u.prefix || '[0-9]+$')), 0)) + 1
   WHERE clinic_id = app_clinic_id() AND period = u.period
   RETURNING last_value INTO n;
  RETURN u.prefix || lpad(n::text, u.width, '0');
END $$;

-- ── Patients ────────────────────────────────────────────────────────────

CREATE TABLE patients (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id          uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  uhid               text NOT NULL,
  full_name          text NOT NULL CHECK (length(trim(full_name)) > 0),
  gender             text,
  date_of_birth      date CHECK (date_of_birth > '1900-01-01'),
  blood_group        text,
  occupation         text,
  marital_status     text,
  address            text,
  mobile             text,   -- format is checked where it is typed; old
                              -- records keep whatever the sheet held
  mobile_2           text,
  whatsapp           text,
  email              citext,
  emergency_name     text,
  emergency_contact  text,
  emergency_relation text,
  patient_type       text NOT NULL DEFAULT 'Normal' CHECK (patient_type IN ('Normal','Panel')),
  panel_id           uuid,
  panel_category     text CHECK (panel_category IN ('Serving','Pensioner')),
  card_id            text,
  referred_by        text,
  referred_by_type   text,
  registration_status text NOT NULL DEFAULT 'Complete' CHECK (registration_status IN ('Quick','Complete')),
  registered_on      timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  UNIQUE (clinic_id, uhid),
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, panel_id) REFERENCES panels (clinic_id, id),
  CONSTRAINT panel_patient_has_a_panel CHECK (
    (patient_type = 'Panel'  AND panel_id IS NOT NULL) OR
    (patient_type = 'Normal' AND panel_id IS NULL AND card_id IS NULL AND panel_category IS NULL)
  )
);
CREATE INDEX patients_name   ON patients (clinic_id, lower(full_name));
CREATE INDEX patients_mobile ON patients (clinic_id, mobile);
SELECT enable_tenant_table('patients');

-- Each NABH re-collection of history is a row, not a second patient.
CREATE TABLE patient_registrations (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id       uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  patient_id      uuid NOT NULL,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'Complete' CHECK (status IN ('Quick','Complete')),
  conditions      text[] NOT NULL DEFAULT '{}',
  allergies       text[] NOT NULL DEFAULT '{}',
  medicines       text,
  habits          text,       -- as the desk wrote it: "Smoking, Alcohol"
  pregnant        boolean,
  feeding_mother  boolean,
  chief_complaint text,
  pain_level      text,       -- a number 0-10 today; old records hold text
  how_known       text,
  referred_by     text,
  consent_given   boolean NOT NULL DEFAULT false,
  form            jsonb,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id) ON DELETE RESTRICT
);
CREATE INDEX patient_registrations_latest ON patient_registrations (clinic_id, patient_id, collected_at DESC);
SELECT enable_tenant_table('patient_registrations');

-- ── Appointments ────────────────────────────────────────────────────────

CREATE TABLE appointments (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id     uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  patient_id    uuid,
  patient_name  text NOT NULL,   -- a phone booking may have no patient yet
  mobile        text,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  reason        text NOT NULL,
  sub_type      text,
  doctor_id     uuid,
  chair_id      uuid,
  notes         text,
  status        text NOT NULL DEFAULT 'Scheduled'
                CHECK (status IN ('Scheduled','Checked In','In Chair','Completed','Cancelled','No Show')),
  checkin_at    timestamptz,
  engaged_at    timestamptz,
  checkout_at   timestamptz,
  cancel_reason text,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  UNIQUE (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  FOREIGN KEY (clinic_id, doctor_id)  REFERENCES doctors  (clinic_id, id),
  FOREIGN KEY (clinic_id, chair_id)   REFERENCES chairs   (clinic_id, id),
  CONSTRAINT stamps_in_order CHECK (
    (engaged_at  IS NULL OR (checkin_at IS NOT NULL AND engaged_at  >= checkin_at)) AND
    (checkout_at IS NULL OR (engaged_at IS NOT NULL AND checkout_at >= engaged_at))
  ),
  CONSTRAINT cancelled_has_a_reason CHECK (
    status <> 'Cancelled' OR length(trim(coalesce(cancel_reason, ''))) > 0
  ),
  CONSTRAINT ends_after_start CHECK (
    ends_at > starts_at AND ends_at <= starts_at + interval '8 hours'
  ),
  -- One chair cannot hold two live bookings that OVERLAP, not merely two
  -- that start at the same minute (10:00-10:45 and 10:30-11:00 clash too).
  CONSTRAINT one_patient_per_chair EXCLUDE USING gist (
    clinic_id WITH =, chair_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (chair_id IS NOT NULL AND status NOT IN ('Cancelled','No Show'))
);
CREATE INDEX appointments_day     ON appointments (clinic_id, starts_at);
CREATE INDEX appointments_patient ON appointments (clinic_id, patient_id);
SELECT enable_tenant_table('appointments');
