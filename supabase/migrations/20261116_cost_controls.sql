-- Cost controls you can change after the fact, on the record.
--
-- 1. Co-owners edit a project's costs like its owner (budget lines, quotes,
--    POs, invoices, change orders, checklists, turnover and punch items):
--    user_owns_project() now counts a co-owner (project_members role
--    'co_owner', 20261113) as well as the owner. Org Admins, Managers,
--    Supervisors and Document Control keep their org-wide rights.
-- 2. projects.afe_history: each change to the AFE (number, charge account,
--    authorized amount, document) with when, who and why.
-- 3. cost_accounts.budget_history: each change to a budget line's budget,
--    with when, who and why.
--
-- 0. The AFE's own columns (from 20261020_project_budget_basis.sql, which
--    wasn't run here: the AFE number and authorized amount read from the
--    document had nowhere to go).
--
-- Safe to run more than once. Changes no existing data.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS afe_number TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS charge_account TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS authorized_amount NUMERIC;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget_doc_id UUID REFERENCES cost_documents(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION user_owns_project(p_project UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM projects p
    JOIN org_members m
      ON m.org_id = p.org_id AND m.uid = auth.uid() AND m.status = 'active'
    WHERE p.id = p_project AND (
      p.owner_user_id = auth.uid()
      OR EXISTS (SELECT 1 FROM project_members pm
                 WHERE pm.project_id = p.id AND pm.user_id::text = auth.uid()::text AND pm.role = 'co_owner')
    )
  );
$$;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS afe_history JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN projects.afe_history IS 'Each change to the AFE: [{at, by, afeNumber, chargeAccount, authorized, docId, note}], oldest first.';

ALTER TABLE cost_accounts ADD COLUMN IF NOT EXISTS budget_history JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN cost_accounts.budget_history IS 'Each change to the line''s budget: [{at, by, from, to, note}], oldest first.';

NOTIFY pgrst, 'reload schema';
