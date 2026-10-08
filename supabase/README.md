# Supabase

All schema lives in `migrations/` as plain, ordered SQL (`YYYYMMDDHHMMSS_name.sql`). Nothing depends on dashboard-only changes.

| File | Contents |
| --- | --- |
| `…000100_foundation.sql` | helpers, `game_settings`, `character_classes`, `skills`, `ruleset_snapshots`, `feature_flags`, `seasons`, `admin_audit_log` |
| `…000200_telegram.sql` | `telegram_users`, `telegram_updates`, `telegram_messages` (features only — never text), daily activity, reactions, login proofs |
| `…000300_characters_and_economy.sql` | `characters` (+class permanence trigger), stats, appearances, special profiles, claims, wallet challenges/links, **Clank Gold** ledger + triggers, items/inventory, achievements |
| `…000400_chain.sql` | `eligible_tokens`, holdings, Diamond Hands streaks/milestones, trade rollups, `boss_drafts` (+ approval guard) |
| `…000500_arena.sql` | `arena_state`, cycles, persisted queue, battles (frozen once simulated/settled), participants, seasonal stats |
| `…000600_security_hardening.sql` | `clank_harden_schema()`: RLS on every table, no API-role access. **End every future migration with `select public.clank_harden_schema();`** |
| `…20261008002400_arena_chat.sql` | **Arena Chat** (docs/ARENA_CHAT.md): `arena_chat_messages` (durable history, keyset `id`, moderation `deleted_at`/`rev`), `arena_chat_mutes` (private reasons), indexes, and — only where a Supabase `realtime` schema exists — the listen-only Realtime policy for the private channel `arena-chat`. Server-only tables: RLS on, no policies, no API-role privileges |

## Applying them (no Docker)

```bash
# 1. Either: the project's runner (also seeds reference data; compatible with the Supabase CLI ledger)
DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres" pnpm db:migrate

# 2. Or: the Supabase CLI directly against the remote database (no local stack needed)
npx supabase db push --db-url "$DATABASE_URL"
```

Both record progress in `supabase_migrations.schema_migrations`, so they can be mixed.

## Security model in one paragraph

The browser never queries Supabase directly. Every table has RLS **enabled with no policies** and all privileges revoked from `anon`/`authenticated`; the Next.js server connects with a privileged connection string (`postgres`/`service_role`, both bypass RLS). If you later expose a table to the browser (e.g. Realtime), add an explicit, reviewed policy — `tests/security/rls.test.ts` will fail until you update its allow-list on purpose. (The Arena Chat exposes **no table**: browsers receive Realtime *broadcasts* of messages the server has already saved, under a listen-only policy on `realtime.messages` — see docs/ARENA_CHAT.md.)
