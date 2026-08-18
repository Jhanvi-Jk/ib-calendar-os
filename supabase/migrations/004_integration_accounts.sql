-- ============================================================================
-- 004_integration_accounts.sql
--
-- OAuth credentials for connected providers.
--
-- SECURITY POSTURE: this table has RLS enabled and NO policy granting access.
-- That is deliberate, not an oversight — with RLS on and no policy, every
-- browser session (anon and authenticated alike) reads zero rows. Only the
-- service-role client, used exclusively by server-side sync jobs and webhook
-- handlers, can touch it. A refresh token is a long-lived key to the user's
-- entire calendar; it should never be reachable from a page.
-- ============================================================================

create table integration_accounts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  provider         calendar_provider not null,

  provider_user_id text,
  provider_email   text,

  access_token     text,
  refresh_token    text,
  token_expires_at timestamptz,
  scopes           text[] not null default '{}',

  -- Set when the provider rejects our refresh token (revoked access, password
  -- change). The UI prompts a reconnect instead of retrying forever.
  needs_reauth     boolean not null default false,
  last_error       text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (user_id, provider)
);

create trigger integration_accounts_updated_at
  before update on integration_accounts
  for each row execute function set_updated_at();

alter table integration_accounts enable row level security;
-- Intentionally no policies. See the note at the top of this file.

-- ---------------------------------------------------------------------------
-- Sync bookkeeping the pull loop needs but 003 did not anticipate.
-- ---------------------------------------------------------------------------

alter table sync_state
  add column if not exists sync_in_progress boolean not null default false,
  add column if not exists consecutive_failures int not null default 0;

-- A Google event we deleted locally must be remembered long enough for the
-- next incremental pull to not resurrect it. Deleting the mapping outright
-- would make the event look brand new on the following sync.
alter table sync_mappings
  add column if not exists deleted_locally boolean not null default false;

create index if not exists sync_mappings_pending_delete_idx
  on sync_mappings (user_id, provider)
  where deleted_locally;
