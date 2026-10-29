-- 0012 Keep secrets out of the audit log: password hashes and the values of
-- password settings were being copied into before/after rows. Also scrubs
-- rows already written.

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  before_j jsonb := CASE WHEN TG_OP <> 'INSERT' THEN audit_scrub(TG_TABLE_NAME, to_jsonb(OLD)) END;
  after_j  jsonb := CASE WHEN TG_OP <> 'DELETE' THEN audit_scrub(TG_TABLE_NAME, to_jsonb(NEW)) END;
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

CREATE FUNCTION audit_scrub(tbl name, j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN tbl = 'app_users' THEN j - 'password_hash'
    WHEN tbl = 'clinic_settings' AND j->>'key' ILIKE '%password%' THEN j - 'value'
    ELSE j
  END
$$;

-- The owner is subject to FORCE RLS, so lift it for this one statement.
ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY;
UPDATE audit_log SET
  before_row = audit_scrub(table_name, before_row),
  after_row  = audit_scrub(table_name, after_row)
WHERE table_name IN ('app_users', 'clinic_settings');
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
