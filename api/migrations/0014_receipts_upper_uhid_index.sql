-- 0014 The balance queries match receipts on upper(uhid), which the plain
-- (clinic_id, uhid) index cannot serve. On the first real load the outstanding
-- list took 850 ms for 220 plans against 1,700 receipts and would grow with
-- every receipt.
CREATE INDEX receipts_patient_upper ON receipts (clinic_id, upper(uhid));
