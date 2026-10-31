-- 0019 Where a receipt's service came from: 'typed' (the desk wrote it), 'register' (filled from the
-- Daily Register's procedure for that patient and day), or 'register_near' (the nearest visit within
-- three days, for a payment taken the day before or after the work was written up). NULL where no
-- service is known. Filled services are suggestions that can be undone by clearing this column's rows.
ALTER TABLE receipts ADD COLUMN service_source text CHECK (service_source IN ('typed','register','register_near'));
