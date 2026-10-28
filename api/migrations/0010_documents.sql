-- 0010 Patient documents: scans, X-rays, reports and generated PDFs.
-- The file itself lives in storage under an opaque key; this row is what the
-- patient's folder lists, and what the clinic can account for.
CREATE TABLE patient_documents (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id   uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  uhid        text NOT NULL,
  patient_id  uuid,
  file_name   text NOT NULL,
  mime_type   text NOT NULL,
  category    text NOT NULL DEFAULT 'Other',
  storage_key text NOT NULL,
  size_bytes  integer NOT NULL CHECK (size_bytes >= 0),
  doc_key     text,                -- fingerprint of a generated document, so a reprint is not filed twice
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,         -- removed from the folder; the file is kept, so it can be recovered
  deleted_by  uuid,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  FOREIGN KEY (clinic_id, patient_id) REFERENCES patients (clinic_id, id)
);
CREATE INDEX patient_documents_patient ON patient_documents (clinic_id, upper(uhid)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX patient_documents_doc_key ON patient_documents (clinic_id, upper(uhid), doc_key)
  WHERE doc_key IS NOT NULL AND deleted_at IS NULL;
SELECT enable_tenant_table('patient_documents');
