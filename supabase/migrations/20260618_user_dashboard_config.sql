-- Per-user customizable dashboard layout.
--
-- Stores the widget list + per-widget settings for each user's home
-- dashboard. Nullable: a NULL value means "use the app default layout"
-- (Document Control + Drafting Requests), so existing users are unaffected
-- until they customize. The app also mirrors this to localStorage, so the
-- feature works before this migration is applied and upgrades to
-- cross-device persistence once it is.
alter table public.users
  add column if not exists dashboard_config jsonb;

comment on column public.users.dashboard_config is
  'Per-user home dashboard layout: { version, widgets: [{ id, type, width, settings }] }. NULL = app default.';
