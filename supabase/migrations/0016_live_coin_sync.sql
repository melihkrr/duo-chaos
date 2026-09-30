-- ===========================================================================
-- 0016_live_coin_sync.sql
--
-- LIVE (server-authoritative) COIN SYNCHRONISATION
--
-- Problem
-- -------
-- Coins were effectively client-local:
--   * `duo_spawn_coins` used a DIFFERENT algorithm than the client
--     `spawnCoins()` (grid + xorshift32). The server therefore stored a coin
--     layout that did not match what either client rendered. Any snapshot that
--     adopted the server coins would visibly "teleport" every coin.
--   * `duo_tick` respawned a collected coin with a RANDOM new colour, while the
--     client kept the SAME colour. Even when both sides agreed on positions,
--     the colours diverged after the first respawn.
--   * `duo_public_state` did not expose `respawn_at`, so a client could not know
--     when a coin collected by the rival would come back.
--   * The client reconciliation effect ignored coins entirely, so any divergence
--     (packet loss, tab throttling, late join) was never healed.
--
-- Fix
-- ---
--   1. `duo_spawn_coins` now mirrors the client `spawnCoins()` EXACTLY
--      (FNV-1a seed hash → xorshift32 → Fisher–Yates over a 5x3 grid), using the
--      room's `round_seed` (which is `CODE:round`, identical to the client's
--      `roundSeed`). Both clients and the server now produce byte-identical
--      positions AND colours.
--   2. Respawn keeps the SAME colour (only the `collected_by` flag is cleared),
--      matching the client. Colour is bound to the coin "slot" (id) and only
--      re-rolled when a new round starts.
--   3. `duo_public_state` returns `respawnAt` and performs a LAZY respawn: any
--      coin whose `respawn_at` has elapsed is cleared on read. This makes the
--      snapshot self-healing even if `duo_tick` is never called.
--   4. New `duo_sync_coins(p_code, p_token)` RPC returns the authoritative coin
--      list (with lazy respawn applied) so clients can reconcile cheaply.
--
-- Idempotent: safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Deterministic coin layout — EXACT mirror of lib/config.ts spawnCoins().
--
--    JS reference:
--      hash: FNV-1a 32-bit over the seed string
--      next: xorshift32 → [0,1)
--      cells: 0..14 shuffled with Fisher–Yates (deterministic)
--      x = 12 + col*19 + (next()*6 - 3)
--      y = 16 + row*30 + (next()*8 - 4)
--      type = COIN_TYPES[floor(next()*4)]
--
--    Postgres has no native uint32, so we emulate the 32-bit wrap with
--    `& 4294967295` (bitwise AND on bigint) after every shift/xor. `>>` on a
--    non-negative bigint is a logical shift, matching JS `>>>`.
-- ---------------------------------------------------------------------------
create or replace function duo_spawn_coins(p_room text)
returns void
language plpgsql
as $$
declare
  v_seed text;
  v_state bigint;
  v_cells int[] := array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14];
  v_i int;
  v_j int;
  v_tmp int;
  v_r double precision;
  v_cell int;
  v_col int;
  v_row int;
  v_x double precision;
  v_y double precision;
  v_type duo_coin_type;
  v_types duo_coin_type[] := array['gold','blue','red','emerald']::duo_coin_type[];
  v_len int;
begin
  -- The client seeds with `round-${round}` for the very first round and with
  -- `CODE:round` for every round started by `duo_start_round`. We prefer the
  -- room's stored `round_seed` (authoritative) and fall back to `round-N`.
  select coalesce(nullif(round_seed, ''), 'round-' || round::text)
    into v_seed
    from duo_rooms
    where code = p_room;

  if v_seed is null then
    v_seed := 'round-1';
  end if;

  -- FNV-1a 32-bit hash of the seed (matches the JS implementation).
  v_state := 2166136261;
  v_len := length(v_seed);
  for v_i in 1..v_len loop
    v_state := (v_state # (ascii(substr(v_seed, v_i, 1)))) & 4294967295;
    v_state := (v_state * 16777619) & 4294967295;
  end loop;
  if v_state = 0 then
    v_state := 1;
  end if;

  -- Fisher–Yates shuffle of the 15 grid cells (deterministic).
  for v_i in reverse 14..1 loop
    -- next(): xorshift32
    v_state := (v_state # ((v_state << 13) & 4294967295)) & 4294967295;
    v_state := (v_state # (v_state >> 17)) & 4294967295;
    v_state := (v_state # ((v_state << 5) & 4294967295)) & 4294967295;
    v_r := (v_state & 4294967295)::double precision / 4294967296.0;
    v_j := floor(v_r * (v_i + 1))::int;
    v_tmp := v_cells[v_i + 1];
    v_cells[v_i + 1] := v_cells[v_j + 1];
    v_cells[v_j + 1] := v_tmp;
  end loop;

  delete from duo_coins where room_code = p_room;

  for v_i in 0..13 loop
    v_cell := v_cells[(v_i % 15) + 1];
    v_col := v_cell % 5;
    v_row := v_cell / 5;

    -- x = 12 + col*19 + (next()*6 - 3)
    v_state := (v_state # ((v_state << 13) & 4294967295)) & 4294967295;
    v_state := (v_state # (v_state >> 17)) & 4294967295;
    v_state := (v_state # ((v_state << 5) & 4294967295)) & 4294967295;
    v_r := (v_state & 4294967295)::double precision / 4294967296.0;
    v_x := 12 + v_col * 19 + (v_r * 6 - 3);

    -- y = 16 + row*30 + (next()*8 - 4)
    v_state := (v_state # ((v_state << 13) & 4294967295)) & 4294967295;
    v_state := (v_state # (v_state >> 17)) & 4294967295;
    v_state := (v_state # ((v_state << 5) & 4294967295)) & 4294967295;
    v_r := (v_state & 4294967295)::double precision / 4294967296.0;
    v_y := 16 + v_row * 30 + (v_r * 8 - 4);

    -- type = COIN_TYPES[floor(next()*4)]
    v_state := (v_state # ((v_state << 13) & 4294967295)) & 4294967295;
    v_state := (v_state # (v_state >> 17)) & 4294967295;
    v_state := (v_state # ((v_state << 5) & 4294967295)) & 4294967295;
    v_r := (v_state & 4294967295)::double precision / 4294967296.0;
    v_type := v_types[floor(v_r * 4)::int + 1];

    insert into duo_coins (room_code, coin_id, x, y, type)
    values (p_room, v_i, round(v_x::numeric, 4), round(v_y::numeric, 4), v_type);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Lazy respawn helper — clears `collected_by` for every coin whose
--    `respawn_at` has elapsed. Colour is PRESERVED (bound to the slot).
--    Returns the number of coins that came back.
-- ---------------------------------------------------------------------------
create or replace function duo_respawn_coins(p_room text)
returns int
language plpgsql
as $$
declare
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_count int;
begin
  update duo_coins
    set collected_by = null,
        collected_at = 0,
        respawn_at = 0
    where room_code = p_room
      and collected_by is not null
      and respawn_at > 0
      and respawn_at <= v_now
      and type <> 'diamond';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. duo_tick — keep the full world tick, but respawn WITHOUT changing colour
--    (previously it re-rolled a random colour, diverging from the client).
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

  -- 6. respawn collected coins whose timer elapsed — SAME spot, SAME colour.
  v_respawned := duo_respawn_coins(v_code);
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
-- 4. duo_public_state — expose `respawnAt` and apply the lazy respawn so the
--    snapshot is self-healing even when `duo_tick` is never called.
-- ---------------------------------------------------------------------------
create or replace function duo_public_state(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_room duo_rooms;
  v_me duo_players;
  v_players jsonb;
  v_coins jsonb;
begin
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  v_me := duo_require_player(v_code, p_token);

  update duo_players set last_seen_at = now()
    where room_code = v_code and slot = v_me.slot;

  -- LAZY RESPAWN: bring back any coin whose timer has elapsed before we build
  -- the snapshot. This keeps both clients converged even if `duo_tick` is idle.
  perform duo_respawn_coins(v_code);

  -- Build the player list. Objectives are only exposed for the caller, or for
  -- the opponent when the caller has scouted them (revealed_hint is set).
  select jsonb_agg(
    jsonb_build_object(
      'id', p.player_id,
      'name', p.name,
      'x', p.x,
      'y', p.y,
      'coins', p.coins,
      'stolen', p.stolen,
      'collectedTypes', p.collected_types,
      'score', p.score,
      'roundScore', p.round_score,
      'totalScore', p.total_score,
      'objective',
        case
          when p.player_id = v_me.player_id then p.objective
          when v_me.revealed_hint is not null then p.objective
          else null
        end,
      'missionDone', p.mission_done,
      'rematch', p.rematch,
      'emote', p.emote,
      'trail', p.trail,
      'slowedUntil', p.slowed_until,
      'scoutCharges', case when p.player_id = v_me.player_id then p.scout_charges else null end,
      'revealedHint', case when p.player_id = v_me.player_id then v_me.revealed_hint else null end
    )
    order by p.slot
  )
  into v_players
  from duo_players p
  where p.room_code = v_code;

  select jsonb_agg(
    jsonb_build_object(
      'id', c.coin_id,
      'x', c.x,
      'y', c.y,
      'type', c.type,
      'collectedBy', c.collected_by,
      'respawnAt', c.respawn_at
    )
    order by c.coin_id
  )
  into v_coins
  from duo_coins c
  where c.room_code = v_code;

  return jsonb_build_object(
    'phase', v_room.phase,
    'round', v_room.round,
    'playerCount', (select count(*) from duo_players where room_code = v_code),
    'countdownEndsAt', v_room.countdown_ends_at,
    'endsAt', v_room.ends_at,
    'chaosEvent', case when v_room.chaos_event is null then null else jsonb_build_object(
        'id', v_room.chaos_event,
        'name', case v_room.chaos_event
          when 'gold-rush' then 'Gold Rush'
          when 'blackout'  then 'Blackout'
          when 'magnet'    then 'Magnet Storm'
          when 'swap'      then 'Chaos Swap'
          when 'jackpot'   then 'Jackpot'
        end,
        'description', case v_room.chaos_event
          when 'gold-rush' then 'Gold spawns are boosted for 15s.'
          when 'blackout'  then 'The arena dims and nearby resources become more valuable.'
          when 'magnet'    then 'Coins drift toward the center and pressure rises.'
          when 'swap'      then 'One of your targets is swapped mid-round.'
          when 'jackpot'   then 'A single Diamond appears. First player gets +50.'
        end,
        'boost', case v_room.chaos_event
          when 'gold-rush' then 'Gold reward x3'
          when 'blackout'  then 'Risky visibility'
          when 'magnet'    then 'Resource control'
          when 'swap'      then 'Plans break'
          when 'jackpot'   then 'Diamond +50'
        end
      ) end,
    'chaosEventEndsAt', v_room.chaos_ends_at,
    'winner', v_room.winner,
    'roundScores', v_room.round_scores,
    'matchScores', v_room.match_scores,
    'players', coalesce(v_players, '[]'::jsonb),
    'coins', coalesce(v_coins, '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. duo_sync_coins — lightweight authoritative coin list for reconciliation.
--    Applies the lazy respawn, then returns the full coin set.
-- ---------------------------------------------------------------------------
create or replace function duo_sync_coins(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_me duo_players;
  v_coins jsonb;
begin
  v_me := duo_require_player(v_code, p_token);

  perform duo_respawn_coins(v_code);

  select jsonb_agg(
    jsonb_build_object(
      'id', c.coin_id,
      'x', c.x,
      'y', c.y,
      'type', c.type,
      'collectedBy', c.collected_by,
      'respawnAt', c.respawn_at
    )
    order by c.coin_id
  )
  into v_coins
  from duo_coins c
  where c.room_code = v_code;

  return jsonb_build_object('ok', true, 'coins', coalesce(v_coins, '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants.
-- ---------------------------------------------------------------------------
grant execute on function duo_spawn_coins(text) to anon, authenticated;
grant execute on function duo_respawn_coins(text) to anon, authenticated;
grant execute on function duo_tick(text, text) to anon, authenticated;
grant execute on function duo_public_state(text, text) to anon, authenticated;
grant execute on function duo_sync_coins(text, text) to anon, authenticated;
