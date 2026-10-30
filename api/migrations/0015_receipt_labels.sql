-- 0015 Per-clinic receipt numbering. 'sequential' prints the running integer
-- (receipts.receipt_no). 'fy' prints a number per financial year ("26-27/45"),
-- which K.B. Dental's old e-receipts use: the new number is the highest in that
-- year plus one, so imported numbers continue instead of restarting at 1. The
-- printed number lives in receipts.legacy_receipt_no for both old and new rows.
ALTER TABLE clinics ADD COLUMN receipt_scheme text NOT NULL DEFAULT 'sequential' CHECK (receipt_scheme IN ('sequential','fy'));

-- clinics is closed to the app role, so the scheme is read through this one function.
CREATE FUNCTION clinic_receipt_scheme() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT receipt_scheme FROM clinics WHERE id = app_clinic_id()
$$;

CREATE FUNCTION next_receipt_label(d date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE scheme text; y int; prefix text; n int;
BEGIN
  scheme := clinic_receipt_scheme();
  IF scheme IS DISTINCT FROM 'fy' THEN RETURN NULL; END IF;
  y := CASE WHEN extract(month FROM d) >= 4 THEN extract(year FROM d)::int ELSE extract(year FROM d)::int - 1 END;
  prefix := lpad((y % 100)::text, 2, '0') || '-' || lpad(((y + 1) % 100)::text, 2, '0') || '/';
  PERFORM pg_advisory_xact_lock(hashtextextended(app_clinic_id()::text || prefix, 0));
  SELECT coalesce(max(substring(legacy_receipt_no FROM length(prefix) + 1)::int), 0) + 1 INTO n
    FROM receipts WHERE legacy_receipt_no ~ ('^' || prefix || '[0-9]+$');
  RETURN prefix || n;
END $$;
