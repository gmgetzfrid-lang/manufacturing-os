-- Workspace names are IDENTITIES, not labels: globally unique, case- and
-- whitespace-insensitive. Two "Kern Energy" workspaces can never exist —
-- enforced by the database itself, not just the signup form, so no code
-- path (signup race, import, admin tooling) can ever create a twin.
--
-- If this index fails to create with "could not create unique index",
-- duplicates already exist. Find them with:
--
--   SELECT lower(btrim(name)) AS key, count(*), array_agg(id) AS org_ids
--   FROM orgs GROUP BY 1 HAVING count(*) > 1;
--
-- then delete/rename the empty twin(s) and re-run this migration.

CREATE UNIQUE INDEX IF NOT EXISTS orgs_name_unique_ci
  ON orgs (lower(btrim(name)));
