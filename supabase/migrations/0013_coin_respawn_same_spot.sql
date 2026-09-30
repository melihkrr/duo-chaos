-- ===========================================================================
-- 0013_coin_respawn_same_spot.sql
--
-- Aligns the SERVER coin respawn with the CLIENT behaviour:
--   * a collected coin reappears at the SAME (x, y) after 3 seconds
--   * only its colour (type) is randomised
--
-- Why: the client (lib/useGameLoop.ts) is the authoritative source for coin
-- respawn during a round — it respawns coins locally at the same spot after
-- COIN_RESPAWN_MS (3000ms). The server previously respawned at a RANDOM
-- position with a RANDOM type after 4000ms (duo_tick). If both ran, coins
-- would "teleport" and change colour, which is exactly the flicker the player
-- reported. This migration makes the server match the client so the two can
-- never disagree.
--
-- Idempotent: safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_collect — schedule the respawn 3s out (was 4000ms).
-- ---------------------------------------------------------------------------
create or replace function duo_collect(p_token text, p_coin_id int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pl duo_players;
  v_room duo_rooms;
  v_coin duo_coins;
  v_dist numeric;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_collected jsonb;
  v_satisfied boolean;
  v_next text;
begin
  select * into v_pl from duo_players where token = p_token;
  if not found then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;

  select * into v_room from duo_rooms where code = v_pl.room_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;
  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', false, 'reason', 'not_battle');
  end if;

  select * into v_coin
    from duo_coins
    where room_code = v_pl.room_code and coin_id = p_coin_id
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_coin');
  end if;
  if v_coin.collected_by is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_collected');
  end if;

  v_dist := sqrt(power(v_coin.x - v_pl.x, 2) + power(v_coin.y - v_pl.y, 2));
  if v_dist > 12 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  -- Mark collected AND schedule a respawn 3s out (same spot, new colour).
  update duo_coins
    set collected_by = v_pl.player_id,
        collected_at = v_now,
        respawn_at = v_now + 3000
    where room_code = v_pl.room_code and coin_id = p_coin_id;

  v_collected := coalesce(v_pl.collected_types, '{}'::jsonb);
  v_collected := jsonb_set(
    v_collected,
    array[v_coin.type::text],
    to_jsonb(coalesce((v_collected ->> v_coin.type::text)::int, 0) + 1)
  );

  update duo_players
    set coins = coins + 1,
        collected_types = v_collected,
        mission_done = duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    where room_code = v_pl.room_code and slot = v_pl.slot;

  -- Objective chain: if the objective is now satisfied, reroll it.
  select duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    into v_satisfied;
  if v_satisfied then
    v_next := duo_random_objective(v_pl.objective);
    update duo_players
      set objective = v_next,
          objectives_done = objectives_done + 1,
          score = objectives_done + 1,
          round_score = objectives_done + 1,
          coins = 0,
          stolen = 0,
          collected_types = '{}'::jsonb,
          mission_done = false
      where room_code = v_pl.room_code and slot = v_pl.slot;
  end if;

  return jsonb_build_object('ok', true, 'coin', p_coin_id, 'type', v_coin.type);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. duo_tick — respawn collected coins at the SAME spot, new colour only.
-- ---------------------------------------------------------------------------
create or replace function duo_tick(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room duo_rooms;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_changed boolean := false;
  v_respawned int := 0;
  v_has_diamond boolean;
begin
  select * into v_room from duo_rooms where code = p_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  -- 1. respawn collected coins whose timer elapsed — SAME spot, new colour.
  update duo_coins
    set type = (array['gold','blue','red','emerald']::duo_coin_type[])[floor(random() * 4)::int + 1],
        collected_by = null,
        collected_at = 0,
        respawn_at = 0
    where room_code = p_code
      and collected_by is not null
      and respawn_at > 0
      and respawn_at <= v_now
      and type <> 'diamond';

  get diagnostics v_respawned = row_count;
  if v_respawned > 0 then
    v_changed := true;
  end if;

  -- 2. ensure a diamond exists (jackpot) — unchanged behaviour.
  select exists(
    select 1 from duo_coins
    where room_code = p_code and type = 'diamond' and collected_by is null
  ) into v_has_diamond;

  if not v_has_diamond then
    insert into duo_coins (room_code, coin_id, x, y, type)
    values (p_code, 900 + v_room.round, 50, 50, 'diamond')
    on conflict (room_code, coin_id) do nothing;
    v_changed := true;
  end if;

  return jsonb_build_object('ok', true, 'changed', v_changed, 'respawned', v_respawned);
end;
$$;

grant execute on function duo_collect(text, int) to anon, authenticated;
grant execute on function duo_tick(text, text) to anon, authenticated;
