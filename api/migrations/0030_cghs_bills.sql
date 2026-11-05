CREATE TABLE cghs_bill_counters (
 clinic_id uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
 period text NOT NULL CHECK(period ~ '^[0-9]{6}$'),
 last_value integer NOT NULL CHECK(last_value>0), PRIMARY KEY(clinic_id,period)
);
SELECT enable_tenant_table('cghs_bill_counters');
CREATE TABLE cghs_bills (
 id uuid PRIMARY KEY DEFAULT uuidv7(),
 clinic_id uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
 patient_id uuid NOT NULL, uhid text NOT NULL, bill_no text NOT NULL,
 bill_date date NOT NULL, patient_name text NOT NULL, panel text NOT NULL DEFAULT '',
 card_id text NOT NULL DEFAULT '', panel_category text NOT NULL DEFAULT '',
 amount numeric(12,2) NOT NULL CHECK(amount>=0), lines jsonb NOT NULL DEFAULT '[]',
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 UNIQUE(clinic_id,bill_no), FOREIGN KEY(clinic_id,patient_id) REFERENCES patients(clinic_id,id)
);
SELECT enable_tenant_table('cghs_bills');
