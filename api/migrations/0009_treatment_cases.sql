-- 0009 The procedure library and treatment cases.

-- Each clinic's own list of procedures and the stages they break into. It
-- starts as a copy of the standard list the first time the clinic opens it,
-- and is the clinic's to edit from then on.
CREATE TABLE procedure_library (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id          uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  ord                integer NOT NULL,
  procedure_code     text NOT NULL,
  procedure_name     text NOT NULL,
  family_code        text NOT NULL DEFAULT '',
  visits_min         integer NOT NULL DEFAULT 0,
  visits_max         integer NOT NULL DEFAULT 0,
  sequence_no        integer NOT NULL,
  stage_type         text NOT NULL DEFAULT '',
  stage_code         text NOT NULL,
  stage_name         text NOT NULL,
  completes_treatment boolean NOT NULL DEFAULT false,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  UNIQUE (clinic_id, procedure_code, sequence_no)
);
SELECT enable_tenant_table('procedure_library');

-- A patient's course of treatment for one procedure. The stages are a copy
-- of the library's at the moment the case opened, then changed as the
-- patient's treatment actually goes; the current and next stage are worked
-- out from them, never stored.
CREATE TABLE treatment_cases (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id     uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  case_ref      text NOT NULL,          -- AL1001-RCT-01
  uhid          text NOT NULL,
  patient_id    uuid,
  patient_name  text,
  procedure_code text NOT NULL,
  procedure_name text NOT NULL,
  family_code   text NOT NULL DEFAULT '',
  tooth_ref     text,
  case_status   text NOT NULL DEFAULT 'in_progress' CHECK (case_status IN ('in_progress','completed')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  visit_counter integer NOT NULL DEFAULT 0,
  stages        jsonb NOT NULL DEFAULT '[]',
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  UNIQUE (clinic_id, case_ref),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
CREATE INDEX treatment_cases_patient ON treatment_cases (clinic_id, upper(uhid), procedure_code);
SELECT enable_tenant_table('treatment_cases');
