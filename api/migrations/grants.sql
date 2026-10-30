-- Re-applied after every migration run, so a new table can never be left
-- without the right privileges. Idempotent.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kb_app;
GRANT USAGE ON SCHEMA public TO kb_app;

-- Day-to-day work on clinic tables. RLS decides which rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kb_app;

-- The tenant registry is reached only through clinic_profile(),
-- begin_login() and session_resume(): it holds other clinics' database links.
REVOKE ALL ON clinics FROM kb_app;

-- The audit log is append only.
REVOKE UPDATE, DELETE ON audit_log FROM kb_app;

-- Counters move only through next_uhid().
REVOKE DELETE ON uhid_counters FROM kb_app;

-- Receipts are never removed, and their numbers only move through
-- next_receipt_no(). A mistake is corrected by a new entry, not erased.
REVOKE DELETE ON receipts, receipt_counters FROM kb_app;

-- A consent is what the patient agreed to on the day; it is never edited or removed.
REVOKE UPDATE, DELETE ON consents FROM kb_app;

-- The bookkeeping table is the migrator's.
REVOKE ALL ON schema_migrations FROM kb_app;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO kb_app;

-- The system log is append only; an admin may only mark an open failure resolved.
REVOKE UPDATE, DELETE ON system_log FROM kb_app;
GRANT UPDATE (resolved_at, resolved_by, resolution) ON system_log TO kb_app;
