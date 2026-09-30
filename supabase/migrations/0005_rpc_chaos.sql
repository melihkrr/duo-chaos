-- ============================================================================
-- DUO CHAOS — 0005 RPC: server-authoritative chaos events & world tick
-- duo_tick — advances the world clock: triggers chaos events, spawns resource
-- waves and applies the magnet drift. Called by any client; safe to call often
-- because every mutation is guarded by deadlines stored on the room row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Deterministic chaos event for a round seed — mirrors chaosEventForRound()
-- ---------------------------------------------------------------------------
create or replace function duo_chaos_for_round(p_seed text)
returns duo_chaos_event
language plpgsql
immutable
as $$
declare
  events duo_chaos_event[] := array['gold-rush','blackout','magnet','swap','jackpot']::duo_chaos_event[];
  total int := 0;
  i int;
begin
  for i in 1..char_length(p_seed) loop
    total := total + ascii(substr(p_seed, i, 1));
  end loop;
  return events[(total % 5) + 1];
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_tick(p_code, p_token) — advance the world by one server tick.
-- Responsibilities:
--   1. countdown -> battle transition when the countdown deadline passes
--   2. trigger the round's chaos event at the halfway point of the battle
--   3. spawn a resource wave every 12s of battle
--   4. apply magnet drift while the magnet event is active
--   5. expire the chaos event when its deadline passes
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

    -- jackpot: drop a single diamond in the centre if none exists
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

    -- swap: exchange the two players' objectives
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

  -- 5. expire the chaos event
  if v_room.chaos_event is not null and v_now >= v_room.chaos_ends_at then
    update duo_rooms
      set chaos_event = null, chaos_ends_at = 0, updated_at = now()
      where code = v_code;
    v_room.chaos_event := null;
    v_room.chaos_ends_at := 0;
    v_changed := true;
  end if;

  -- 3. resource wave every 12s of battle
  v_wave := floor((v_now - v_battle_start) / 12000.0)::int;
  if v_wave > 0 then
    perform duo_spawn_wave(v_code, v_room.round, v_wave);
  end if;

  -- 4. magnet drift toward the centre
  if v_room.chaos_event = 'magnet' and v_now < v_room.chaos_ends_at then
    update duo_coins
      set x = x + (50 - x) * 0.018,
          y = y + (50 - y) * 0.018
      where room_code = v_code
        and collected_by is null
        and type <> 'diamond';
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
