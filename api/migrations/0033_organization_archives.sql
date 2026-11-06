-- Archives are organization-wide recovery copies, never removal of live records.
CREATE TABLE org_archive_runs (
 id uuid PRIMARY KEY DEFAULT uuidv7(),
 organization_id uuid NOT NULL DEFAULT org_id() REFERENCES org_identity(id),
 kind text NOT NULL CHECK(kind IN ('manual','scheduled')),
 archive_day date NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','expired')),
 started_at timestamptz, finished_at timestamptz,
 file_count integer, total_bytes bigint, dump_sha256 text,
 error_code text,
 destination_kind text CHECK(destination_kind IN ('drive','folder')),
 destination_ref text, destination_parent text, destination_checksum text,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid, updated_by uuid
);
CREATE UNIQUE INDEX org_archive_one_active ON org_archive_runs(organization_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX org_archive_scheduled_day ON org_archive_runs(organization_id,archive_day) WHERE kind='scheduled';
CREATE INDEX org_archive_recent ON org_archive_runs(organization_id,created_at DESC);
CREATE TABLE org_archive_worker (
 organization_id uuid PRIMARY KEY DEFAULT org_id() REFERENCES org_identity(id),
 heartbeat_at timestamptz NOT NULL DEFAULT now(),
 destination text NOT NULL,
 ready boolean NOT NULL DEFAULT false,
 last_error text
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['org_archive_runs','org_archive_worker'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY organization_isolation ON %I USING(organization_id=org_id()) WITH CHECK(organization_id=org_id())',t);
 END LOOP;
END $$;
CREATE TRIGGER touch BEFORE INSERT OR UPDATE ON org_archive_runs FOR EACH ROW EXECUTE FUNCTION org_touch();
