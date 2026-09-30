# DUO CHAOS — Supabase backend

The game is **server-authoritative**: the browser only ever calls RPCs, never
touches tables directly. All migrations live in [`migrations/`](migrations/) and
are applied in filename order.

## Apply the migrations

Using the Supabase CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste each file into the Supabase SQL editor in order (`0001` → `0008`).

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
| `duo_create_room` | `p_code, p_token` | Host creates a room (slot 1) |
| `duo_join_room` | `p_code, p_token` | Join as slot 2 (idempotent reconnect) |
| `duo_leave` | `p_code, p_token` | Leave; deletes the room when empty |
| `duo_rematch` | `p_code, p_token` | Flag ready; resets to lobby when both ready |
| `duo_public_state` | `p_code, p_token` | Authoritative snapshot (objectives redacted) |

### Gameplay
| RPC | Args | Purpose |
|---|---|---|
| `duo_move` | `p_code, p_token, p_x, p_y` | Update position (countdown/battle only) |
| `duo_collect` | `p_code, p_token, p_coin_id` | Claim a coin within range; scores it |
| `duo_steal` | `p_code, p_token` | Steal from an adjacent opponent |
| `duo_start_round` | `p_code, p_token` | Host starts countdown; assigns objectives |
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
| `duo_set_cosmetics` | `p_client_id, p_emote, p_trail` | Choose unlocked cosmetics |
| `duo_apply_cosmetics` | `p_code, p_token, p_emote, p_trail` | Copy cosmetics onto the player row |

## Authoritative rules

- **Scoring** happens only in `duo_collect` / `duo_steal` / `duo_advance_phase`.
- **Winner** is decided only in `duo_advance_phase` at match end.
- **Chaos events** are triggered only in `duo_tick` and stored on the room row,
  so both clients observe the same rules.
- **Objective secrecy** is enforced in `duo_public_state`: the opponent's
  objective is `null` unless the caller has scouted (`revealed_hint` set).
- **Coin waves** and the **magnet drift** are applied server-side in `duo_tick`.

## Housekeeping

`duo_cleanup()` deletes rooms idle for more than 2 hours. Schedule it with
`pg_cron` if available:

```sql
select cron.schedule('duo-cleanup', '*/15 * * * *', $$select duo_cleanup()$$);
```
