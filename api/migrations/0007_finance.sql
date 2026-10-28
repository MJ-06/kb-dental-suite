-- 0007 Receipts, expenses and the treatment plan estimate that balances
-- are measured against.

-- One counter per clinic. The receipt number is the clinic's own running
-- series (the sheet's "E. Receipt No."); it never restarts and never reuses
-- a number, so a cancelled receipt leaves a visible gap.
CREATE TABLE receipt_counters (
  clinic_id  uuid PRIMARY KEY DEFAULT app_clinic_id() REFERENCES clinics(id),
  last_value integer NOT NULL DEFAULT 0 CHECK (last_value >= 0)
);
ALTER TABLE receipt_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipt_counters
  USING (clinic_id = app_clinic_id()) WITH CHECK (clinic_id = app_clinic_id());

-- Locks the clinic's counter row, so two desks never take the same number.
-- Taking the greater of the counter and the highest receipt already stored
-- keeps imported receipts from being handed out again.
CREATE FUNCTION next_receipt_no() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  INSERT INTO receipt_counters (clinic_id) VALUES (app_clinic_id()) ON CONFLICT (clinic_id) DO NOTHING;
  UPDATE receipt_counters
     SET last_value = greatest(last_value, coalesce((SELECT max(receipt_no) FROM receipts), 0)) + 1
   WHERE clinic_id = app_clinic_id()
   RETURNING last_value INTO n;
  RETURN n;
END $$;

-- A payment taken. The form allows two payment modes and two amounts (part
-- cash, part UPI); the screens add them up, so both are kept.
CREATE TABLE receipts (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  receipt_no   integer NOT NULL,
  receipt_date date NOT NULL,          -- the clinic's own day
  patient_id   uuid,
  uhid         text,
  patient_name text,
  service      text,
  mode1        text,
  amount1      numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount1 >= 0),
  mode2        text,
  amount2      numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount2 >= 0),
  remarks      text,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  UNIQUE (clinic_id, receipt_no),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
CREATE INDEX receipts_day ON receipts (clinic_id, receipt_date);
CREATE INDEX receipts_patient ON receipts (clinic_id, uhid);
SELECT enable_tenant_table('receipts');

-- Money out. A deleted expense is voided, not removed: the audit log keeps
-- the row either way, but the books should still show it was there.
CREATE TABLE expenses (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  expense_date date NOT NULL,
  paid_by      text,
  expense_name text,
  amount       numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  mode         text,
  remarks      text,
  legacy_id    text,                   -- EXP-… for expenses imported from the sheet
  voided_at    timestamptz,
  voided_by    uuid,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid
);
CREATE INDEX expenses_day ON expenses (clinic_id, expense_date);
CREATE UNIQUE INDEX expenses_legacy_id ON expenses (clinic_id, legacy_id) WHERE legacy_id IS NOT NULL;
SELECT enable_tenant_table('expenses');

-- The treatment plan: one per patient, rows as the screen builds them and
-- the estimate whose total balances are measured against.
CREATE TABLE treatment_plans (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  patient_id   uuid,
  uhid         text NOT NULL,
  patient_name text,
  plan_date    text,
  plan_rows    jsonb,
  estimate     jsonb,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  UNIQUE (clinic_id, uhid),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
SELECT enable_tenant_table('treatment_plans');
