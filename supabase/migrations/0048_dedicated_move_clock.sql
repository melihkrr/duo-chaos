-- 0048_dedicated_move_clock.sql
--
-- REGRESSION FIX for migration 0047 (server-side position validation).
--
-- ROOT CAUSE:
--   0047 used `duo_players.last_seen_at` as the movement clock for
--   `duo_step_ok(...)`. But `last_seen_at` is a LIVENESS heartbeat that is
--   written by OTHER RPCs too:
--     * `duo_public_state` runs `update duo_players set last_seen_at = now()`
--       on EVERY poll (battle poll interval = 1000ms, countdown = 500ms).
--     * `duo_collect_batch` also writes `last_seen_at = now()`.
--   Because the client polls `duo_public_state` roughly once per second while
--   moving, a poll landing between two `duo_move` calls RESET the clock. The
--   next legitimate move then saw a tiny elapsed time and was rejected as
--   `too_fast` — legitimate movement was intermittently blocked during battle.
--
-- FIX:
--   Introduce a DEDICATED movement clock column `last_move_at` that is written
--   ONLY by the movement/collection path (`duo_move`, `duo_collect_batch`).
--   `duo_step_ok` now measures elapsed time from `last_move_at`, so unrelated
--   polls/heartbeats can no longer shrink the movement window.
--
--   `last_seen_at` keeps its original meaning (liveness / disconnect detection)
--   and is still refreshed by `duo_public_state`.
--
-- The helper remains INTERNAL (EXECUTE revoked from public/anon/authenticated).

-- ---------------------------------------------------------------------------
-- 1. Dedicated movement clock column.
-- ---------------------------------------------------------------------------
alter table public.duo_players
  add column if not exists last_move_at timestamptz not null default now();

-- Backfill: seed the movement clock from the existing liveness timestamp so
-- in-flight rooms behave identically until their next move.
update public.duo_players
  set last_move_at = last_seen_at
  where last_move_at is null or last_move_at > last_seen_at;

-- ---------------------------------------------------------------------------
-- 2. Internal step-validation helper — now keyed on the movement clock.
-- ---------------------------------------------------------------------------
-- The parameter name changes (p_stored_at -> p_last_move_at); PostgreSQL cannot
-- rename an input parameter via CREATE OR REPLACE, so drop the old signature.
drop function if exists public.duo_step_ok(numeric, numeric, timestamptz, numeric, numeric, bigint, bigint);

create or replace function public.duo_step_ok(
  p_stored_x numeric,
  p_stored_y numeric,
  p_last_move_at timestamptz,
  p_new_x numeric,
  p_new_y numeric,
  p_slowed_until bigint,
  p_now_ms bigint
)
returns boolean
language plpgsql
immutable
as $function$
declare
  -- Nominal movement speed in arena-% per second (mirrors lib/config.ts MOVE_SPEED).
  v_speed numeric := 38;
  -- Bump-slow multiplier (mirrors lib/config.ts BUMP_SPEED_MULTIPLIER).
  v_slow_mult numeric := 0.55;
  -- Safety factor: covers diagonal movement (sqrt(2) ~= 1.414) plus jitter.
  v_safety numeric := 1.6;
  -- Absolute floor (arena-%): covers the first move after spawn, rounding and
  -- small request batching. Generous on purpose — this is an anti-teleport
  -- guard, not a precise physics simulation.
  v_floor numeric := 8;
  v_elapsed_ms bigint;
  v_max_step numeric;
  v_dist numeric;
begin
  if p_last_move_at is null then
    return true;
  end if;

  v_elapsed_ms := greatest(0, p_now_ms - (extract(epoch from p_last_move_at) * 1000)::bigint);

  if p_slowed_until is not null and p_slowed_until > p_now_ms then
    v_speed := v_speed * v_slow_mult;
  end if;

  v_max_step := v_speed * (v_elapsed_ms::numeric / 1000.0) * v_safety + v_floor;

  v_dist := sqrt(power(p_new_x - p_stored_x, 2) + power(p_new_y - p_stored_y, 2));

  return v_dist <= v_max_step;
end;
$function$;

-- Internal only.
revoke all on function public.duo_step_ok(numeric, numeric, timestamptz, numeric, numeric, bigint, bigint)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. `duo_move` — validate against the movement clock, advance it on success.
-- ---------------------------------------------------------------------------
create or replace function public.duo_move(p_code text, p_token text, p_x numeric, p_y numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_room duo_rooms;
  v_pos jsonb;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_new_x numeric;
  v_new_y numeric;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase not in ('countdown', 'battle') then
    return jsonb_build_object('ok', false, 'reason', 'not_live');
  end if;

  v_pos := duo_clamp_pos(p_x, p_y);
  v_new_x := (v_pos->>'x')::numeric;
  v_new_y := (v_pos->>'y')::numeric;

  -- Anti-teleport: the requested position must be reachable from the last
  -- server-stored position within the elapsed time since the last MOVE (not
  -- since the last poll/heartbeat). On violation we DO NOT write the position
  -- and return the authoritative one for reconciliation.
  if not duo_step_ok(
    v_pl.x, v_pl.y, v_pl.last_move_at, v_new_x, v_new_y, v_pl.slowed_until, v_now_ms
  ) then
    return jsonb_build_object(
      'ok', false,
      'reason', 'too_fast',
      'x', v_pl.x,
      'y', v_pl.y
    );
  end if;

  update duo_players
    set x = v_new_x,
        y = v_new_y,
        last_move_at = now(),
        last_seen_at = now()
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object('ok', true, 'x', v_new_x, 'y', v_new_y);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. `duo_collect_batch` — validate against the movement clock; never trust
--    client coordinates for the distance check.
-- ---------------------------------------------------------------------------
create or replace function public.duo_collect_batch(
  p_code text,
  p_token text,
  p_coin_ids integer[],
  p_x numeric,
  p_y numeric,
  p_expected_objectives_done integer,
  p_expected_round integer
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_room duo_rooms;
  v_coin duo_coins;
  v_pos jsonb;
  v_coin_id int;
  v_dist numeric;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_value int;
  v_total_value int := 0;
  v_objective_coins int;
  v_round_coins int := 0;
  v_collected jsonb;
  v_progress int;
  v_completed_progress int;
  v_satisfied boolean := false;
  v_counts_for_objective boolean;
  v_accepted_ids int[] := '{}';
  v_after duo_players;
  v_reroll jsonb;
  v_new_x numeric;
  v_new_y numeric;
  v_step_ok boolean;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_a_player');
  end if;

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', false, 'reason', 'not_battle');
  end if;
  if p_expected_round is not null and p_expected_round <> v_room.round then
    return jsonb_build_object('ok', false, 'reason', 'stale_round');
  end if;

  -- ANTI-CHEAT: validate the client-supplied position against the last
  -- server-stored position using the MOVEMENT clock. If the step is not
  -- reachable we IGNORE the client coordinates entirely and use the
  -- server-stored position for the distance check below. A lying client
  -- therefore cannot collect a remote coin.
  v_pos := duo_clamp_pos(p_x, p_y);
  v_new_x := (v_pos->>'x')::numeric;
  v_new_y := (v_pos->>'y')::numeric;
  v_step_ok := duo_step_ok(
    v_pl.x, v_pl.y, v_pl.last_move_at, v_new_x, v_new_y, v_pl.slowed_until, v_now
  );

  if v_step_ok then
    v_pl.x := v_new_x;
    v_pl.y := v_new_y;
    update duo_players
      set x = v_pl.x, y = v_pl.y, last_move_at = now(), last_seen_at = now()
      where room_code = v_code and slot = v_pl.slot;
  end if;
  -- else: keep v_pl.x / v_pl.y as the server-stored values (do NOT trust client).

  v_counts_for_objective :=
    p_expected_objectives_done is null
    or p_expected_objectives_done = coalesce(v_pl.objectives_done, 0);
  v_objective_coins := coalesce(v_pl.coins, 0);
  v_collected := coalesce(v_pl.collected_types, '{}'::jsonb);

  -- Stable lock ordering avoids deadlocks if both clients overlap multiple coins.
  for v_coin_id in
    select distinct requested_id
      from unnest(coalesce(p_coin_ids, '{}'::int[])) as requested(requested_id)
      where requested_id is not null
      order by requested_id
  loop
    select * into v_coin
      from duo_coins
      where room_code = v_code and coin_id = v_coin_id
      for update;
    if not found or v_coin.collected_by is not null then
      continue;
    end if;

    -- Distance is measured from the SERVER-STORED position (v_pl.x / v_pl.y),
    -- never from the raw client payload.
    v_dist := sqrt(power(v_coin.x - v_pl.x, 2) + power(v_coin.y - v_pl.y, 2));
    if v_dist > 9 then
      continue;
    end if;

    v_value := duo_coin_value(
      v_coin.type,
      case when v_room.chaos_ends_at > v_now then v_room.chaos_event else null end,
      v_pl.objective
    );
    update duo_coins
      set collected_by = v_pl.player_id,
          collected_at = v_now,
          respawn_at = case when v_coin.type = 'diamond' then 0 else v_now + 3000 end
      where room_code = v_code and coin_id = v_coin_id;

    v_accepted_ids := array_append(v_accepted_ids, v_coin_id);
    v_round_coins := v_round_coins + 1;
    v_total_value := v_total_value + v_value;

    if v_counts_for_objective then
      v_objective_coins := v_objective_coins + 1;
      v_collected := jsonb_set(
        v_collected,
        array[v_coin.type::text],
        to_jsonb(coalesce((v_collected->>v_coin.type::text)::int, 0) + 1),
        true
      );
    end if;
  end loop;

  if cardinality(v_accepted_ids) = 0 then
    select * into v_after
      from duo_players
      where room_code = v_code and slot = v_pl.slot;
    return jsonb_build_object(
      'ok', true,
      'acceptedCoinIds', '[]'::jsonb,
      'objectiveDone', false,
      'completedProgress', null,
      'state', jsonb_build_object(
        'objective', v_after.objective,
        'objectiveProgress', coalesce(v_after.objective_progress, 0),
        'collectedTypes', coalesce(v_after.collected_types, '{}'::jsonb),
        'coins', v_after.coins,
        'stolen', v_after.stolen,
        'roundCoins', coalesce(v_after.round_coins, 0),
        'roundStolen', coalesce(v_after.round_stolen, 0),
        'missionDone', v_after.mission_done,
        'objectivesDone', coalesce(v_after.objectives_done, 0),
        'score', coalesce(v_after.score, 0),
        'roundScore', coalesce(v_after.round_score, 0)
      )
    );
  end if;

  if v_counts_for_objective then
    v_progress := duo_mission_progress(
      v_pl.objective, v_collected, v_pl.stolen, v_objective_coins
    );
    v_satisfied := duo_mission_satisfied(
      v_pl.objective, v_collected, v_pl.stolen, v_objective_coins
    );
    update duo_players
      set coins = v_objective_coins,
          collected_types = v_collected,
          objective_progress = greatest(coalesce(v_pl.objective_progress, 0), v_progress),
          mission_done = v_satisfied,
          round_coins = coalesce(round_coins, 0) + v_round_coins,
          score = coalesce(score, 0) + v_total_value,
          round_score = coalesce(round_score, 0) + v_total_value
      where room_code = v_code and slot = v_pl.slot;
  else
    update duo_players
      set round_coins = coalesce(round_coins, 0) + v_round_coins,
          score = coalesce(score, 0) + v_total_value,
          round_score = coalesce(round_score, 0) + v_total_value
      where room_code = v_code and slot = v_pl.slot;
    v_progress := coalesce(v_pl.objective_progress, 0);
  end if;

  v_completed_progress := v_progress;
  if v_satisfied then
    v_reroll := duo_reroll_objective_carry(
      v_code, v_pl.slot, v_collected, v_pl.stolen, v_objective_coins
    );
  end if;

  select * into v_after
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object(
    'ok', true,
    'acceptedCoinIds', to_jsonb(v_accepted_ids),
    'objectiveDone', v_satisfied,
    'completedProgress', case when v_satisfied then v_completed_progress else null end,
    'state', jsonb_build_object(
      'objective', v_after.objective,
      'objectiveProgress', coalesce(v_after.objective_progress, 0),
      'collectedTypes', coalesce(v_after.collected_types, '{}'::jsonb),
      'coins', v_after.coins,
      'stolen', v_after.stolen,
      'roundCoins', coalesce(v_after.round_coins, 0),
      'roundStolen', coalesce(v_after.round_stolen, 0),
      'missionDone', v_after.mission_done,
      'objectivesDone', coalesce(v_after.objectives_done, 0),
      'score', coalesce(v_after.score, 0),
      'roundScore', coalesce(v_after.round_score, 0)
    )
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Re-assert the client RPC surface (idempotent).
-- ---------------------------------------------------------------------------
grant execute on function public.duo_move(text, text, numeric, numeric)
  to anon, authenticated;
grant execute on function public.duo_collect_batch(text, text, integer[], numeric, numeric, integer, integer)
  to anon, authenticated;

notify pgrst, 'reload schema';
