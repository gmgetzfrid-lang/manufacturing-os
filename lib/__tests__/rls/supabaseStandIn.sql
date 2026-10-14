-- The Supabase stand-in the database harness replays the repository onto
-- (intelligence I-17; AREA-1, IRLS-6, INTK-14, CB-2). Run by the cluster's
-- superuser (`supabase_admin`, as on Supabase) inside the scratch database
-- BEFORE supabase/schema.sql. It is a test fixture, never a migration: it
-- lives outside supabase/ so DB-8's single-source rule never sees it, and it
-- defines nothing in the public schema.
--
-- What it reproduces, and why each piece matters to a replay:
--   * the roles PostgREST uses: anon, authenticated (no BYPASSRLS),
--     service_role (BYPASSRLS), and the authenticator login granted all
--     three (20261184 looks it up by name);
--   * `postgres` as the hosted project has it: a NON-superuser that owns the
--     database and the public schema and holds BYPASSRLS — so SECURITY
--     DEFINER functions behave as they do on Supabase (they bypass RLS
--     because their owner does, not because a superuser owns them);
--   * Supabase's default privileges: everything postgres creates in public is
--     granted to anon, authenticated and service_role (and functions keep
--     PostgreSQL's PUBLIC EXECUTE) — the grant state INTK-14's census reads;
--   * the auth schema: auth.users, auth.identities and auth.uid() /
--     auth.role() / auth.email() / auth.jwt() reading the request.jwt.claims
--     setting exactly as PostgREST sets it, so `SET LOCAL ROLE authenticated`
--     plus `set_config('request.jwt.claims', …, true)` IS a signed-in caller;
--   * the supabase_realtime publication (migrations add tables to it);
--   * pgvector created by the superuser up front (Supabase's supautils lets
--     postgres create it; plain PostgreSQL does not, so the migration's own
--     CREATE EXTENSION IF NOT EXISTS is then a no-op, as on a project where
--     the extension is enabled).

DO $roles$
BEGIN
  IF to_regrole('postgres') IS NULL THEN
    CREATE ROLE postgres LOGIN CREATEROLE CREATEDB REPLICATION BYPASSRLS;
  END IF;
  IF to_regrole('anon') IS NULL THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF to_regrole('authenticator') IS NULL THEN CREATE ROLE authenticator LOGIN NOINHERIT; END IF;
END
$roles$;

GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO postgres;

DO $owner$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO postgres', current_database()); END $owner$;
ALTER SCHEMA public OWNER TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;

CREATE TABLE IF NOT EXISTS auth.users (
  instance_id uuid,
  id uuid PRIMARY KEY,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  phone text,
  banned_until timestamptz,
  is_sso_user boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  is_anonymous boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS auth.identities (
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text NOT NULL,
  last_sign_in_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  email text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  UNIQUE (provider_id, provider)
);

GRANT SELECT, REFERENCES ON auth.users, auth.identities TO postgres;
GRANT ALL ON auth.users, auth.identities TO service_role;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email(), auth.jwt()
  TO anon, authenticated, service_role, postgres;

DO $pub$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$pub$;
ALTER PUBLICATION supabase_realtime OWNER TO postgres;

DO $vector$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector SCHEMA public;
  END IF;
END
$vector$;
