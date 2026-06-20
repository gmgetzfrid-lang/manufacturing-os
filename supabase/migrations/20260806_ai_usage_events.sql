-- AI usage metering — one row per /api/ai call, so an admin can SEE how hard
-- the shared Gemini key is being hit. This is the "measure first" step of the
-- AI-safeguards track (per-org limits come later, once we can see the load).
--
-- Additive and fail-safe: if this insert ever fails, the AI call is unaffected.

create table if not exists ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  org_id uuid,
  op text not null,
  provider text,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_events_created_idx on ai_usage_events(created_at desc);

-- Written by the /api/ai route and read by the admin storage API, both via the
-- service role (which bypasses RLS). No anon/user access.
alter table ai_usage_events enable row level security;
revoke all on ai_usage_events from public, anon, authenticated;
