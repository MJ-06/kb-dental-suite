-- 0013 What the clinic's sheets carry that the first design left out:
--   receipts.legacy_receipt_no  the number printed on the old e-receipt
--                               ("24-25/123" style), or MANUAL-n for lines
--                               from the manual receipt book. receipt_no stays
--                               the new system's running integer.
--   expenses.category           the Expense form's category.
ALTER TABLE receipts ADD COLUMN legacy_receipt_no text;
CREATE UNIQUE INDEX receipts_legacy_no ON receipts (clinic_id, legacy_receipt_no) WHERE legacy_receipt_no IS NOT NULL;
ALTER TABLE expenses ADD COLUMN category text;
