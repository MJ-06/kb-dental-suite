-- 0017 A system log row can be resolved once and nothing else about it can change,
-- whoever asks (the column grants already stop the app role; this stops a mistake in
-- the app itself, and a second resolve overwriting who did the first).
CREATE FUNCTION system_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.level <> 'error' OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'A system log row cannot be changed once resolved' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.clinic_id, NEW.happened_at, NEW.level, NEW.kind, NEW.ref, NEW.action, NEW.status, NEW.message, NEW.detail, NEW.user_id)
     IS DISTINCT FROM
     (OLD.id, OLD.clinic_id, OLD.happened_at, OLD.level, OLD.kind, OLD.ref, OLD.action, OLD.status, OLD.message, OLD.detail, OLD.user_id) THEN
    RAISE EXCEPTION 'Only the resolution of a system log row can be set' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard BEFORE UPDATE ON system_log FOR EACH ROW EXECUTE FUNCTION system_log_guard();
