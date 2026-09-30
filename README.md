# DUO CHAOS

A 2-player realtime party duel. See → Guess → Grab the resource → Break their plan → Finish your secret mission → Win → Rematch.

## Core loop

1. **See** — both players share one arena with limited resources.
2. **Guess** — each player has a *secret objective*. Use the **Read rival** action (2 charges, 8s cooldown) to reveal a partial hint about your opponent's mission.
3. **Grab** — collect coins. Coin value depends on your objective and the active chaos event.
4. **Break** — bump into your rival to steal a coin and slow them down.
5. **Finish** — complete your secret mission before the 90s round timer ends.
6. **Win** — best of 3 rounds. Then **rematch**.

## Architecture

The game is **server-authoritative**. The client is optimistic for feel, but never decides score, mission completion, or the winner.

```
app/
  page.tsx              Thin orchestrator — renders phase-based screens
  play/[code]/page.tsx  Re-exports the main page (code read from URL)
components/
  ui/                   Button, Panel primitives
  game/                 Home, Lobby, Battle, Results, TopBar,
                        VirtualJoystick, ScoutPanel, CosmeticsPicker, ChaosBanner
lib/
  types.ts              Domain model (Player, State, ScoutHint, Progress, …)
  config.ts             Constants, objective pool, chaos events, cosmetics, XP curve
  movement.ts           Collision + arena clamping
  display.ts            Display-only helpers (never authoritative)
  sound.ts              Procedural Web Audio engine (no asset files)
  supabase.ts           Singleton client + typed RPC helper
  useDuoChaos.ts        Orchestrator wiring all hooks together
  useGameState.ts       Single owner of game state
  useGameLoop.ts        Input → movement → collect/steal → phase transitions
  useRoom.ts            Realtime channel + presence + RPC lifecycle
  useScout.ts           Guess/Read mechanic (charges, cooldown, hint TTL)
  useChaos.ts           Server-synced chaos events
  useCosmetics.ts       Emote / trail selection + animation
  useProgress.ts        XP / level / title / cosmetics persistence
supabase/
  migrations/           Full backend, version-controlled
  README.md             RPC surface + apply instructions
```

## Backend

All game logic lives in PostgreSQL functions under [`supabase/migrations/`](supabase/migrations). See [`supabase/README.md`](supabase/README.md) for the full RPC surface.

Key RPCs:

| RPC | Purpose |
| --- | --- |
| `duo_create_room` / `duo_join_room` | Room lifecycle + player tokens |
| `duo_public_state` | Redacted snapshot (opponent objective hidden unless scouted) |
| `duo_move` / `duo_collect` / `duo_steal` | Authoritative gameplay |
| `duo_start_round` / `duo_advance_phase` / `duo_rematch` | Round + match flow |
| `duo_tick` | Server-generated chaos events + coin waves |
| `duo_scout` | Guess/Read — partial hint about the rival's objective |
| `duo_get_progress` / `duo_award_progress` / `duo_set_cosmetics` | Long-term progression |

## Environment

Copy [`.env.example`](.env.example) to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```

If these are absent, the game runs in **offline mode** — fully playable locally, with progress saved to `localStorage`.

## Scripts

```bash
pnpm dev         # start dev server
pnpm build       # production build
pnpm typecheck   # tsc --noEmit
pnpm lint        # next lint
pnpm check       # typecheck + lint
```
