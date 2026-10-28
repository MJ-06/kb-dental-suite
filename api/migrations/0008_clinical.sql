-- 0008 Clinical records: the flat forms, the tooth charts, care plans and
-- consents.

-- Every flat form (Pathology, Radiology, Restoration, Prescriptions ...) is a
-- row on a named tab. The headings are the clinic's own and differ per form
-- and over time, so the values are kept as one JSON object keyed by heading;
-- the patient and the time they were recorded are real columns.
CREATE TABLE clinical_records (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  tab_name    text NOT NULL,
  uhid        text NOT NULL,
  patient_id  uuid,
  fields      jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
CREATE INDEX clinical_records_patient ON clinical_records (clinic_id, tab_name, upper(uhid), recorded_at);
SELECT enable_tenant_table('clinical_records');

-- The tooth chart behind the RCT, Implant and Crown & Bridge sheets: all of a
-- patient's teeth for one sheet type, saved together.
CREATE TABLE clinical_sheets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  uhid         text NOT NULL,
  patient_id   uuid,
  patient_name text,
  sheet_type   text NOT NULL DEFAULT '',
  all_teeth    jsonb,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  UNIQUE (clinic_id, uhid, sheet_type),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
SELECT enable_tenant_table('clinical_sheets');

-- The four-page care plan: one per patient.
CREATE TABLE care_plans (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  uhid         text NOT NULL,
  patient_id   uuid,
  patient_name text,
  plan_date    text,
  page1        jsonb,
  page2        jsonb,
  page3        jsonb,
  page4        jsonb,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  UNIQUE (clinic_id, uhid),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
SELECT enable_tenant_table('care_plans');

-- A signed consent. Append only: what the patient agreed to is never edited.
CREATE TABLE consents (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  uhid         text NOT NULL,
  patient_id   uuid,
  patient_name text,
  consent_date text,
  procedure    text,
  language     text,
  soap         text,
  med_history  text,
  fee          text,
  pay_terms    text,
  extra_proc   text,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
CREATE INDEX consents_patient ON consents (clinic_id, upper(uhid));
SELECT enable_tenant_table('consents');
