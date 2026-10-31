-- 0021 Clinical forms the clinic defines itself, and what is filled into them.
--
-- A definition is one version of one form. Once published its content is never
-- edited: a change is a new version, and every submission keeps the version it
-- was filled against, so old records still read the way they were written.
-- The clinical forms in the old code are seeded as version 1 (src/forms/seed.ts),
-- and the rows already in clinical_records / clinical_sheets are linked in as
-- submissions without being moved or changed (the old tables stay as they are,
-- so today's /exec screens keep working).

CREATE TABLE form_definitions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  form_key     text NOT NULL CHECK (form_key ~ '^[a-z0-9][a-z0-9_-]{1,59}$'),
  form_version integer NOT NULL CHECK (form_version >= 1),
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'published' CHECK (status IN ('published','retired')),
  -- [{id, title, fields:[{key, label, type, required, options?, help?}]}]
  sections     jsonb NOT NULL CHECK (jsonb_typeof(sections) = 'array'),
  -- Role ids from the clinic's roles table (roles are renamable, so names are
  -- never stored). An array cannot carry a foreign key; the API checks every id
  -- belongs to this clinic when access is set. Empty means admins only.
  fill_role_ids uuid[] NOT NULL DEFAULT '{}',
  view_role_ids uuid[] NOT NULL DEFAULT '{}',
  legacy_tab   text,             -- the old tab a final save is also written to, if any
  version_note text,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  UNIQUE (clinic_id, form_key, form_version),
  UNIQUE (clinic_id, id)
);
SELECT enable_tenant_table('form_definitions');

CREATE FUNCTION form_definition_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.form_key IS DISTINCT FROM OLD.form_key
     OR NEW.form_version IS DISTINCT FROM OLD.form_version
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.sections IS DISTINCT FROM OLD.sections
     OR NEW.legacy_tab IS DISTINCT FROM OLD.legacy_tab THEN
    RAISE EXCEPTION 'A published form version cannot be changed; publish a new version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frozen BEFORE UPDATE ON form_definitions FOR EACH ROW EXECUTE FUNCTION form_definition_frozen();

CREATE TABLE form_submissions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id     uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  form_id       uuid NOT NULL,   -- the exact definition version filled
  form_key      text NOT NULL,
  form_version  integer NOT NULL,
  uhid          text NOT NULL,
  patient_id    uuid,
  "values"      jsonb NOT NULL CHECK (jsonb_typeof("values") = 'object'),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  submitted_by  uuid,            -- who finalised it
  submitted_at  timestamptz,     -- when (the imported rows carry their original time)
  legacy_record_id uuid,         -- the clinical_records / clinical_sheets row this mirrors
  legacy_source text CHECK (legacy_source IN ('record','sheet')),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  FOREIGN KEY (clinic_id, form_id) REFERENCES form_definitions (clinic_id, id),
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id),
  CHECK ((legacy_record_id IS NULL) = (legacy_source IS NULL))
);
CREATE INDEX form_submissions_patient ON form_submissions (clinic_id, upper(uhid), form_key, submitted_at DESC);
CREATE INDEX form_submissions_values ON form_submissions USING gin ("values" jsonb_path_ops);
-- Each old row is linked once, however many times the back-fill is run.
CREATE UNIQUE INDEX form_submissions_legacy ON form_submissions (clinic_id, legacy_source, legacy_record_id)
  WHERE legacy_record_id IS NOT NULL;
SELECT enable_tenant_table('form_submissions');

-- A final record is what was written on the day: not edited, not removed.
-- A mistake is corrected by a new submission.
CREATE FUNCTION form_submission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'final' THEN
      RAISE EXCEPTION 'A final form record cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'A final form record cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.form_id IS DISTINCT FROM OLD.form_id OR NEW.uhid IS DISTINCT FROM OLD.uhid THEN
    RAISE EXCEPTION 'A draft cannot move to another form or patient' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE UPDATE OR DELETE ON form_submissions FOR EACH ROW EXECUTE FUNCTION form_submission_guard();

-- Phone sessions: the sign-in page on a phone asks for a "phone" session, which
-- ends after an hour without use, and a day after sign-in whatever the use. Both
-- are the clinic's to change (clinic_settings keys phone_session_idle_minutes and
-- phone_session_hours). The absolute end is the session's expires_at, set at
-- sign-in; the idle end is checked here before session_resume() runs.
ALTER TABLE sessions ADD COLUMN kind text NOT NULL DEFAULT 'desk' CHECK (kind IN ('desk','phone'));

CREATE FUNCTION phone_session_expire(hash bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s sessions%ROWTYPE; idle integer;
BEGIN
  SELECT * INTO s FROM sessions WHERE token_hash = hash AND kind = 'phone';
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT coalesce((SELECT (value #>> '{}')::integer FROM clinic_settings
                    WHERE clinic_id = s.clinic_id AND key = 'phone_session_idle_minutes'), 60) INTO idle;
  IF s.last_seen_at < now() - make_interval(mins => greatest(idle, 1)) THEN
    DELETE FROM sessions WHERE token_hash = hash;
    RETURN true;
  END IF;
  -- Used within the idle window: record it now, not at most once a minute,
  -- so a stream of requests keeps the session alive but a pause does not.
  UPDATE sessions SET last_seen_at = now() WHERE token_hash = hash;
  RETURN false;
END $$;
