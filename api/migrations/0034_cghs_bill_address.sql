-- An issued bill keeps its address snapshot. Never backfill historical bills
-- from today's patient address, which may already have changed.
ALTER TABLE cghs_bills ADD COLUMN address text NOT NULL DEFAULT '';
