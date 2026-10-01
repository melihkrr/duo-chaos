-- Objective counters belong only to the objective that was active when an
-- action was detected. Keep lifetime round totals and scores independent.

create or replace function duo_reroll_objective_carry(
  p_room text,
  p_slot int,
  p_collected jsonb,
  p_stolen int,
  p_coins int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pl duo_players;
  v_done int;
  v_bonus int;
  v_next jsonb;
  v_after duo_players;
begin
  select * into v_pl
    from duo_players
    where room_code = p_room and slot = p_slot
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_player');
  end if;

  v_done := coalesce(v_pl.objectives_done, 0) + 1;
  v_bonus := coalesce((v_pl.objective->>'points')::int, 50);
  v_next := duo_random_objective(v_pl.objective->>'id');

  update duo_players
    set objectives_done = v_done,
        score = coalesce(score, 0) + v_bonus,
        round_score = coalesce(round_score, 0) + v_bonus,
        objective = v_next,
        coins = 0,
        stolen = 0,
        collected_types = '{}'::jsonb,
        objective_progress = 0,
        mission_done = false
    where room_code = p_room and slot = p_slot;

  select * into v_after
    from duo_players
    where room_code = p_room and slot = p_slot;

  return jsonb_build_object(
    'ok', true,
    'objective', v_after.objective,
    'objectiveProgress', 0,
    'objectivesDone', coalesce(v_after.objectives_done, 0),
    'score', coalesce(v_after.score, 0),
    'roundScore', coalesce(v_after.round_score, 0),
    'collectedTypes', '{}'::jsonb,
    'coins', 0,
    'stolen', 0,
    'missionDone', false
  );
end;
$$;

revoke execute on function duo_reroll_objective_carry(text, int, jsonb, int, int)
  from anon, authenticated;

create or replace function duo_collect_batch(
  p_code text,
  p_token text,
  p_coin_ids int[],
  p_x numeric,
  p_y numeric,
  p_expected_objectives_done int,
  p_expected_round int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  v_pos := duo_clamp_pos(p_x, p_y);
  v_pl.x := (v_pos->>'x')::numeric;
  v_pl.y := (v_pos->>'y')::numeric;
  update duo_players
    set x = v_pl.x, y = v_pl.y, last_seen_at = now()
    where room_code = v_code and slot = v_pl.slot;

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
$$;

grant execute on function duo_collect_batch(text, text, int[], numeric, numeric, int, int)
  to anon, authenticated;

create or replace function duo_collect(p_code text, p_token text, p_coin_id int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
begin
  v_pl := duo_require_player(v_code, p_token);
  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  return duo_collect_batch(
    v_code, p_token, array[p_coin_id], v_pl.x, v_pl.y, v_pl.objectives_done, null
  );
end;
$$;

grant execute on function duo_collect(text, text, int) to anon, authenticated;

create or replace function duo_steal_versioned(
  p_code text,
  p_token text,
  p_expected_objectives_done int,
  p_expected_round int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_opp duo_players;
  v_room duo_rooms;
  v_dist numeric;
  v_steal_score int := 20;
  v_new_stolen int;
  v_progress int;
  v_completed_progress int;
  v_satisfied boolean := false;
  v_counts_for_objective boolean;
  v_after duo_players;
  v_reroll jsonb;
begin
  v_pl := duo_require_player(v_code, p_token);

  -- Lock both player rows in a stable order so opposite-direction steals do
  -- not acquire the same rows in reverse order.
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

  v_dist := sqrt(power(v_opp.x - v_pl.x, 2) + power(v_opp.y - v_pl.y, 2));
  if v_dist > 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
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
        round_score = coalesce(round_score, 0) + v_steal_score
    where room_code = v_code and slot = v_pl.slot;

  update duo_players
    set coins = greatest(0, coins - 1),
        round_coins = greatest(0, coalesce(round_coins, 0) - 1),
        score = greatest(0, coalesce(score, 0) - v_steal_score),
        round_score = greatest(0, coalesce(round_score, 0) - v_steal_score),
        slowed_until = (extract(epoch from now()) * 1000)::bigint + 400
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
$$;

grant execute on function duo_steal_versioned(text, text, int, int) to anon, authenticated;

create or replace function duo_steal(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
begin
  v_pl := duo_require_player(v_code, p_token);
  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  return duo_steal_versioned(v_code, p_token, v_pl.objectives_done, null);
end;
$$;

grant execute on function duo_steal(text, text) to anon, authenticated;
