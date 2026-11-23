-- Controlled links: send documents to people outside the company.
--
-- A link (document_shares) can now carry several documents, name who it is
-- for, ask for a 6-digit code before anything shows, and allow or refuse
-- downloading a copy. Links are made, changed and turned off only by the
-- server (/api/share/create, /api/share/revoke), which checks the sender
-- can open every document on the link. Before this, any member could insert
-- a link for ANY document in the workspace straight from the browser, even
-- one they can't open.
--
--   items          [{documentId, markupPath}] the documents on the link.
--                  Null on links made before this: the one document_id.
--   document_ids   the same document ids, for finding a document's links.
--   recipient      who it is for ("John, ABC Contractors").
--   allow_download false = view in the browser only. Older links: true.
--   code_hash      scrypt hash of the code (never the code). Null = no code.
--   code_failures  wrong codes so far; 10 locks the link for good.
--
-- download_audits.source says whether a served copy was a view or a
-- download ("share_view", "share_download", "..._markup"). The share
-- route already sent this column; where it was missing, those rows were
-- not saved.
--
-- Members can still READ their workspace's links (the Send sheet lists them
-- through the server), but not the code hash (a 6-digit code is too short
-- to keep from someone holding its hash) and not the link itself (token):
-- a member who can't open a document must not get it through a colleague's
-- link. The server shows a link's address only to the person who made it.
--
-- Until this runs, links already sent keep working as before; making a new
-- link says to run this file. Safe to run more than once.

begin;

alter table public.document_shares add column if not exists items jsonb;
alter table public.document_shares add column if not exists document_ids uuid[];
alter table public.document_shares add column if not exists recipient text;
alter table public.document_shares add column if not exists allow_download boolean not null default true;
alter table public.document_shares add column if not exists code_hash text;
alter table public.document_shares add column if not exists code_failures integer not null default 0;

create index if not exists document_shares_document_ids_idx
  on public.document_shares using gin (document_ids);

comment on column public.document_shares.items is
  'Documents on the link: [{documentId, markupPath}]. markupPath is the sender''s marked-up copy (orgs/<org>/shares/...). Null = the single document_id (links made before 20261123).';
comment on column public.document_shares.code_hash is
  'scrypt hash of the 6-digit code, salted with the token. Never the code. Null = no code asked.';
comment on column public.document_shares.code_failures is
  'Wrong codes entered. At 10 the link is locked.';

alter table if exists public.download_audits add column if not exists source text;

-- Members read; only the server (service role) writes.
drop policy if exists document_shares_org_member on public.document_shares;
drop policy if exists document_shares_member_read on public.document_shares;
create policy document_shares_member_read on public.document_shares
  for select
  using (
    exists (
      select 1 from public.org_members
      where org_members.org_id = document_shares.org_id
        and org_members.uid = auth.uid()
        and org_members.status = 'active'
    )
  );

-- Every column but the token and the code hash. A column added to this
-- table later needs adding here too, or members won't see it.
revoke insert, update, delete on public.document_shares from anon, authenticated;
revoke select on public.document_shares from anon, authenticated;
grant select (
  id, org_id, document_id, created_by, created_by_name, created_at,
  expires_at, revoked_at, revoked_by, note, access_count, access_last_at, access_last_ip,
  items, document_ids, recipient, allow_download, code_failures
) on public.document_shares to authenticated;
grant all on public.document_shares to service_role;

-- The open counter is the server's to bump (it was callable by anyone).
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'bump_share_access'
  ) then
    revoke execute on function public.bump_share_access(uuid) from public, anon, authenticated;
    grant execute on function public.bump_share_access(uuid) to service_role;
  end if;
end $$;

commit;

notify pgrst, 'reload schema';
