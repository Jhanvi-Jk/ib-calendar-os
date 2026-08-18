-- ============================================================================
-- 005_context_hydration.sql
--
-- Roadmap step 20. Lets a task carry a pointer to wherever the work actually
-- lives — an Obsidian note, a Google Doc, a repository path — so entering
-- focus mode opens the context instead of making the student go find it.
--
-- Stored as a URI rather than a file path so obsidian://, vscode:// and
-- https:// are all expressible without a separate type column.
-- ============================================================================

alter table tasks
  add column if not exists context_uri text,
  add column if not exists context_label text;

-- Reject anything that isn't a URI we are prepared to hand to the browser.
-- javascript: and data: URIs in particular must never reach an href.
alter table tasks add constraint tasks_context_uri_scheme check (
  context_uri is null
  or context_uri ~* '^(https?|obsidian|vscode|file|notion|zotero)://'
);

alter table user_settings
  add column if not exists focus_hides_navigation boolean not null default true,
  add column if not exists focus_autostart_timer boolean not null default true;
