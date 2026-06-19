-- Web Push subscriptions — powers scheduled reminders (overdue/aging
-- scratchpad to-dos, etc.) that reach you even when the app is closed.
--
-- One row per browser/device the user opted in from. The reminder cron
-- (service role) reads every row; users manage only their own via RLS.

create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  org_id uuid,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_reminded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;

-- A user can see/insert/delete only their own subscriptions. The cron sender
-- uses the service role, which bypasses RLS.
drop policy if exists push_sub_select_own on push_subscriptions;
create policy push_sub_select_own on push_subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists push_sub_insert_own on push_subscriptions;
create policy push_sub_insert_own on push_subscriptions
  for insert with check (auth.uid() = user_id);

drop policy if exists push_sub_delete_own on push_subscriptions;
create policy push_sub_delete_own on push_subscriptions
  for delete using (auth.uid() = user_id);
