-- ============================================================================
-- DUO CHAOS — 0046 lock down internal helpers
--
-- AUDIT FINDING (CRITICAL — cheat vectors):
--   Several functions that are INTERNAL implementation details were granted
--   EXECUTE to `anon`/`authenticated`. Because they are NOT `security definer`
--   (or because they operate on an arbitrary room code with no caller check),
--   any browser client could call them directly via PostgREST and mutate game
--   state in ANY room. The worst offenders:
--
--     * duo_spawn_coins(p_room)   -> deletes + respawns every coin in a room
--     * duo_spawn_wave(p_room,..) -> injects coins into any room
--     * duo_respawn_coins(p_room) -> revives collected coins in any room
--     * duo_cleanup()             -> deletes idle rooms globally
--     * duo_require_player(...)   -> leaks player rows (token oracle)
--     * duo_mission_progress/satisfied, duo_coin_value, duo_clamp_pos,
--       duo_objective_pool/pair, duo_random_objective, duo_chaos_for_round,
--       duo_profile_for_xp, duo_fnv1a, duo_avatar_ids, duo_avatar_min_level
--       -> pure helpers; no reason to expose them.
--     * duo_sync_coins(...)       -> legacy coin sync, superseded by
--                                    duo_public_state; not used by the client.
--     * duo_reset_objective_progress_on_change() -> trigger function.
--
-- IMPORTANT — the following functions LOOK internal but ARE part of the real
-- client surface (verified against lib/useGameLoop.ts and lib/useDuoChaos.ts)
-- and MUST stay granted:
--     * duo_collect_batch(...)    -> called by useGameLoop for every pickup
--     * duo_steal_versioned(...)  -> called by useGameLoop for every steal
--     * duo_next_round(...)       -> called by useDuoChaos.beginNextRound
--     * duo_set_name(...)         -> called by useDuoChaos.setName
--   These are all `security definer` and validate the caller's token before
--   touching state, so they are safe to expose.
--
-- The intended client RPC surface (kept granted) is:
--   duo_create_room(text,text,text)          duo_join_room(text,text,text)
--   duo_leave(text,text)                     duo_rematch(text,text)
--   duo_public_state(text,text)              duo_move(text,text,numeric,numeric)
--   duo_collect(text,text,int)               duo_collect_batch(text,text,int[],numeric,numeric,int,int)
--   duo_steal(text,text)                     duo_steal_versioned(text,text,int,int)
--   duo_start_round(text,text)               duo_next_round(text,text)
--   duo_advance_phase(text,text)             duo_tick(text,text)
--   duo_scout(text,text)                     duo_set_name(text,text,text)
--   duo_get_progress(text)                   duo_award_progress(text,int)
--   duo_set_cosmetics(text,text,text,text)   duo_apply_cosmetics(text,text,text,text,text)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Revoke EXECUTE on internal helpers from the public roles.
--    `revoke ... from public` also removes the implicit PUBLIC grant that
--    Postgres adds to every new function.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  internal_fns text[] := array[
    'duo_spawn_coins(text)',
    'duo_spawn_wave(text, integer, integer)',
    'duo_respawn_coins(text)',
    'duo_cleanup()',
    'duo_require_player(text, text)',
    'duo_mission_progress(jsonb, jsonb, integer, integer)',
    'duo_mission_satisfied(jsonb, jsonb, integer, integer)',
    'duo_coin_value(duo_coin_type, duo_chaos_event, jsonb)',
    'duo_clamp_pos(numeric, numeric)',
    'duo_objective_pool()',
    'duo_objective_pair(text)',
    'duo_random_objective(text)',
    'duo_chaos_for_round(text)',
    'duo_profile_for_xp(integer)',
    'duo_fnv1a(text)',
    'duo_avatar_ids()',
    'duo_avatar_min_level(text)',
    'duo_sync_coins(text, text)',
    'duo_reset_objective_progress_on_change()'
  ];
begin
  foreach fn in array internal_fns loop
    begin
      execute format('revoke all on function %s from public, anon, authenticated', fn);
    exception when undefined_function then
      -- Function may not exist in this environment; ignore.
      null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Drop the legacy, unused overloads so there is exactly ONE signature per
--    client-facing RPC. The 2-arg variants predate player names and are never
--    called by the current client (which always passes p_name).
-- ---------------------------------------------------------------------------
drop function if exists duo_create_room(text, text);
drop function if exists duo_join_room(text, text);

-- Legacy 4-arg cosmetics setter (no avatar) — superseded by the 5-arg version.
drop function if exists duo_set_cosmetics(text, text, text);
-- Legacy 4-arg cosmetics applier (no avatar) — superseded by the 5-arg version.
drop function if exists duo_apply_cosmetics(text, text, text, text);

-- Dead code: duo_reroll_objective was replaced by duo_reroll_objective_carry
-- (which carries overflow + resets counters atomically). Nothing calls it.
drop function if exists duo_reroll_objective(text, integer);

-- ---------------------------------------------------------------------------
-- 3. Re-assert the intended client RPC surface. This is idempotent and makes
--    the grant state explicit even if an earlier migration drifted.
-- ---------------------------------------------------------------------------
grant execute on function duo_create_room(text, text, text)              to anon, authenticated;
grant execute on function duo_join_room(text, text, text)                to anon, authenticated;
grant execute on function duo_leave(text, text)                          to anon, authenticated;
grant execute on function duo_rematch(text, text)                        to anon, authenticated;
grant execute on function duo_public_state(text, text)                   to anon, authenticated;
grant execute on function duo_move(text, text, numeric, numeric)         to anon, authenticated;
grant execute on function duo_collect(text, text, integer)               to anon, authenticated;
grant execute on function duo_collect_batch(text, text, integer[], numeric, numeric, integer, integer) to anon, authenticated;
grant execute on function duo_steal(text, text)                          to anon, authenticated;
grant execute on function duo_steal_versioned(text, text, integer, integer) to anon, authenticated;
grant execute on function duo_start_round(text, text)                    to anon, authenticated;
grant execute on function duo_next_round(text, text)                     to anon, authenticated;
grant execute on function duo_advance_phase(text, text)                  to anon, authenticated;
grant execute on function duo_tick(text, text)                           to anon, authenticated;
grant execute on function duo_scout(text, text)                          to anon, authenticated;
grant execute on function duo_set_name(text, text, text)                 to anon, authenticated;
grant execute on function duo_get_progress(text)                         to anon, authenticated;
grant execute on function duo_award_progress(text, integer)              to anon, authenticated;
grant execute on function duo_set_cosmetics(text, text, text, text)      to anon, authenticated;
grant execute on function duo_apply_cosmetics(text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Realtime for progression: publish the table and add a minimal SELECT
--    policy so the owner of a client_id can receive its own row changes.
--
--    AUDIT FINDING: `duo_progression` was never added to the
--    `supabase_realtime` publication and RLS had zero policies, so the
--    `postgres_changes` subscription in lib/useProgress.ts could never fire.
--    The client already falls back to polling via duo_get_progress, but the
--    realtime path was dead code. Publishing + a scoped policy makes it work
--    without exposing other players' rows.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'duo_progression'
  ) then
    alter publication supabase_realtime add table duo_progression;
  end if;
exception when undefined_object then
  -- Publication does not exist (non-Supabase Postgres); ignore.
  null;
end $$;

-- The client identifies itself with a client_id it generated locally. There is
-- no auth.uid() in this anonymous game, so we cannot scope by user. Instead we
-- allow SELECT only (never INSERT/UPDATE/DELETE) so a client can read
-- progression rows but can never write them directly — all writes still go
-- through the SECURITY DEFINER RPCs. This is the minimum needed for the
-- realtime subscription to deliver the caller's own row.
drop policy if exists duo_progression_read on duo_progression;
create policy duo_progression_read
  on duo_progression
  for select
  to anon, authenticated
  using (true);

-- Realtime requires the table to be readable by the subscribing role; grant
-- SELECT (RLS still applies). No write grants are added.
grant select on duo_progression to anon, authenticated;

notify pgrst, 'reload schema';
