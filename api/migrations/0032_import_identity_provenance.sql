-- Historical records can identify a person without a complete registration.
-- Preserve missing classification as NULL rather than manufacturing "Normal".
ALTER TABLE patients ALTER COLUMN patient_type DROP NOT NULL;
ALTER TABLE patients ADD COLUMN import_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE org_patients ADD COLUMN import_review_required boolean NOT NULL DEFAULT false;
