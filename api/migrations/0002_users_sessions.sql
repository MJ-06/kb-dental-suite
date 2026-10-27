-- 0002 Staff accounts and sessions.
--
-- Login is clinic code + username + password. One hash is checked per
-- attempt, and five failures lock the account for fifteen minutes.
--
-- Sessions store only a SHA-256 of the token. The token itself lives in an
-- HttpOnly cookie, so reading this table does not let anyone sign in.

CREATE TABLE app_users (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id       uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  username        citext NOT NULL CHECK (username ~ '^[a-z0-9._-]{2,40}$'),
  display_name    text NOT NULL,
  password_hash   text NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','doctor','reception','accounts')),
  active          boolean NOT NULL DEFAULT true,
  failed_attempts smallint NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  UNIQUE (clinic_id, username),
  UNIQUE (clinic_id, id)
);
SELECT enable_tenant_table('app_users');

-- RLS is enabled but NOT forced here: the owner's session_resume() below
-- must find a token before it knows the clinic. kb_app is still filtered.
CREATE TABLE sessions (
  token_hash   bytea PRIMARY KEY,
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  user_id      uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (clinic_id, user_id) REFERENCES app_users (clinic_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (clinic_id = app_clinic_id())
  WITH CHECK (clinic_id = app_clinic_id());

-- Starts a login: finds the clinic by its code and makes it the
-- transaction's tenant. Returns NULL for an unknown or inactive clinic.
-- The caller then reads app_users through RLS like any other table.
CREATE FUNCTION begin_login(clinic_code text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid;
BEGIN
  SELECT id INTO cid FROM clinics WHERE code = lower(clinic_code) AND active;
  IF cid IS NOT NULL THEN
    PERFORM set_config('app.clinic_id', cid::text, true);
  END IF;
  RETURN cid;
END $$;

-- Resumes a session from a token hash: sets the clinic and the user for
-- this transaction and returns who they are. No row means signed out:
-- expired, revoked, user deactivated or clinic deactivated.
CREATE FUNCTION session_resume(hash bytea)
RETURNS TABLE (user_id uuid, clinic_id uuid, role text, display_name text, username text, timezone text)
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
    SELECT u.id, u.clinic_id, u.role, u.display_name, u.username::text, c.timezone
      FROM app_users u JOIN clinics c ON c.id = u.clinic_id
     WHERE u.id = s.user_id AND u.active AND c.active;
END $$;
