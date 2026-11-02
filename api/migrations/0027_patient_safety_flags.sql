-- Preserve the latest existing registration/banner field; no historical values
-- are inferred, and clinical source access remains clinic-scoped.
ALTER TABLE patients ADD COLUMN safety_flags text[] NOT NULL DEFAULT '{}';
