-- 0016 System log: what failed, and who to ask. An unexpected failure is written
-- here (in a transaction of its own, since the failed one rolled back) with a short
-- reference the screen shows, so "Something went wrong, E-7K2Q9X" can be traced.
-- It stores the action, the status and a scrubbed message: never patient values,
-- never request bodies. 'info' rows record things an admin should be able to
-- account for later, such as a data export. Rows are never deleted by the app;
-- an admin marks a failure resolved.
CREATE TABLE system_log (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  clinic_id    uuid NOT NULL DEFAULT app_clinic_id() REFERENCES clinics(id),
  happened_at  timestamptz NOT NULL DEFAULT now(),
  level        text NOT NULL CHECK (level IN ('error','info')),
  kind         text NOT NULL,             -- 'legacy_action', 'rest', 'export', ...
  ref          text,                      -- E-XXXXXX, shown to the user for errors
  action       text,                      -- the action or route that was running
  status       integer,
  message      text,                      -- scrubbed, at most 300 characters
  detail       jsonb,                     -- code, constraint, top of the stack
  user_id      uuid DEFAULT app_user_id(),
  resolved_at  timestamptz,
  resolved_by  uuid,
  resolution   text
);
CREATE UNIQUE INDEX system_log_ref ON system_log (clinic_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX system_log_time ON system_log (clinic_id, happened_at DESC);
CREATE INDEX system_log_open ON system_log (clinic_id, happened_at DESC) WHERE level = 'error' AND resolved_at IS NULL;

ALTER TABLE system_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON system_log
  USING (clinic_id = app_clinic_id()) WITH CHECK (clinic_id = app_clinic_id());
