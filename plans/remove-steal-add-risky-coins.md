# Plan: Remove Steal Mechanic, Add "Risky Coins" Bonus System

## Goal

Completely remove the buggy contact-based **steal** mechanic from DUO CHAOS and replace it
with a simpler, more fun, **zero-contact** system: **Risky Coins**.

**Risky Coins**: high-value special coins (Gold/Emerald/Diamond) periodically spawn at
announced hot-spots. Both players race to grab them. No contact, no position sampling, no
mutual-contact races, no cooldowns. Pure collection race — reuses the already-proven,
server-authoritative coin pipeline (`duo_coins` + `duo_collect_batch` + `duo_tick`).

This is the lowest-bug-risk option because it adds **no new interaction model**: it is the
existing coin system with higher-value, timed spawns.

---

## Why this is safe (root-cause elimination)

Every steal bug came from the **contact/position** model:
- attacker detection from `previous_x/y` movement samples,
- mutual-contact races between two clients,
- `last_stolen_at` cooldowns,
- client-side optimistic steal triggers.

Risky Coins have **none** of these. Collection is already:
- server-authoritative (`duo_collect_batch` validates distance ≤ 9, locks the coin row),
- atomic (single transaction, `FOR UPDATE`),
- idempotent-safe (already-collected coins are skipped),
- already synced to both clients via `duo_public_state`.

---

## Current state (verified)

- Steal RPC: [`duo_steal_versioned()`](supabase/migrations/0042_steal_authority_and_contact_guard.sql:48) + wrapper [`duo_steal()`](supabase/migrations/0042_steal_authority_and_contact_guard.sql:209).
- Steal objectives in pool: `resource-control`, `gold-robbery` in [`duo_objective_pool()`](supabase/migrations/0002_helpers.sql:33) and [`OBJECTIVE_POOL`](lib/config.ts:157).
- Client steal trigger + action: [`useGameLoop.ts`](lib/useGameLoop.ts:606) and [`useGameLoop.ts`](lib/useGameLoop.ts:913).
- Bot steal AI: [`bot.ts`](lib/bot.ts:307) `stealApproachPoints`, [`bot.ts`](lib/bot.ts:342) steal priority.
- Single-player steal: [`useBotGame.ts`](lib/useBotGame.ts:536).
- Constants: [`config.ts`](lib/config.ts:17) `STEAL_COOLDOWN_MS`, [`config.ts`](lib/config.ts:86) `STEAL_RADIUS`, [`config.ts`](lib/config.ts:140) `STEAL_TARGET`.
- Types: `ObjectiveKind = 'collect' | 'steal'` [`types.ts`](lib/types.ts:13); `stealTarget` [`types.ts`](lib/types.ts:63); `stolen`/`roundStolen` [`types.ts`](lib/types.ts:89).
- Sound: `steal` in [`sound.ts`](lib/sound.ts:15).
- Existing precedent: `jackpot` chaos event already spawns a diamond at center in [`duo_tick()`](supabase/migrations/0005_rpc_chaos.sql:90).
- Coin pipeline: [`duo_spawn_wave()`](supabase/migrations/0002_helpers.sql:151), [`duo_coin_value()`](supabase/migrations/0002_helpers.sql:87), [`duo_collect_batch()`](supabase/migrations/0041_objective_epochs_and_batch_collect.sql:69).
- Coin visuals already exist: `.coin-gold/.coin-blue/.coin-red/.coin-emerald/.coin-diamond` in [`globals.css`](app/globals.css:1410).

---

## Design: Risky Coins

### Gameplay rules

1. **Spawn cadence**: every ~15s during battle, a "Risky Coin" spawns at a deterministic
   hot-spot (rotating among 3-4 fixed arena positions, e.g. center, top-mid, bottom-mid).
2. **Value**: Risky Coins are worth a large bonus:
   - Risky Gold = 40 pts, Risky Emerald = 45 pts, Risky Diamond = 60 pts.
   - (Normal coins stay 5/15/25/50.)
3. **Lifetime**: a Risky Coin despawns after ~8s if uncollected (server removes it), so it is
   a genuine race — miss it and it is gone.
4. **Announcement**: when one spawns, both clients show a banner ("Risky Coin! +40") and a
   pulsing marker on the arena. This is the "fun" hook.
5. **No contact**: players simply run to it and collect it via the existing collect path.
6. **First-come-first-served**: the coin row is locked; only one player can collect it.

### Why it is fun

- Creates **contested hot-spots** (both players converge) without any contact logic.
- Adds **timed urgency** (despawn) and **big score swings** (40-60 pts).
- Reuses the existing "diamond pop" celebration pattern for satisfying feedback.

### Implementation approach (minimal, additive)

**Server (new migration `0051_risky_coins.sql`)**:
- Add a `risky` boolean column to `duo_coins` (default false) — or reuse `coin_id >= 2000`
  range as the marker (no schema change). **Prefer the `coin_id` range** to avoid schema
  churn: Risky Coins use ids `2000 + round*100 + wave`.
- Add `duo_spawn_risky_coin(p_room, p_round, p_wave)` that inserts one high-value coin at a
  deterministic hot-spot with `respawn_at = now + 8000` (despawn deadline).
- Extend [`duo_tick()`](supabase/migrations/0005_rpc_chaos.sql:37): every ~15s spawn a risky
  coin; delete risky coins whose `respawn_at` passed and were not collected.
- Extend [`duo_coin_value()`](supabase/migrations/0002_helpers.sql:87): risky ids → 40/45/60.
- Extend [`duo_collect_batch()`](supabase/migrations/0041_objective_epochs_and_batch_collect.sql:69):
  risky coins never respawn (like diamond) — set `respawn_at = 0` on collect.
- **Remove steal**: replace `duo_steal_versioned` body with a no-op returning
  `{ok:false, reason:'removed'}` and revoke execute; keep the wrapper for compatibility or
  drop it. Replace steal objectives in `duo_objective_pool()` with collect objectives.

**Client**:
- [`config.ts`](lib/config.ts:157): remove `resource-control` + `gold-robbery`; add 2 new
  collect objectives to keep the pool at 8. Remove `STEAL_COOLDOWN_MS`, `STEAL_RADIUS`,
  `STEAL_TARGET`.
- [`types.ts`](lib/types.ts:13): `ObjectiveKind = 'collect'` (or keep union but unused);
  remove `stealTarget`.
- [`useGameLoop.ts`](lib/useGameLoop.ts:606): delete the steal trigger block and the steal
  action block ([`useGameLoop.ts`](lib/useGameLoop.ts:913)); remove `lastSteal` ref.
- [`useBotGame.ts`](lib/useBotGame.ts:536): delete both steal blocks.
- [`bot.ts`](lib/bot.ts:307): delete `stealApproachPoints` and the steal-priority branch;
  bot just targets the highest-value coin (risky coins get top priority via `coinPriority`).
- [`sound.ts`](lib/sound.ts:15): keep `steal` sound but repurpose as `risky` (or add `risky`).
- [`Battle.tsx`](components/game/Battle.tsx:528): render risky coins with a pulsing class;
  add a "Risky Coin!" banner.
- [`globals.css`](app/globals.css:1399): add `.coin-risky` pulse animation.
- [`useDuoChaos.ts`](lib/useDuoChaos.ts:1068): remove the `offSteal` handler and `steal`
  broadcast.
- [`Home.tsx`](components/game/Home.tsx:93): update copy ("steal from your rival" → "race for
  risky coins").
- [`seo.ts`](lib/seo.ts:20): update tagline.

**Tests**:
- Delete/replace [`test-steal-authority.mjs`](scripts/test-steal-authority.mjs:1) with
  `test-risky-coins.mjs` covering: spawn cadence, value, despawn, first-come-first-served,
  no-respawn, objective pool has no steal kind.

---

## Migration / rollout strategy

1. **DB first** (backward compatible): add risky-coin spawn + value + despawn; neutralize
   `duo_steal_versioned`. Old clients calling steal simply get `{ok:false}`.
2. **Client second**: remove steal UI/logic, add risky-coin rendering + banner.
3. **Objectives**: swap steal objectives for collect objectives in both `config.ts` and
   `duo_objective_pool()` in the same release (they must stay in sync).
4. **Cleanup**: remove now-dead constants/types/refs.

**Non-destructive**: keep `duo_players.stolen`, `round_stolen`, `last_stolen_at`,
`previous_x/y` columns in place (unused) to avoid a risky schema migration. They can be
dropped in a later cleanup migration once the client no longer references them.

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Objective pool desync (client vs server) | Update both in the same commit; add a test asserting the pools match. |
| Risky coin never despawns | `duo_tick` deletes uncollected risky coins past `respawn_at`. |
| Both clients collect same risky coin | Existing `FOR UPDATE` lock + `collected_by` check already prevents this. |
| Old client still calls steal | RPC returns `{ok:false}`; client ignores. |
| `stolen` counter still shown in UI | Remove from HUD/results, or leave at 0. |

---

## Verification

- `node scripts/test-risky-coins.mjs` — all checks pass.
- `npx tsc --noEmit` — clean.
- `npx next build` — success.
- Apply migration live via `scripts/apply-migration.mjs`.
- Manual: two-client battle shows risky coin spawn, banner, race, despawn, correct score.
