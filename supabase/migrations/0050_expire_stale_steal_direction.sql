-- Do not let a player's old approach direction remain eligible after they
-- have stopped. This closes the window where a stationary player could be
-- credited for a later contact initiated by the rival.

create or replace function public.duo_steal_versioned(
  p_code text,
  p_token text,
  p_expected_objectives_done int,
  p_expected_round int
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
  v_dist numeric;
  v_player_approach numeric;
  v_opponent_approach numeric := 0;
  v_player_elapsed numeric;
  v_opponent_elapsed numeric;
  v_now timestamptz;
  v_steal_score int := 25;
  v_contact_guard_ms int := 700;
  v_direction_fresh interval := interval '300 milliseconds';
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_new_stolen int;
  v_progress int;
  v_completed_progress int;
  v_satisfied boolean := false;
  v_counts_for_objective boolean;
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

  -- A steal requires a recent movement sample that closes the distance.
  -- 0049 allowed samples up to one second old, so a player who had stopped
  -- could still be treated as the pursuer when the other player made contact.
  if v_pl.previous_x is null
     or v_pl.previous_y is null
     or v_pl.previous_position_at is null
     or v_pl.position_updated_at is null
     or v_pl.previous_position_at < v_now - v_direction_fresh
     or v_pl.position_updated_at < v_now - v_direction_fresh
     or v_pl.previous_position_at > v_now
     or v_pl.position_updated_at > v_now
     or v_pl.position_updated_at <= v_pl.previous_position_at then
    return jsonb_build_object('ok', false, 'reason', 'not_chasing');
  end if;

  v_player_elapsed := extract(epoch from (v_pl.position_updated_at - v_pl.previous_position_at));
  v_player_approach :=
    (
      sqrt(power(v_opp.x - v_pl.previous_x, 2) + power(v_opp.y - v_pl.previous_y, 2))
      - v_dist
    ) / v_player_elapsed;

  if v_opp.previous_x is not null
     and v_opp.previous_y is not null
     and v_opp.previous_position_at is not null
     and v_opp.position_updated_at is not null
     and v_opp.previous_position_at >= v_now - v_direction_fresh
     and v_opp.position_updated_at >= v_now - v_direction_fresh
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

grant execute on function public.duo_steal_versioned(text, text, integer, integer)
  to anon, authenticated;
