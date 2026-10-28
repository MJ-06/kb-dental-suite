-- 0011 The CRM's collections and the registration lead inbox.

-- The CRM keeps nine lists (pipelines, leads, contacts ...) and saves a whole
-- list at a time. Each record is stored as the screen built it: its fields
-- are the CRM's to extend, so they are JSON, with the record's own id kept
-- beside it.
CREATE TABLE crm_records (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id  uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  collection text NOT NULL CHECK (collection IN
               ('pipelines','leads','contacts','companies','followups','products','activities','payments','sources')),
  position   integer NOT NULL,
  data       jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE INDEX crm_records_collection ON crm_records (clinic_id, collection, position);
SELECT enable_tenant_table('crm_records');

-- Patients registered at the desk and waiting to become leads. The CRM saves
-- a list by rewriting it, so the desk adds here, to a table the CRM never
-- rewrites, and the CRM drains it when it next loads.
CREATE TABLE crm_lead_inbox (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id          uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  inbox_ref          text NOT NULL,      -- the id the screen holds
  uhid               text,
  name               text,
  mobile             text,
  panel              text,
  panel_category     text,
  card_id            text,
  referred_by        text,
  referred_by_type   text,
  taken_at           timestamptz,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  UNIQUE (clinic_id, inbox_ref)
);
-- A patient is queued once, however often the desk saves them.
CREATE UNIQUE INDEX crm_lead_inbox_uhid ON crm_lead_inbox (clinic_id, upper(uhid)) WHERE uhid IS NOT NULL AND uhid <> '';
SELECT enable_tenant_table('crm_lead_inbox');
