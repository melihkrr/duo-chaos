# DUO CHAOS — Supabase backend

The game is **server-authoritative**: the browser only ever calls RPCs, never
touches tables directly. All migrations live in [`migrations/`](migrations/) and
are applied in filename order.

## Apply the migrations

### Option A — automated (no CLI login required)

The repo ships two Node scripts that connect straight to the project's
Postgres instance using the database password. They are handy when the
Supabase CLI is not authenticated or Docker is unavailable.

```bash
# Apply a single migration file (wraps in a transaction).
set SUPABASE_DB_PASSWORD=<db-password>
pnpm db:apply supabase/migrations/0010_lobby_readiness.sql

# DESTRUCTIVE: drops every duo_* object and reapplies all migration files.
# This deletes all active rooms, player rows, events, coins, and progression.
set SUPABASE_DB_PASSWORD=<db-password>
pnpm db:reset

# Smoke-test every RPC the client calls (18 assertions, no password needed).
pnpm db:test
```

Both migration scripts send `notify pgrst, 'reload schema'` when they finish.
`pnpm db:test` drives a full match lifecycle over the REST API and asserts the
responses, so it doubles as a regression check after any schema change.

`pnpm db:apply` executes SQL directly and does not add an entry to
`supabase_migrations.schema_migrations`. The numbered repository migrations
must therefore be checked against the live schema (or explicitly reconciled
with Supabase's migration history) before relying on `supabase db push`.

Environment variables (all optional except the password):

| Variable | Default | Purpose |
|---|---|---|
| `SUPABASE_DB_PASSWORD` | — | **Required.** Database password |
| `SUPABASE_PROJECT_REF` | `fanrtyidfhdhlaskwrid` | Project ref |
| `SUPABASE_DB_HOST` | `aws-0-us-east-1.pooler.supabase.com` | Override host |
| `SUPABASE_DB_PORT` | `5432` | Override port |
| `SUPABASE_DB_USER` | `postgres.<ref>` | Override user |

### Option B — Supabase CLI

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

### Option C — SQL editor

Paste each file into the Supabase SQL editor in filename order, through the
latest migration (`0050`).

> **Important:** the migrations must actually be applied to the project the
> client points at. If they are not, every RPC call fails with
> `Could not find the function public.duo_* in the schema cache`.
>
> `pnpm db:reset` is destructive and removes all `duo_*` data. Do not use it
> as a routine migration command. For an existing project, apply only the
> missing migration files after checking the current schema.

### Troubleshooting: "Could not find the function … in the schema cache"

PostgREST resolves RPCs by **argument name**, so the JSON keys the client sends
must match the SQL parameter names exactly. The client always sends:

| Client key | SQL parameter |
|---|---|
| `p_code` | `p_code` |
| `p_token` | `p_token` |
| `p_x`, `p_y` | `p_x`, `p_y` |
| `p_coin_id` | `p_coin_id` |
| `p_client_id` | `p_client_id` |
| `p_xp` | `p_xp` |
| `p_emote`, `p_trail` | `p_emote`, `p_trail` |
| `p_name` | `p_name` |

If you see an error naming a parameter that is **not** in the table above
(e.g. `duo_create_room(p_code, p_player)`), either:

1. the migrations were never applied — run `supabase db push` (or paste the
   files), then reload the PostgREST schema cache with
   `notify pgrst, 'reload schema';`, **or**
2. an older client build is cached — hard-refresh the browser.

After applying migrations, force a schema-cache reload:

```sql
notify pgrst, 'reload schema';
```

## Environment

The client reads these variables (see [`.env.example`](../.env.example)):

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes* | Publishable / anon key |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes* | Fallback name for the anon key |

\* one of the two key variables must be set.

## RPC surface

### Room lifecycle
| RPC | Args | Purpose |
|---|---|---|
| `duo_create_room` | `p_code, p_token, p_name` | Host creates a room (slot 1) with a display name |
| `duo_join_room` | `p_code, p_token, p_name` | Join as slot 2 (idempotent reconnect) with a display name |
| `duo_set_name` | `p_code, p_token, p_name` | Change the caller's display name while in a room |
| `duo_leave` | `p_code, p_token` | Leave; deletes the room when empty |
| `duo_rematch` | `p_code, p_token` | Flag ready; resets to lobby when both ready |
| `duo_public_state` | `p_code, p_token` | Authoritative snapshot (both objectives, names, avatars, and `playerCount`) |

### Gameplay
| RPC | Args | Purpose |
|---|---|---|
| `duo_move` | `p_code, p_token, p_x, p_y` | Update position (countdown/battle only) |
| `duo_collect_batch` | `p_code, p_token, p_coin_ids, p_x, p_y, p_expected_objectives_done, p_expected_round` | Atomically claim nearby coins and return authoritative progress |
| `duo_collect` | `p_code, p_token, p_coin_id` | Compatibility wrapper for a single-coin claim |
| `duo_steal_versioned` | `p_code, p_token, p_expected_objectives_done, p_expected_round` | Versioned, server-validated steal action |
| `duo_steal` | `p_code, p_token` | Compatibility wrapper for a steal action |
| `duo_start_round` | `p_code, p_token` | Host starts countdown; assigns objectives. Returns `{ok:false, reason}` (e.g. `not_ready`) instead of raising when the rival has not joined yet |
| `duo_advance_phase` | `p_code, p_token` | countdown→battle→results/matchover |
| `duo_tick` | `p_code, p_token` | World clock: chaos events, waves, magnet |

### Guess/Read
| RPC | Args | Purpose |
|---|---|---|
| `duo_scout` | `p_code, p_token` | Spend a charge to reveal a partial hint |

### Progression & cosmetics
| RPC | Args | Purpose |
|---|---|---|
| `duo_get_progress` | `p_client_id` | Fetch/create a profile |
| `duo_award_progress` | `p_client_id, p_xp` | Add XP, return new profile |
| `duo_set_cosmetics` | `p_client_id, p_emote, p_trail, p_avatar` | Choose unlocked cosmetics |
| `duo_apply_cosmetics` | `p_code, p_token, p_emote, p_trail, p_avatar` | Copy cosmetics onto the player row |

## Authoritative rules

- **Scoring** happens only in `duo_collect_batch` / `duo_steal_versioned` and
  server-owned round/match transitions.
- **Winner** is decided by the server when the final round ends.
- **Chaos events** are triggered only in `duo_tick` and stored on the room row,
  so both clients observe the same rules.
- **Objectives** are public in `duo_public_state`; `duo_scout` provides a
  partial hint only for the separate Guess/Read mechanic.
- **Coin waves** and the **magnet drift** are applied server-side in `duo_tick`.
- **Display names** are stored on the player row (`duo_players.name`, capped at
  16 chars) and exposed for both players in `duo_public_state`. Clients also
  broadcast a `name` realtime event for instant updates, but the snapshot is the
  source of truth.

## Housekeeping

`duo_cleanup()` deletes rooms idle for more than 2 hours. Schedule it with
`pg_cron` if available:

```sql
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'duo-cleanup',
  '*/15 * * * *',
  'select public.duo_cleanup();'
);
```

The configured Supabase project has this job enabled: it runs every 15 minutes
and removes rooms whose `updated_at` is older than 2 hours. Scheduling by job
name updates the existing `duo-cleanup` job instead of creating duplicates.
