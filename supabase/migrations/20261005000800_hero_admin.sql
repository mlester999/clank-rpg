-- Clank RPG — hero management for admins.
--
-- The RPG display name already exists as characters.name (generated) + characters.name_override (admin/player
-- choice); every read path shows coalesce(name_override, name). This migration only adds what hero management
-- needs around it. A rename is PRESENTATION ONLY: it never touches telegram_user_id, the character id, class,
-- stats, claims, wallets or history.

alter table public.characters
  add column admin_note text check (admin_note is null or char_length(admin_note) <= 500),
  -- Who last set the RPG name. 'PLAYER' is reserved for a future, restricted self-service rename.
  add column name_changed_at timestamptz,
  add column name_changed_by text check (name_changed_by is null or name_changed_by in ('ADMIN', 'PLAYER'));

-- Defence in depth behind the application-level validation: no control characters in a chosen name.
alter table public.characters
  add constraint characters_name_override_clean check (name_override is null or name_override !~ '[[:cntrl:]]');

select public.clank_harden_schema();
