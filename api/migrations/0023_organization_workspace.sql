-- Standalone organization workspace; existing clinic application is untouched.
CREATE FUNCTION org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('app.organization_id',true),'')::uuid
$$;
CREATE TABLE org_identity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 id uuid NOT NULL UNIQUE, code text NOT NULL UNIQUE,
 name text NOT NULL, hostname text NOT NULL,
 timezone text NOT NULL DEFAULT 'Asia/Kolkata', currency text NOT NULL DEFAULT 'INR'
);
-- Public installation identity only. Owner can provision; runtime cannot mutate.
ALTER TABLE org_identity ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_read ON org_identity FOR SELECT USING(true);

CREATE TABLE org_units (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 code text NOT NULL, name text NOT NULL, type text NOT NULL DEFAULT 'clinic' CHECK(type='clinic'),
 UNIQUE(organization_id,id), UNIQUE(organization_id,code)
);
CREATE TABLE org_users (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 username text NOT NULL, display_name text NOT NULL, password_hash text NOT NULL,
 permissions text[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
 failed_attempts integer NOT NULL DEFAULT 0, locked_until timestamptz,
 UNIQUE(organization_id,id), UNIQUE(organization_id,username)
);
CREATE TABLE org_grants (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 user_id uuid NOT NULL, unit_id uuid NOT NULL, permissions text[] NOT NULL DEFAULT '{}',
 FOREIGN KEY(organization_id,user_id) REFERENCES org_users(organization_id,id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id),
 UNIQUE(organization_id,user_id,unit_id)
);
CREATE TABLE org_sessions (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 token_hash text NOT NULL UNIQUE, user_id uuid NOT NULL,
 expires_at timestamptz NOT NULL, FOREIGN KEY(organization_id,user_id) REFERENCES org_users(organization_id,id)
);
CREATE TABLE org_patients (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 uhid text NOT NULL, name text NOT NULL, phone text NOT NULL, gender text, dob date,
 registration_unit_id uuid NOT NULL,
 FOREIGN KEY(organization_id,registration_unit_id) REFERENCES org_units(organization_id,id),
 UNIQUE(organization_id,id), UNIQUE(organization_id,uhid)
);
CREATE TABLE org_appointments (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 unit_id uuid NOT NULL, patient_id uuid NOT NULL, doctor_id uuid NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, chair text NOT NULL DEFAULT '',
 CHECK(ends_at > starts_at),
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES org_patients(organization_id,id),
 FOREIGN KEY(organization_id,doctor_id) REFERENCES org_users(organization_id,id),
 EXCLUDE USING gist (organization_id WITH =, doctor_id WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&)
);
CREATE TABLE org_forms (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 key text NOT NULL, title text NOT NULL, form_version integer NOT NULL,
 fields jsonb NOT NULL, UNIQUE(organization_id,id), UNIQUE(organization_id,key,form_version)
);
CREATE TABLE org_form_assignments (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 form_id uuid NOT NULL, unit_id uuid NOT NULL,
 FOREIGN KEY(organization_id,form_id) REFERENCES org_forms(organization_id,id),
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id), UNIQUE(organization_id,form_id,unit_id)
);
CREATE TABLE org_submissions (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 unit_id uuid NOT NULL, patient_id uuid NOT NULL, form_id uuid NOT NULL, author_id uuid NOT NULL,
 answers jsonb NOT NULL, patient_snapshot jsonb NOT NULL,
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES org_patients(organization_id,id),
 FOREIGN KEY(organization_id,form_id) REFERENCES org_forms(organization_id,id),
 FOREIGN KEY(organization_id,author_id) REFERENCES org_users(organization_id,id), UNIQUE(organization_id,id)
);
CREATE TABLE org_notes (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 unit_id uuid NOT NULL, patient_id uuid NOT NULL, author_id uuid NOT NULL, text text NOT NULL,
 parent_id uuid, submission_id uuid, patient_snapshot jsonb NOT NULL,
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES org_patients(organization_id,id),
 FOREIGN KEY(organization_id,author_id) REFERENCES org_users(organization_id,id),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,parent_id) REFERENCES org_notes(organization_id,id),
 FOREIGN KEY(organization_id,submission_id) REFERENCES org_submissions(organization_id,id)
);
CREATE TABLE org_settings (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 unit_id uuid, key text NOT NULL, value jsonb NOT NULL,
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id),
 UNIQUE NULLS NOT DISTINCT(organization_id,unit_id,key)
);
CREATE TABLE org_receipts (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 unit_id uuid NOT NULL, patient_id uuid NOT NULL, number text NOT NULL,
 charge numeric(12,2) NOT NULL CHECK(charge>=0), paid numeric(12,2) NOT NULL CHECK(paid>=0),
 description text NOT NULL, void_reason text, voided_at timestamptz,
 patient_snapshot jsonb NOT NULL,
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES org_patients(organization_id,id),
 UNIQUE(organization_id,number)
);
CREATE TABLE org_counters (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 key text NOT NULL, value integer NOT NULL DEFAULT 0, UNIQUE(organization_id,key)
);
CREATE TABLE org_documents (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 unit_id uuid NOT NULL, patient_id uuid NOT NULL, author_id uuid NOT NULL,
 filename text NOT NULL, mime text NOT NULL, storage_key text NOT NULL UNIQUE,
 sha256 text NOT NULL, bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 1048576),
 FOREIGN KEY(organization_id,unit_id) REFERENCES org_units(organization_id,id),
 FOREIGN KEY(organization_id,patient_id) REFERENCES org_patients(organization_id,id),
 FOREIGN KEY(organization_id,author_id) REFERENCES org_users(organization_id,id)
);
CREATE TABLE org_audit (
 id uuid PRIMARY KEY DEFAULT uuidv7(), organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 actor_id uuid, unit_id uuid, action text NOT NULL, subject_id uuid
);
CREATE FUNCTION org_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
  RAISE EXCEPTION 'Organization is immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' THEN
  NEW.version:=OLD.version+1; NEW.created_at:=OLD.created_at; NEW.created_by:=OLD.created_by;
 ELSE NEW.version:=1; NEW.created_by:=app_user_id(); END IF;
 NEW.updated_at:=now(); NEW.updated_by:=app_user_id(); RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['org_units','org_users','org_grants','org_sessions','org_patients',
 'org_appointments','org_forms','org_form_assignments','org_submissions','org_notes','org_settings',
 'org_receipts','org_counters','org_documents','org_audit'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN version integer NOT NULL DEFAULT 1, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN created_by uuid, ADD COLUMN updated_by uuid',t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY organization_isolation ON %I USING(organization_id=org_id()) WITH CHECK(organization_id=org_id())',t);
  EXECUTE format('CREATE TRIGGER touch BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION org_touch()',t);
 END LOOP;
END $$;
CREATE FUNCTION org_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Finalized record is immutable' USING ERRCODE='42501'; END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON org_forms FOR EACH ROW EXECUTE FUNCTION org_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON org_notes FOR EACH ROW EXECUTE FUNCTION org_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON org_submissions FOR EACH ROW EXECUTE FUNCTION org_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON org_audit FOR EACH ROW EXECUTE FUNCTION org_immutable();
CREATE FUNCTION org_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Receipts cannot be deleted' USING ERRCODE='42501'; END IF;
 IF OLD.voided_at IS NOT NULL OR NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
 OR NEW.number IS DISTINCT FROM OLD.number OR NEW.charge IS DISTINCT FROM OLD.charge OR NEW.paid IS DISTINCT FROM OLD.paid
 OR NEW.description IS DISTINCT FROM OLD.description OR NEW.patient_snapshot IS DISTINCT FROM OLD.patient_snapshot
 OR NEW.voided_at IS NULL OR length(btrim(coalesce(NEW.void_reason,'')))=0 THEN
 RAISE EXCEPTION 'Only an explicit receipt void is allowed' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receipt_guard BEFORE UPDATE OR DELETE ON org_receipts FOR EACH ROW EXECUTE FUNCTION org_receipt_guard();
