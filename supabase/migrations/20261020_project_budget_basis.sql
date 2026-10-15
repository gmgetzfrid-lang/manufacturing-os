-- Project BUDGET BASIS: the authorization a project's money hangs from.
--
-- Most projects start from a document that authorizes the spend — an AFE,
-- a capital request, an approved estimate. Its number, the account the
-- spend books to, and the authorized total are the facts every cost
-- conversation refers back to ("are we inside the AFE?"). They live on the
-- project; the document itself is kept as a cost_documents row with
-- kind = 'budget' (kind has no CHECK constraint, so no change needed
-- there), and budget_doc_id points at it.
--
-- All nullable, additive, idempotent. Code tolerates the columns being
-- absent (writes retry without them), so applying this late loses nothing
-- but the header line on the Costs tab.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS afe_number TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS charge_account TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS authorized_amount NUMERIC;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_doc_id UUID REFERENCES cost_documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN projects.afe_number IS 'Authorization number (AFE / capital request / estimate no.) the project''s spend is approved under.';
COMMENT ON COLUMN projects.charge_account IS 'Account / GL / cost-center code the spend books to, as printed on the authorization.';
COMMENT ON COLUMN projects.authorized_amount IS 'Total amount authorized. Budget lines should sum to it; spend is measured against it.';
COMMENT ON COLUMN projects.budget_doc_id IS 'The cost_documents row (kind=budget) holding the authorization paper and its extraction.';
