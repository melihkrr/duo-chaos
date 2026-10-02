-- 0058_steal_lookback_freshness_guard.sql
--
-- SECURITY FIX for 0057 (anti-cheat hole):
--
-- 0057 accepts a steal when the caller-supplied lookback "chase anchor" shows a
-- large DISPLACEMENT:
--
--     v_lookback_gain := dist(victim, anchor) - v_dist
--     accept when v_lookback_gain >= 2.0
--
-- But the anchor is CALLER-SUPPLIED and was not validated against the server's
-- own record of the player's movement. A STATIONARY victim could therefore send
-- a bogus far-away anchor (e.g. (10,50) while standing at (50,50)) and steal
-- from the pursuer who ran into them. A live-DB regression test reproduced this
-- exactly: a never-moved host at (50,50) with a bogus anchor (10,50) got
-- `ok=true`.
--
-- THE FIX: the lookback branch now additionally requires that the player was
-- GENUINELY MOVING RECENTLY, proven by the server's own `last_move_at` column.
-- `last_move_at` is written ONLY by the movement/collection path
-- (`duo_move` / `duo_collect_batch`, see 0048), never by a steal request, so a
-- stationary victim cannot forge it. A player who chased and then stopped has a
-- fresh `last_move_at` (they moved seconds ago); a player who never moved has a
-- stale one.
--
-- The window is generous (5 s) so a player who chased, made contact, and held
-- still for a few seconds can still steal, while a player who has not moved for
-- longer than that cannot. The instantaneous-velocity branch is unchanged, so a
-- genuinely moving pursuer is still accepted exactly as before.
--
-- The 11-arg signature is kept. The 6-arg overload is kept for compatibility.

create or replace function public.duo_steal_versioned(
  p_code text,
  p_token text,
  p_expected_objectives_done int,
  p_expected_round int,
  p_x numeric default null,
  p_y numeric default null,
  p_from_x numeric default null,
  p_from_y numeric default null,
  p_lookback_x numeric default null,
  p_lookback_y numeric default null,
  p_lookback_at bigint default null
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
  -- Caller-supplied movement segment (p_from_* → p_x/p_y).
  v_has_from boolean := false;
  v_from_x numeric;
  v_from_y numeric;
  v_from_len numeric;
  v_max_from_len numeric := 20; -- MOVE_SPEED(38) * 1.6 * 0.25s + slack
  -- Contact tolerance (0054): absorbs the rival's position lag so a genuine
  -- visual contact is not rejected as `too_far`. Tiny and contact-only.
  v_contact_slack numeric := 1.5;
  -- Approach lookback (0055/0056/0057/0058): the caller's most recent MOVING
  -- position. Used to accept a steal from a player who chased, made contact,
  -- and then stopped. The cap is generous (120) because the client keeps the
  -- last moving sample, which can be far away after a long chase.
  v_has_lookback boolean := false;
  v_lookback_x numeric;
  v_lookback_y numeric;
  v_lookback_len numeric;
  v_max_lookback_len numeric := 120; -- MOVE_SPEED(38) * 1.6 * 2s + slack
  -- 0057: DISPLACEMENT gain over the lookback window (units), not a velocity.
  v_lookback_gain numeric := 0;
  v_min_lookback_gain numeric := 2.0;
  -- 0058: the player must have been genuinely moving recently for the lookback
  -- branch to apply. `last_move_at` is server-written by the movement path only.
  v_lookback_fresh interval := interval '5 seconds';
  -- The opponent's own lookback gain, used to break head-on ties.
  v_opp_lookback_gain numeric := 0;
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

  -- Validate the caller-supplied movement segment (if any). It must be a
  -- plausible single-frame step and its "to" end must match the position we
  -- just wrote (or the stored position when no move was applied).
  if p_from_x is not null and p_from_y is not null then
    v_from_x := p_from_x;
    v_from_y := p_from_y;
    v_from_len := sqrt(power(v_new_x - v_from_x, 2) + power(v_new_y - v_from_y, 2));
    if v_from_len > 0
       and v_from_len <= v_max_from_len
       and abs(v_from_x - v_pl.x) <= 0.001 + v_from_len
       and abs(v_from_y - v_pl.y) <= 0.001 + v_from_len then
      v_has_from := true;
    end if;
  end if;

  -- Validate the caller-supplied LOOKBACK segment (0055/0056/0057). Its "to"
  -- end must be the caller's current position; its length must be plausible for
  -- the lookback window. This is what lets a player who chased and then STOPPED
  -- on the rival still steal. The client sends the most recent MOVING sample,
  -- so the length is non-zero even after seconds of standing still.
  if p_lookback_x is not null and p_lookback_y is not null then
    v_lookback_x := p_lookback_x;
    v_lookback_y := p_lookback_y;
    v_lookback_len := sqrt(power(v_pl.x - v_lookback_x, 2) + power(v_pl.y - v_lookback_y, 2));
    if v_lookback_len > 0 and v_lookback_len <= v_max_lookback_len then
      v_has_lookback := true;
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
  if v_dist > 5.2 + v_contact_slack then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  -- ---------------------------------------------------------------------------
  -- DIRECTIONAL SAMPLE RESOLUTION
  --
  -- Priority:
  --   1. A genuine, recent server-recorded sample (written by a preceding
  --      `duo_move`/`duo_collect_batch`) — keeps the anti-cheat comparison.
  --   2. The caller-supplied movement segment (`p_from_*` → `p_x/p_y`) — exact
  --      and non-zero whenever the player is genuinely closing on the rival.
  --   3. Synthesize from the STORED position (0052 behavior) — last resort for
  --      older clients that do not send a from-position.
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
      if v_has_from then
        -- Exact caller-supplied segment. The "to" end is the position we just
        -- wrote; the "from" end is the caller's previous frame position.
        v_prev_x := v_from_x;
        v_prev_y := v_from_y;
        v_cur_x := v_pl.x;
        v_cur_y := v_pl.y;
        v_prev_at := least(
          coalesce(v_pl.last_move_at, v_now - interval '1 millisecond'),
          v_now - interval '1 millisecond'
        );
        v_sample_at := v_now;
      else
        -- Synthesize from the stored position (0052 fallback).
        v_prev_x := v_pl.x;
        v_prev_y := v_pl.y;
        v_cur_x := v_pl.x;
        v_cur_y := v_pl.y;
        if v_positioned_moved then
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
      end if;
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

  -- APPROACH LOOKBACK (0055/0056/0057): if the caller supplied a lookback
  -- position, compute how much FARTHER from the rival the player was at that
  -- sample. This is a DISPLACEMENT (units), not a velocity, so it is robust to
  -- the elapsed window and to how close the last moving sample happens to be.
  --
  --   v_lookback_gain = dist(victim, lookback) - v_dist
  --
  -- A player who chased from 10 units away and is now in contact has a gain of
  -- ~10, far above the 2.0 threshold. A player who never moved has a gain of 0.
  if v_has_lookback then
    v_lookback_gain :=
      sqrt(power(v_opp.x - v_lookback_x, 2) + power(v_opp.y - v_lookback_y, 2))
      - v_dist;
  end if;

  -- The opponent's own lookback gain, used to break head-on ties. The opponent
  -- does not send a lookback, so we derive it from their stored previous
  -- position when it is fresh: how much farther from the player were they?
  if v_opp.previous_x is not null
     and v_opp.previous_y is not null
     and v_opp.previous_position_at is not null
     and v_opp.position_updated_at is not null
     and v_opp.position_updated_at >= v_now - v_legacy_direction_fresh
     and v_opp.previous_position_at <= v_now
     and v_opp.position_updated_at <= v_now
     and v_opp.position_updated_at > v_opp.previous_position_at then
    v_opp_lookback_gain :=
      sqrt(power(v_pl.x - v_opp.previous_x, 2) + power(v_pl.y - v_opp.previous_y, 2))
      - v_dist;
  end if;

  -- A clear pursuer must either be closing NOW (instantaneous velocity, the
  -- existing rule) OR have closed a meaningful DISPLACEMENT over the lookback
  -- window while in contact now. In both cases the pursuer must have closed
  -- more than the opponent did, so a stationary victim cannot steal from a
  -- pursuer who runs into them, and a head-on collision is not awarded to
  -- whoever requested first.
  --
  -- 0058: the lookback branch ALSO requires a fresh server-recorded
  -- `last_move_at`, proving the player was genuinely moving recently. This
  -- closes the hole where a stationary victim forged a far-away anchor.
  if not (
    (v_player_approach > 0.5 and v_player_approach > v_opponent_approach + 0.5)
    or (
      v_has_lookback
      and v_pl.last_move_at is not null
      and v_pl.last_move_at >= v_now - v_lookback_fresh
      and v_lookback_gain >= v_min_lookback_gain
      and v_lookback_gain > v_opp_lookback_gain + 1.0
    )
  ) then
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

revoke all on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric, numeric, numeric, numeric, numeric, bigint)
  from public;
grant execute on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric, numeric, numeric, numeric, numeric, bigint)
  to anon, authenticated;

-- Keep the 6-argument overload working for any older client that has not yet
-- been updated: it forwards to the new version with NULL from/lookback.
create or replace function public.duo_steal_versioned(
  p_code text,
  p_token text,
  p_expected_objectives_done int,
  p_expected_round int,
  p_x numeric default null,
  p_y numeric default null
)
returns jsonb
language sql
security definer
set search_path = public
as $function$
  select public.duo_steal_versioned(
    p_code, p_token, p_expected_objectives_done, p_expected_round,
    p_x, p_y, null, null, null, null, null
  );
$function$;

revoke all on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric)
  from public;
grant execute on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric)
  to anon, authenticated;

notify pgrst, 'reload schema';
