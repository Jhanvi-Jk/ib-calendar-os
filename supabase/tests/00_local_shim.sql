-- ============================================================================
-- Local test shim.
--
-- Reproduces just enough of Supabase's managed `auth` schema to let the real
-- migrations run against a bare Postgres cluster. This is NEVER applied to a
-- Supabase project — it lives outside supabase/migrations/ for that reason.
--
-- Purpose: schema changes get executed and verified on every edit, without
-- requiring Docker.
-- ============================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id                   uuid primary key default gen_random_uuid(),
  email                text unique,
  raw_user_meta_data   jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

-- In production this reads the request JWT. Locally it reads a GUC so tests
-- can impersonate a user with: set local request.jwt.claim.sub = '<uuid>';
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create extension if not exists pgcrypto;
