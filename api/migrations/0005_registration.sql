-- 0005 Registration: UHIDs handed out before the form is saved, and the
-- pending list of patients who filled the iPad form but are not yet seen.

-- Today's registration screen asks for a UHID, shows it, and only then
-- saves the patient under it. getNextUHID therefore takes a real number from
-- next_uhid() and records it here; saving a NEW patient is allowed only
-- under a UHID that was handed out this way and not used. A number shown on
-- a form that was then abandoned is simply never used: a gap, never a
-- duplicate.
CREATE TABLE uhid_reservations (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  uhid        text NOT NULL,
  reserved_by uuid DEFAULT app_user_id(),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  UNIQUE (clinic_id, uhid)
);
ALTER TABLE uhid_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE uhid_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON uhid_reservations
  USING (clinic_id = app_clinic_id()) WITH CHECK (clinic_id = app_clinic_id());

-- The iPad form's waiting list. Each row is the form as submitted; it goes
-- when the desk registers that mobile number.
CREATE TABLE pending_registrations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  mobile       text,
  form         jsonb NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid
);
CREATE INDEX pending_registrations_mobile ON pending_registrations (clinic_id, mobile);
SELECT enable_tenant_table('pending_registrations');
