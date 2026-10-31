-- 0022 Where each clinic keeps its attachments: the server's folder (the default,
-- needs no row), an S3-compatible bucket, or Google Drive. One row per backend a
-- clinic has set up, one of them active; a switch never strands old files because
-- each document remembers which backend holds it.
CREATE TABLE clinic_storage (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  kind        text NOT NULL CHECK (kind IN ('s3','drive')),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- bucket, region, folder name: nothing secret
  secret_enc  text,                                  -- access keys / Drive credentials, sealed (see src/secrets.ts)
  active      boolean NOT NULL DEFAULT false,
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_message text,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  UNIQUE (clinic_id, kind)
);
-- At most one active backend per clinic; none active means the server folder.
CREATE UNIQUE INDEX clinic_storage_one_active ON clinic_storage (clinic_id) WHERE active;
SELECT enable_tenant_table('clinic_storage');

-- Which backend holds each file, where inside it (Drive's file id), and its checksum.
ALTER TABLE patient_documents
  ADD COLUMN storage_backend text NOT NULL DEFAULT 'local' CHECK (storage_backend IN ('local','s3','drive')),
  ADD COLUMN storage_ref     text,
  ADD COLUMN checksum_sha256 text CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$');
CREATE INDEX patient_documents_backend ON patient_documents (clinic_id, storage_backend);

-- Sealed credentials are still credentials: keep them out of the audit log's before/after copies.
CREATE OR REPLACE FUNCTION audit_scrub(tbl name, j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN tbl = 'app_users' THEN j - 'password_hash'
    WHEN tbl = 'clinic_settings' AND j->>'key' ILIKE '%password%' THEN j - 'value'
    WHEN tbl = 'clinic_storage' THEN j - 'secret_enc'
    ELSE j
  END
$$;
