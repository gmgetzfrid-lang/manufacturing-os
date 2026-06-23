-- Archive foundation (Machine A): archive identity + designated local location.
--
-- The spine that lets the system (a) give every backup/archive a stable name an
-- admin can quote to a user, (b) record WHERE those archives physically live, and
-- (c) mark a document version's binary as shed-to-cold-archive while keeping all
-- its metadata forever. Nothing here deletes anything — it's the bookkeeping the
-- space-saver and the view-on-demand flow build on.
--
-- All additive and nullable, so applying it is safe on a live DB.

-- 1. Where this org keeps its archives, and how they're named. One row per org.
--    Shown to admins when they back up, and to any user who's asked to provide an
--    archive to view an out-of-range file.
create table if not exists archive_settings (
  org_id uuid primary key references orgs(id) on delete cascade,
  location_hint text,                 -- e.g. "Network drive \\\\fileserver\\backups\\mos" or "Fireproof safe, labeled SSD"
  naming text,                        -- optional human convention, e.g. "MOS-<year>Q<quarter>-<id>"
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- 2. Catalog of every archive this org has produced (full backup or space pull).
--    archive_id is the human label quoted in prompts ("provide archive MOS-2026Q2-a1b2").
create table if not exists archives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  archive_id text not null,           -- human label, unique within the org
  kind text not null default 'full' check (kind in ('full','space')),
  note text,
  file_count int not null default 0,
  total_bytes bigint not null default 0,
  created_by uuid,
  created_by_email text,
  created_at timestamptz not null default now()
);
create unique index if not exists archives_org_label_uniq on archives(org_id, archive_id);
create index if not exists archives_org_created_idx on archives(org_id, created_at desc);

-- 3. Mark a version's binary as shed to a cold archive. The row, checksum, size
--    and original storage key all STAY — only the bytes leave R2. archived_at set
--    => "open this and you'll be asked to provide `archive_id` to view it".
alter table document_versions add column if not exists archived_at timestamptz;
alter table document_versions add column if not exists archive_id text;
create index if not exists document_versions_archived_idx on document_versions(org_id, archived_at) where archived_at is not null;

-- Access: written/read by service-role API routes (which bypass RLS) after the
-- route has authorized the caller. No direct anon/user access to the two new
-- tables. (document_versions keeps its existing RLS; the new columns inherit it.)
alter table archive_settings enable row level security;
alter table archives enable row level security;
revoke all on archive_settings from public, anon, authenticated;
revoke all on archives from public, anon, authenticated;
