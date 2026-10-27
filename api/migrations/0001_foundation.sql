-- 0001 Foundation: clinics, the tenant context, row housekeeping, audit.
--
-- Every clinic-owned table follows the same four rules, set up here and
-- applied to each table with enable_tenant_table():
--   1. clinic_id NOT NULL, filled from the transaction's tenant setting.
--   2. Row level security, FORCED, so even the table owner is filtered.
--   3. version / created_* / updated_* maintained by trigger, never by the app.
--   4. Every insert, update and delete written to audit_log.
--
-- The app connects as kb_app, which owns nothing and cannot bypass RLS.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- overlap rules on bookings

-- ── Tenant context ──────────────────────────────────────────────────────
-- Set per transaction by the API with set_config(..., true), so a pooled
-- connection never carries one clinic's id into the next request. Unset
-- means NULL, and NULL matches no row: forgetting to set it fails closed.

CREATE FUNCTION app_clinic_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.clinic_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- ── Clinics (the tenant registry) ───────────────────────────────────────
-- Not tenant-scoped: it IS the list of tenants. kb_app may read a clinic
-- only through the functions below, never list them all.

CREATE TABLE clinics (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  name          text NOT NULL,
  -- How this clinic numbers patients:
  --   year-month  KB's scheme: two letters for the year (AA = 2015), the
  --               month, then that month's running number: AE0117.
  --   sequential  uhid_prefix and a running number: AB0001.
  uhid_scheme   text NOT NULL DEFAULT 'year-month' CHECK (uhid_scheme IN ('year-month','sequential')),
  uhid_prefix   text NOT NULL DEFAULT '' CHECK (uhid_prefix ~ '^[A-Z]{0,4}$'),
  -- Dates (today's appointments, a receipt's day) are the clinic's dates,
  -- not the server's. A UTC server would otherwise file everything after
  -- 17:30 IST under tomorrow.
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  -- NULL: this shared database. Set: the clinic lives in its own database.
  database_url  text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Today, in the current clinic's own timezone.
CREATE FUNCTION clinic_today() RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (now() AT TIME ZONE c.timezone)::date FROM clinics c WHERE c.id = app_clinic_id()
$$;

-- ── Housekeeping trigger ────────────────────────────────────────────────

CREATE FUNCTION touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version    := 1;
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.created_by := app_user_id();
    NEW.updated_by := app_user_id();
  ELSE
    IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id THEN
      RAISE EXCEPTION 'A row cannot move to another clinic' USING ERRCODE = '42501';
    END IF;
    NEW.version    := OLD.version + 1;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := app_user_id();
  END IF;
  RETURN NEW;
END $$;

-- ── Audit log ───────────────────────────────────────────────────────────
-- Append only. kb_app may insert (through the trigger) and read its own
-- clinic's rows; it is never granted UPDATE or DELETE.

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  user_id     uuid,
  happened_at timestamptz NOT NULL DEFAULT now(),
  table_name  text NOT NULL,
  row_id      uuid,
  action      text NOT NULL CHECK (action IN ('insert','update','delete')),
  before_row  jsonb,
  after_row   jsonb
);
CREATE INDEX audit_log_row ON audit_log (clinic_id, table_name, row_id, happened_at DESC);
CREATE INDEX audit_log_time ON audit_log (clinic_id, happened_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (clinic_id = app_clinic_id())
  WITH CHECK (clinic_id = app_clinic_id());

CREATE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  before_j jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  after_j  jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
BEGIN
  INSERT INTO audit_log (clinic_id, user_id, table_name, row_id, action, before_row, after_row)
  VALUES (
    coalesce((after_j->>'clinic_id')::uuid, (before_j->>'clinic_id')::uuid),
    app_user_id(),
    TG_TABLE_NAME,
    coalesce((after_j->>'id')::uuid, (before_j->>'id')::uuid),
    lower(TG_OP),
    before_j,
    after_j
  );
  RETURN NULL;
END $$;

-- ── One call makes a table a tenant table ───────────────────────────────

CREATE FUNCTION enable_tenant_table(t regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (clinic_id = app_clinic_id()) WITH CHECK (clinic_id = app_clinic_id())', t);
  EXECUTE format(
    'CREATE TRIGGER touch BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION touch_row()', t);
  EXECUTE format(
    'CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit_row()', t);
END $$;
