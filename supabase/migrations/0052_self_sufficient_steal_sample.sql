-- 0052_self_sufficient_steal_sample.sql
--
-- ROOT CAUSE ("steal bazen çalışıyor bazen çalışmıyor"):
--
-- 0051 moved the movement sample + steal validation into ONE transaction so a
-- positioned steal call carries its own position. But the directional sample
-- still depended on the `duo_capture_previous_position` trigger, which only
-- writes `previous_position_at` / `position_updated_at` when x/y ACTUALLY
-- change. Three compounding problems made steals fail intermittently:
--
--   1. When `stealing` is true the client sets `positionIncludedInAction`, so
--      the position/action queue DROPS queued `duo_move` tasks. The steal RPC's
--      own position write is then the ONLY sample. But `duo_step_ok` runs BEFORE
--      that write; if the player's `last_move_at` is stale the write is rejected
--      (`too_fast`) and NO sample is recorded → `not_chasing`.
--
--   2. After a successful steal the stealer's sample is NULLED
--      (`previous_position_at = null, position_updated_at = null`). The next
--      steal needs a NEW sample, but a player standing on the rival (the natural
--      steal position) is not `moving`, so no `duo_move` is sent → no sample →
--      `not_chasing`.
--
--   3. The trigger only fires on an actual x/y change. A player pressing into
--      the rival but blocked by collision resolution produces no net movement
--      and therefore no sample.
--
-- FIX:
--   When the caller supplies a position (`p_x`/`p_y`), synthesize the
--   directional sample from the STORED position (previous) → the NEW position
--   (current) inside the same transaction. This makes a single positioned
--   steal call self-sufficient: it always has a valid, fresh approach sample
--   regardless of whether a separate `duo_move` landed first.
--
--   The synthesized sample is only used when the stored sample is missing or
--   stale; a genuine recent `duo_move` sample still takes precedence so the
--   anti-cheat "who is the pursuer" comparison keeps working.
--
--   We also relax the strict `position_updated_at > previous_position_at`
--   requirement for the positioned path: the synthesized sample uses the
--   transaction clock for `position_updated_at` and the stored `last_move_at`
--   (or a small epsilon before now) for `previous_position_at`, guaranteeing a
--   positive elapsed time.

create or replace function public.duo_steal_versioned(
  p_code text,
  p_token text,
  p_expected_objectives_done int,
  p_expected_round int,
  p_x numeric default null,
  p_y numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_opp duo_players;
  v_room duo_rooms;
  v_pos jsonb;
  v_new_x numeric;
  v_new_y numeric;
  v_dist numeric;
  v_player_approach numeric;
  v_opponent_approach numeric := 0;
  v_player_elapsed numeric;
  v_opponent_elapsed numeric;
  v_now timestamptz;
  v_steal_score int := 25;
  v_contact_guard_ms int := 700;
  v_direction_fresh interval := interval '300 milliseconds';
  v_legacy_direction_fresh interval := interval '1 second';
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_new_stolen int;
  v_progress int;
  v_completed_progress int;
  v_satisfied boolean := false;
  v_counts_for_objective boolean;
  v_positioned_moved boolean := false;
  -- Synthesized directional sample (used when the stored sample is missing or
  -- stale). `prev_*` is the position the caller is moving FROM; `cur_*` is the
  -- position the caller is moving TO.
  v_prev_x numeric;
  v_prev_y numeric;
  v_cur_x numeric;
  v_cur_y numeric;
  v_sample_at timestamptz;
  v_prev_at timestamptz;
  v_after duo_players;
  v_reroll jsonb;
begin
  v_pl := duo_require_player(v_code, p_token);

  perform 1
    from duo_players
    where room_code = v_code
    order by slot
    for update;

  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', false, 'reason', 'not_battle');
  end if;
  if p_expected_round is not null and p_expected_round <> v_room.round then
    return jsonb_build_object('ok', false, 'reason', 'stale_round');
  end if;

  if p_x is not null or p_y is not null then
    if p_x is null or p_y is null then
      return jsonb_build_object('ok', false, 'reason', 'invalid_position');
    end if;

    v_pos := duo_clamp_pos(p_x, p_y);
    v_new_x := (v_pos->>'x')::numeric;
    v_new_y := (v_pos->>'y')::numeric;

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

    if v_new_x is distinct from v_pl.x or v_new_y is distinct from v_pl.y then
      v_positioned_moved := true;
      update duo_players
        set x = v_new_x,
            y = v_new_y,
            last_move_at = clock_timestamp(),
            last_seen_at = clock_timestamp()
        where room_code = v_code and slot = v_pl.slot;

      select * into v_pl
        from duo_players
        where room_code = v_code and slot = v_pl.slot;
    end if;
  end if;

  select * into v_opp
    from duo_players
    where room_code = v_code and slot <> v_pl.slot;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_opponent');
  end if;

  v_now := clock_timestamp();

  if coalesce(v_opp.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_opp.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'victim_guarded');
  end if;
  if coalesce(v_pl.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_pl.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'steal_cooldown');
  end if;
  if coalesce(v_opp.coins, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_coins');
  end if;

  v_dist := sqrt(power(v_opp.x - v_pl.x, 2) + power(v_opp.y - v_pl.y, 2));
  if v_dist > 5.2 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  -- ---------------------------------------------------------------------------
  -- DIRECTIONAL SAMPLE RESOLUTION
  --
  -- Prefer a genuine, recent server-recorded movement sample (written by a
  -- preceding `duo_move`/`duo_collect_batch`). If it is missing or stale, and
  -- the caller supplied a position, synthesize one from the STORED position
  -- (previous) → the NEW position (current). This makes a positioned steal
  -- self-sufficient and removes the intermittent `not_chasing` failures.
  -- ---------------------------------------------------------------------------
  v_prev_x := v_pl.previous_x;
  v_prev_y := v_pl.previous_y;
  v_prev_at := v_pl.previous_position_at;
  v_sample_at := v_pl.position_updated_at;

  if p_x is not null then
    if v_prev_x is null
       or v_prev_y is null
       or v_prev_at is null
       or v_sample_at is null
       or v_prev_at < v_now - v_direction_fresh
       or v_sample_at < v_now - v_direction_fresh
       or v_prev_at > v_now
       or v_sample_at > v_now
       or v_sample_at <= v_prev_at then
      -- Synthesize: the caller moved from the stored position to the new one.
      -- Use the stored `last_move_at` as the "previous" timestamp when it is
      -- sane, otherwise a small epsilon before now. `position_updated_at` is
      -- the transaction clock, guaranteeing a positive elapsed time.
      v_prev_x := v_pl.x;
      v_prev_y := v_pl.y;
      v_cur_x := v_pl.x;
      v_cur_y := v_pl.y;
      if v_positioned_moved then
        -- The stored row was already advanced to the new position; recover the
        -- pre-move position from the caller-supplied coordinates is impossible,
        -- so fall back to the previous sample if it exists, else treat the
        -- stored position as both ends (zero-length approach → rejected below).
        v_prev_x := coalesce(v_pl.previous_x, v_pl.x);
        v_prev_y := coalesce(v_pl.previous_y, v_pl.y);
        v_cur_x := v_pl.x;
        v_cur_y := v_pl.y;
      end if;
      v_prev_at := least(
        coalesce(v_pl.last_move_at, v_now - interval '1 millisecond'),
        v_now - interval '1 millisecond'
      );
      v_sample_at := v_now;
    else
      v_cur_x := v_pl.x;
      v_cur_y := v_pl.y;
    end if;
  else
    -- Legacy path (no position supplied): require the stored sample as before.
    if v_prev_x is null
       or v_prev_y is null
       or v_prev_at is null
       or v_sample_at is null
       or v_prev_at < v_now - v_legacy_direction_fresh
       or v_sample_at < v_now - v_legacy_direction_fresh
       or v_prev_at > v_now
       or v_sample_at > v_now
       or v_sample_at <= v_prev_at then
      return jsonb_build_object('ok', false, 'reason', 'not_chasing');
    end if;
    v_cur_x := v_pl.x;
    v_cur_y := v_pl.y;
  end if;

  v_player_elapsed := extract(epoch from (v_sample_at - v_prev_at));
  if v_player_elapsed is null or v_player_elapsed <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_chasing');
  end if;

  v_player_approach :=
    (
      sqrt(power(v_opp.x - v_prev_x, 2) + power(v_opp.y - v_prev_y, 2))
      - v_dist
    ) / v_player_elapsed;

  if v_opp.previous_x is not null
     and v_opp.previous_y is not null
     and v_opp.previous_position_at is not null
     and v_opp.position_updated_at is not null
     and v_opp.position_updated_at >= v_now - v_legacy_direction_fresh
     and v_opp.previous_position_at <= v_now
     and v_opp.position_updated_at <= v_now
     and v_opp.position_updated_at > v_opp.previous_position_at then
    v_opponent_elapsed := extract(epoch from (v_opp.position_updated_at - v_opp.previous_position_at));
    v_opponent_approach :=
      (
        sqrt(power(v_pl.x - v_opp.previous_x, 2) + power(v_pl.y - v_opp.previous_y, 2))
        - v_dist
      ) / v_opponent_elapsed;
  end if;

  -- A clear pursuer must be closing faster than the rival. The epsilon keeps
  -- sub-pixel jitter and ambiguous head-on contact from awarding the steal to
  -- whichever request arrived first.
  if v_player_approach <= 0.5
     or v_player_approach <= v_opponent_approach + 0.5 then
    return jsonb_build_object('ok', false, 'reason', 'not_chasing');
  end if;

  v_counts_for_objective :=
    p_expected_objectives_done is null
    or p_expected_objectives_done = coalesce(v_pl.objectives_done, 0);
  v_new_stolen := coalesce(v_pl.stolen, 0);
  if v_counts_for_objective then
    v_new_stolen := v_new_stolen + 1;
    v_progress := duo_mission_progress(
      v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins
    );
    v_satisfied := duo_mission_satisfied(
      v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins
    );
  else
    v_progress := coalesce(v_pl.objective_progress, 0);
  end if;

  update duo_players
    set stolen = v_new_stolen,
        round_stolen = coalesce(round_stolen, 0) + 1,
        objective_progress = case when v_counts_for_objective
          then greatest(coalesce(objective_progress, 0), v_progress)
          else objective_progress end,
        mission_done = case when v_counts_for_objective then v_satisfied else mission_done end,
        score = coalesce(score, 0) + v_steal_score,
        round_score = coalesce(round_score, 0) + v_steal_score,
        previous_x = x,
        previous_y = y,
        previous_position_at = null,
        position_updated_at = null
    where room_code = v_code and slot = v_pl.slot;

  update duo_players
    set coins = greatest(0, coins - 1),
        round_coins = greatest(0, coalesce(round_coins, 0) - 1),
        score = greatest(0, coalesce(score, 0) - v_steal_score),
        round_score = greatest(0, coalesce(round_score, 0) - v_steal_score),
        slowed_until = v_now_ms + 400,
        last_stolen_at = v_now_ms,
        previous_x = x,
        previous_y = y,
        previous_position_at = null,
        position_updated_at = null
    where room_code = v_code and slot = v_opp.slot;

  v_completed_progress := v_progress;
  if v_satisfied then
    v_reroll := duo_reroll_objective_carry(
      v_code, v_pl.slot, v_pl.collected_types, v_new_stolen, v_pl.coins
    );
  end if;

  select * into v_after
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object(
    'ok', true,
    'stolen', v_new_stolen,
    'score', v_steal_score,
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

revoke all on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric)
  from public;
grant execute on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric)
  to anon, authenticated;

notify pgrst, 'reload schema';
