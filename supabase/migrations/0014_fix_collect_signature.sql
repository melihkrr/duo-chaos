-- ===========================================================================
-- 0014_fix_collect_signature.sql
--
-- Fixes regressions introduced by 0013_coin_respawn_same_spot.sql:
--
--   1. duo_collect was redefined with a 2-argument signature
--      `duo_collect(p_token text, p_coin_id int)` — WITHOUT `p_code`.
--      The client always calls it as `duo_collect(p_code, p_token, p_coin_id)`
--      (lib/useRoom.ts injects `p_code`), so PostgREST could not resolve the
--      function and every coin collection failed with a 404/400 RPC error.
--      We restore the canonical 3-argument signature and drop the broken 2-arg
--      overload.
--
--   2. The 0013 duo_collect looked the player up by token ONLY
--      (`where token = p_token`), ignoring the room. Tokens are unique per
--      room, but scoping by room is the correct, safe behaviour and matches
--      every other RPC (duo_require_player).
--
--   3. The 0013 duo_collect called `duo_random_objective(v_pl.objective)`,
--      passing a jsonb where the function expects text (`p_exclude text`).
--      Postgres would either fail to resolve the call or coerce the jsonb to
--      its text representation, producing a bogus exclude id. We pass
--      `v_pl.objective->>'id'` instead.
--
--   4. The 0013 duo_tick dropped the `duo_require_player` guard and inserted a
--      Diamond on EVERY tick (the jackpot check was unconditional), so a
--      diamond spawned constantly regardless of the chaos event. We restore
--      the guarded, event-driven behaviour.
--
--   5. The 0013 duo_tick also dropped the countdown→battle transition, the
--      chaos-event scheduling, the resource wave and the magnet drift. We
--      restore the full tick from 0012 while keeping the 0013 improvement
--      (respawn at the SAME spot, new colour only).
--
-- Idempotent: safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Drop the broken 2-argument overload created by 0013.
-- ---------------------------------------------------------------------------
drop function if exists duo_collect(text, int);

-- ---------------------------------------------------------------------------
-- 2. Restore duo_collect with the canonical 3-argument signature.
--    Behaviour: credit the coin, schedule a same-spot respawn 3s out, and
--    advance the objective chain when the objective becomes satisfied.
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
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_satisfied boolean;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'room_not_found');
  end if;
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
  if v_dist > 12 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  -- Chaos is only in effect until its deadline.
  v_value := duo_coin_value(
    v_coin.type,
    case when v_room.chaos_ends_at > v_now then v_room.chaos_event else null end,
    v_pl.objective
  );

  -- Mark collected AND schedule a same-spot respawn 3s out (new colour later).
  update duo_coins
    set collected_by = v_pl.player_id,
        collected_at = v_now,
        respawn_at = v_now + 3000
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
        mission_done = duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    where room_code = v_code and slot = v_pl.slot;

  -- Objective chain: if the objective is now satisfied, reroll it.
  select duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    into v_satisfied;
  if v_satisfied then
    perform duo_reroll_objective(v_code, v_pl.slot);
  end if;

  return jsonb_build_object('ok', true, 'value', v_value, 'type', v_coin.type, 'objectiveDone', v_satisfied);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Restore duo_tick: full world tick (countdown→battle, chaos scheduling,
--    resource wave, magnet drift) with the 0013 same-spot respawn behaviour.
--    The Diamond is only inserted for the `jackpot` chaos event.
-- ---------------------------------------------------------------------------
create or replace function duo_tick(p_code text, p_token text)
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
  v_battle_start bigint;
  v_half bigint;
  v_wave int;
  v_event duo_chaos_event;
  v_has_diamond boolean;
  v_changed boolean := false;
  v_respawned int;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  -- 1. countdown -> battle
  if v_room.phase = 'countdown' and v_now >= v_room.countdown_ends_at then
    update duo_rooms
      set phase = 'battle',
          countdown_ends_at = 0,
          ends_at = v_now + 90000,
          updated_at = now()
      where code = v_code;
    v_room.phase := 'battle';
    v_room.ends_at := v_now + 90000;
    v_changed := true;
  end if;

  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', true, 'phase', v_room.phase, 'changed', v_changed);
  end if;

  v_battle_start := v_room.ends_at - 90000;
  v_half := v_battle_start + 45000;

  -- 2. trigger chaos event at the halfway point (once per round)
  if v_room.chaos_event is null and v_now >= v_half then
    v_event := duo_chaos_for_round(v_room.round_seed);

    insert into duo_events (room_code, round, event, started_at, ends_at)
    values (v_code, v_room.round, v_event, v_now, v_now + 15000);

    -- Diamond appears ONLY for the jackpot event.
    if v_event = 'jackpot' then
      select exists(
        select 1 from duo_coins
        where room_code = v_code and type = 'diamond' and collected_by is null
      ) into v_has_diamond;

      if not v_has_diamond then
        insert into duo_coins (room_code, coin_id, x, y, type)
        values (v_code, 900 + v_room.round, 50, 50, 'diamond')
        on conflict (room_code, coin_id) do nothing;
      end if;
    end if;

    if v_event = 'swap' then
      update duo_players p
        set objective = o.objective
        from (
          select
            player_id,
            lead(objective) over (order by slot) as objective,
            lag(objective) over (order by slot) as prev_objective
          from duo_players
          where room_code = v_code
        ) o
        where p.room_code = v_code
          and p.player_id = o.player_id
          and o.objective is not null;
    end if;

    update duo_rooms
      set chaos_event = v_event,
          chaos_ends_at = v_now + 15000,
          updated_at = now()
      where code = v_code;

    v_room.chaos_event := v_event;
    v_room.chaos_ends_at := v_now + 15000;
    v_changed := true;
  end if;

  -- 3. expire the chaos event
  if v_room.chaos_event is not null and v_now >= v_room.chaos_ends_at then
    update duo_rooms
      set chaos_event = null, chaos_ends_at = 0, updated_at = now()
      where code = v_code;
    v_room.chaos_event := null;
    v_room.chaos_ends_at := 0;
    v_changed := true;
  end if;

  -- 4. resource wave every 12s of battle
  v_wave := floor((v_now - v_battle_start) / 12000.0)::int;
  if v_wave > 0 then
    perform duo_spawn_wave(v_code, v_room.round, v_wave);
  end if;

  -- 5. magnet drift toward the centre
  if v_room.chaos_event = 'magnet' and v_now < v_room.chaos_ends_at then
    update duo_coins
      set x = x + (50 - x) * 0.018,
          y = y + (50 - y) * 0.018
      where room_code = v_code
        and collected_by is null
        and type <> 'diamond';
    v_changed := true;
  end if;

  -- 6. respawn collected coins whose timer elapsed — SAME spot, new colour.
  update duo_coins
    set type = (array['gold','blue','red','emerald']::duo_coin_type[])[floor(random() * 4)::int + 1],
        collected_by = null,
        collected_at = 0,
        respawn_at = 0
    where room_code = v_code
      and collected_by is not null
      and respawn_at > 0
      and respawn_at <= v_now
      and type <> 'diamond';

  get diagnostics v_respawned = row_count;
  if v_respawned > 0 then
    v_changed := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'phase', v_room.phase,
    'chaosEvent', v_room.chaos_event,
    'chaosEndsAt', v_room.chaos_ends_at,
    'changed', v_changed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grants for the restored signatures.
-- ---------------------------------------------------------------------------
grant execute on function duo_collect(text, text, int) to anon, authenticated;
grant execute on function duo_tick(text, text) to anon, authenticated;
