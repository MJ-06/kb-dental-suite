-- 0018 The receipt's service is free text typed at the desk (about 290 spellings
-- of a few dozen things). Keep it exactly as typed, and add a coarse group so
-- reports can count "RCT" once, not as "RCT", "RCt", "RC Open", "Obturation".
-- The import fills it from a keyword map; the desk can set it later.
ALTER TABLE receipts ADD COLUMN service_group text;
CREATE INDEX receipts_service_group ON receipts (clinic_id, service_group);
