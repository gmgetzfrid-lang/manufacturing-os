-- 20260809_ticket_archive.sql
-- Ticket archival (Machine A, extended to closed tickets).
--
-- "Stays-listed-as-a-stub" model (chosen by the product owner): when a
-- long-closed ticket is archived to reclaim space, its WHOLE self — the row's
-- comment thread + history + metadata, the ticket_comments rows, and the
-- attachment binaries on R2 — is bundled into one cold archive, and a
-- lightweight stub (number, title, status, requester, dates) stays in the list,
-- badged "Archived". Opening it prompts the user to provide that archive. Nothing
-- is ever permanently deleted; one restore brings it all back.
--
-- Mirrors document_versions.archived_at/archive_id exactly, so the same
-- dropped-archive viewer (findInBackup) and the same archives catalog drive it.
-- Strictly additive + nullable + idempotent — safe to apply to a live DB.

alter table tickets add column if not exists archived_at timestamptz;
alter table tickets add column if not exists archive_id  text;

-- Fast lookup of an org's archived (stub) tickets — partial, so it costs nothing
-- for the overwhelmingly common hot tickets.
create index if not exists tickets_archived_idx
  on tickets(org_id, archived_at) where archived_at is not null;

comment on column tickets.archived_at is
  'When this closed ticket''s heavy content was shed to a cold archive. The row '
  'stays as a lightweight stub; the comment thread, history and attachment '
  'binaries live in archive_id. Null = fully hot/active.';
comment on column tickets.archive_id is
  'Human archive label (e.g. MOS-2026Q2-A1B2) holding this ticket''s full '
  'content once archived. Quoted to a user as the file to provide to view it.';
