ALTER TABLE cghs_bill_counters
 ADD COLUMN id uuid NOT NULL DEFAULT uuidv7(),
 ADD COLUMN version integer NOT NULL DEFAULT 1,
 ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN created_by uuid,
 ADD COLUMN updated_by uuid;
