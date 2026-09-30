-- ============================================================================
-- DUO CHAOS — 0004 RPC: gameplay
-- duo_move, duo_collect, duo_steal, duo_start_round, duo_advance_phase
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Arena bounds / collision constants — mirror lib/config.ts
-- ---------------------------------------------------------------------------
create or replace function duo_clamp_pos(p_x numeric, p_y numeric)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'x', greatest(5, least(95, p_x)),
    'y', greatest(7, least(93, p_y))
  );
$$;

-- ---------------------------------------------------------------------------
-- duo_move(p_code, p_token, p_x, p_y) — update the caller's position.
-- Only accepted during countdown/battle.
-- ---------------------------------------------------------------------------
create or replace function duo_move(p_code text, p_token text, p_x numeric, p_y numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_room duo_rooms;
  v_pos jsonb;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase not in ('countdown', 'battle') then
    return jsonb_build_object('ok', false, 'reason', 'not_live');
  end if;

  v_pos := duo_clamp_pos(p_x, p_y);

  update duo_players
    set x = (v_pos->>'x')::numeric,
        y = (v_pos->>'y')::numeric,
        last_seen_at = now()
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object('ok', true, 'x', v_pos->'x', 'y', v_pos->'y');
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_collect(p_code, p_token, p_coin_id) — claim a coin if within range.
-- Score is computed server-side using the caller's objective + active chaos.
-- ---------------------------------------------------------------------------
create or replace function duo_collect(p_code text, p_token text, p_coin_id int)
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
  v_dist numeric;
  v_value int;
  v_collected jsonb;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', false, 'reason', 'not_battle');
  end if;

  select * into v_coin
    from duo_coins
    where room_code = v_code and coin_id = p_coin_id
    for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_coin');
  end if;
  if v_coin.collected_by is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_collected');
  end if;

  v_dist := sqrt(power(v_coin.x - v_pl.x, 2) + power(v_coin.y - v_pl.y, 2));
  if v_dist > 9 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  -- Chaos is only in effect until its deadline.
  v_value := duo_coin_value(
    v_coin.type,
    case when v_room.chaos_ends_at > (extract(epoch from now()) * 1000)::bigint
         then v_room.chaos_event else null end,
    v_pl.objective
  );

  update duo_coins
    set collected_by = v_pl.player_id,
        collected_at = (extract(epoch from now()) * 1000)::bigint
    where room_code = v_code and coin_id = p_coin_id;

  v_collected := coalesce(v_pl.collected_types, '{}'::jsonb);
  v_collected := jsonb_set(
    v_collected,
    array[v_coin.type::text],
    to_jsonb(coalesce((v_collected->>v_coin.type::text)::int, 0) + 1),
    true
  );

  update duo_players
    set coins = coins + 1,
        collected_types = v_collected,
        score = score + v_value,
        mission_done = duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object('ok', true, 'value', v_value, 'type', v_coin.type);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_steal(p_code, p_token) — steal from the opponent when in range.
-- Transfers one coin's worth of score and increments the steal counter.
-- ---------------------------------------------------------------------------
create or replace function duo_steal(p_code text, p_token text)
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
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', false, 'reason', 'not_battle');
  end if;

  select * into v_opp
    from duo_players
    where room_code = v_code and slot <> v_pl.slot
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_opponent');
  end if;

  v_dist := sqrt(power(v_opp.x - v_pl.x, 2) + power(v_opp.y - v_pl.y, 2));
  if v_dist > 10 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  v_new_stolen := v_pl.stolen + 1;

  update duo_players
    set stolen = v_new_stolen,
        score = score + v_steal_score,
        mission_done = duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    where room_code = v_code and slot = v_pl.slot;

  -- The victim loses score (never below zero) and is briefly slowed.
  update duo_players
    set score = greatest(0, score - v_steal_score),
        slowed_until = (extract(epoch from now()) * 1000)::bigint + 400
    where room_code = v_code and slot = v_opp.slot;

  return jsonb_build_object('ok', true, 'stolen', v_new_stolen, 'score', v_steal_score);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_start_round(p_code, p_token) — host starts the countdown for a round.
-- Assigns fresh objectives, resets per-round counters, spawns coins.
-- ---------------------------------------------------------------------------
create or replace function duo_start_round(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_room duo_rooms;
  v_count int;
  v_pair jsonb;
  v_seed text;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_countdown_end bigint;
  v_battle_end bigint;
begin
  v_pl := duo_require_player(v_code, p_token);

  if v_pl.player_id <> 'p1' then
    raise exception 'not_host' using errcode = 'P0001';
  end if;

  select * into v_room from duo_rooms where code = v_code;

  select count(*) into v_count from duo_players where room_code = v_code;
  if v_count < 2 then
    raise exception 'not_ready' using errcode = 'P0001';
  end if;

  -- Only start from lobby (first round) or results (next round).
  if v_room.phase not in ('lobby', 'results') then
    raise exception 'not_ready' using errcode = 'P0001';
  end if;

  v_seed := v_code || ':' || v_room.round::text;
  v_pair := duo_objective_pair(v_seed);

  v_countdown_end := v_now + 3000;
  v_battle_end := v_countdown_end + 90000;

  update duo_rooms
    set phase = 'countdown',
        countdown_ends_at = v_countdown_end,
        ends_at = v_battle_end,
        chaos_event = null,
        chaos_ends_at = 0,
        winner = null,
        round_seed = v_seed,
        updated_at = now()
    where code = v_code;

  update duo_players
    set objective = case when player_id = 'p1' then v_pair->'p1' else v_pair->'p2' end,
        coins = 0,
        stolen = 0,
        collected_types = '{}'::jsonb,
        score = 0,
        round_score = 0,
        mission_done = false,
        rematch = false,
        scout_charges = 2,
        scout_used_at = 0,
        revealed_hint = null,
        slowed_until = 0,
        x = case when slot = 1 then 18 else 82 end,
        y = 50
    where room_code = v_code;

  perform duo_spawn_coins(v_code);

  return jsonb_build_object('ok', true, 'round', v_room.round, 'countdownEndsAt', v_countdown_end);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_advance_phase(p_code, p_token) — move the room to the next phase.
-- countdown -> battle, battle -> results/matchover. Idempotent and guarded by
-- the stored deadlines so a late caller cannot skip a phase.
-- ---------------------------------------------------------------------------
create or replace function duo_advance_phase(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_room duo_rooms;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_round_scores jsonb;
  v_match_scores jsonb;
  v_next_phase duo_phase;
  v_winner text;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code for update;

  if v_room.phase = 'countdown' then
    if v_now < v_room.countdown_ends_at - 250 then
      raise exception 'not_ready' using errcode = 'P0001';
    end if;
    update duo_rooms
      set phase = 'battle',
          countdown_ends_at = 0,
          ends_at = v_now + 90000,
          updated_at = now()
      where code = v_code;
    return jsonb_build_object('ok', true, 'phase', 'battle');

  elsif v_room.phase = 'battle' then
    if v_now < v_room.ends_at - 500 then
      raise exception 'not_ready' using errcode = 'P0001';
    end if;

    -- Fold this round's scores into the cumulative match scores.
    v_round_scores := '{}'::jsonb;
    v_match_scores := coalesce(v_room.match_scores, '{}'::jsonb);

    update duo_players
      set round_score = score,
          total_score = coalesce((v_match_scores->>player_id)::int, 0) + score
      where room_code = v_code;

    select jsonb_object_agg(player_id, score) into v_round_scores
      from duo_players where room_code = v_code;

    select jsonb_object_agg(player_id, total_score) into v_match_scores
      from duo_players where room_code = v_code;

    v_next_phase := case when v_room.round >= 3 then 'matchover' else 'results' end;

    -- Winner is only decided at match end: highest cumulative score.
    if v_next_phase = 'matchover' then
      select player_id into v_winner
        from duo_players
        where room_code = v_code
        order by total_score desc, slot asc
        limit 1;
    end if;

    update duo_rooms
      set phase = v_next_phase,
          round_scores = v_round_scores,
          match_scores = v_match_scores,
          winner = v_winner,
          chaos_event = null,
          chaos_ends_at = 0,
          updated_at = now()
      where code = v_code;

    return jsonb_build_object('ok', true, 'phase', v_next_phase, 'winner', v_winner);

  elsif v_room.phase = 'results' then
    -- Host advances to the next round's countdown.
    if v_pl.player_id <> 'p1' then
      raise exception 'not_host' using errcode = 'P0001';
    end if;
    if v_room.round >= 3 then
      raise exception 'not_ready' using errcode = 'P0001';
    end if;

    update duo_rooms set round = round + 1, updated_at = now() where code = v_code;
    return duo_start_round(v_code, p_token);
  end if;

  return jsonb_build_object('ok', true, 'phase', v_room.phase);
end;
$$;
