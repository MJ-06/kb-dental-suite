-- 0020 Roles belong to the clinic. Until now a user's role was one of four words
-- fixed in code. Now each clinic has its own roles table, seeded with a copy of
-- the four built-in roles, and an admin can add, rename and re-tick them.
--
-- What a permission means stays in code (api/src/auth/permissions.ts); a role
-- only stores which permission names it holds. A name the code no longer knows
-- is ignored when a session is resumed, so retiring a permission is safe.
--
-- users:manage (never checked anywhere) becomes roles:manage, the permission
-- that opens the "Roles & access" page and that makes someone an administrator.

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  name        citext NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 2 AND 40),
  permissions text[] NOT NULL DEFAULT '{}',
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  UNIQUE (clinic_id, name),
  UNIQUE (clinic_id, id)
);
SELECT enable_tenant_table('roles');

ALTER TABLE app_users ADD COLUMN role_id uuid;

-- Every existing clinic gets the four built-in roles (the working defaults of
-- 28 Oct), and each user moves to the role of the same name.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT id FROM clinics LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    INSERT INTO roles (name, permissions) VALUES
      ('admin', ARRAY['patients:read','patients:write','appointments:read','appointments:write',
                      'clinical:read','clinical:write','payments:collect','finance:read','finance:write',
                      'masters:write','roles:manage','audit:read','reports:read']),
      ('doctor', ARRAY['patients:read','patients:write','appointments:read','appointments:write',
                       'clinical:read','clinical:write']),
      ('reception', ARRAY['patients:read','patients:write','appointments:read','appointments:write',
                          'payments:collect']),
      ('accounts', ARRAY['patients:read','appointments:read','payments:collect','finance:read','finance:write']);
    UPDATE app_users u SET role_id = r.id FROM roles r WHERE r.clinic_id = u.clinic_id AND r.name = u.role;
  END LOOP;
  PERFORM set_config('app.clinic_id', '', true);
END $$;

ALTER TABLE app_users ALTER COLUMN role_id SET NOT NULL;
-- A role in use cannot be deleted: the staff on it would have no rights at all.
ALTER TABLE app_users ADD FOREIGN KEY (clinic_id, role_id) REFERENCES roles (clinic_id, id) ON DELETE RESTRICT;
CREATE INDEX app_users_role ON app_users (clinic_id, role_id);
ALTER TABLE app_users DROP COLUMN role;

-- The role (and what it allows) now comes from the clinic's roles table.
DROP FUNCTION session_resume(bytea);
CREATE FUNCTION session_resume(hash bytea)
RETURNS TABLE (user_id uuid, clinic_id uuid, role_id uuid, role text, permissions text[],
               display_name text, username text, timezone text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM sessions WHERE token_hash = hash AND expires_at > now();
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM set_config('app.clinic_id', s.clinic_id::text, true);
  PERFORM set_config('app.user_id', s.user_id::text, true);

  -- Touch at most once a minute, so reads are not all writes.
  UPDATE sessions SET last_seen_at = now()
   WHERE token_hash = hash AND last_seen_at < now() - interval '1 minute';

  RETURN QUERY
    SELECT u.id, u.clinic_id, r.id, r.name::text, r.permissions, u.display_name, u.username::text, c.timezone
      FROM app_users u
      JOIN roles r ON r.clinic_id = u.clinic_id AND r.id = u.role_id
      JOIN clinics c ON c.id = u.clinic_id
     WHERE u.id = s.user_id AND u.active AND c.active;
END $$;
