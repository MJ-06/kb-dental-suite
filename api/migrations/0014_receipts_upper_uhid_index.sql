-- 0014 A patient's balance matches receipts on upper(uhid), which the plain
-- (clinic_id, uhid) index cannot serve.
CREATE INDEX receipts_patient_upper ON receipts (clinic_id, upper(uhid));
