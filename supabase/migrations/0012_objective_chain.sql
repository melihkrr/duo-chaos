-- ============================================================================
-- DUO CHAOS — 0012 objective chain, score = completed objectives, coin respawn
--
-- Changes the core scoring loop:
--   1. `duo_players.objectives_done` — how many objectives the player finished.
--      This IS the player's score (score = objectives_done).
--   2. When a player completes their objective, the server immediately assigns
--      a fresh RANDOM objective and increments `objectives_done`.
--   3. Collected coins respawn after a delay at a random position with a random
--      type, so the arena stays alive for the whole round.
--
-- The client mirrors this optimistically (lib/useGameLoop.ts) but the server
-- remains authoritative: `duo_public_state` returns `objectivesDone`, and the
-- collect/steal RPCs reroll the objective server-side.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. objectives_done column
-- ---------------------------------------------------------------------------
alter table duo_players
  add column if not exists objectives_done int not null default 0;

-- ---------------------------------------------------------------------------
-- 2. Coin respawn bookkeeping
--    `respawn_at` = epoch-ms when a collected coin becomes available again.
-- ---------------------------------------------------------------------------
alter table duo_coins
  add column if not exists respawn_at bigint not null default 0;

-- ---------------------------------------------------------------------------
-- 3. Random objective picker — mirrors randomObjective() in lib/config.ts.
--    Picks a random objective from the pool, avoiding `p_exclude` when possible.
-- ---------------------------------------------------------------------------
create or replace function duo_random_objective(p_exclude text default null)
returns jsonb
language plpgsql
volatile
as $$
declare
  pool jsonb := duo_objective_pool();
  candidates jsonb;
  picked jsonb;
begin
  select jsonb_agg(elem) into candidates
    from jsonb_array_elements(pool) as elem
    where p_exclude is null or (elem->>'id') <> p_exclude;

  if candidates is null or jsonb_array_length(candidates) = 0 then
    candidates := pool;
  end if;

  select elem into picked
    from jsonb_array_elements(candidates) as elem
    order by random()
    limit 1;

  return coalesce(picked, pool->0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. duo_reroll_objective(p_room, p_slot) — advance the objective chain.
--    Increments objectives_done, sets score = objectives_done, assigns a fresh
--    random objective and clears the per-objective progress counters.
-- ---------------------------------------------------------------------------
create or replace function duo_reroll_objective(p_room text, p_slot int)
returns void
language plpgsql
as $$
declare
  v_pl duo_players;
  v_done int;
  v_next jsonb;
begin
  select * into v_pl from duo_players where room_code = p_room and slot = p_slot for update;
  if not found then return; end if;

  v_done := coalesce(v_pl.objectives_done, 0) + 1;
  v_next := duo_random_objective(v_pl.objective->>'id');

  update duo_players
    set objectives_done = v_done,
        -- Skor = tamamlanan görev sayısı.
        score = v_done,
        round_score = v_done,
        objective = v_next,
        coins = 0,
        stolen = 0,
        collected_types = '{}'::jsonb,
        mission_done = false
    where room_code = p_room and slot = p_slot;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. duo_coin_value — unchanged behaviour, kept for reference (defined in 0002).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. duo_collect — after crediting the coin, check whether the objective is now
--    satisfied; if so, reroll it (objective chain). Also stamp `respawn_at` so
--    the coin comes back later.
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
    case when v_room.chaos_ends_at > v_now then v_room.chaos_event else null end,
    v_pl.objective
  );

  -- Mark collected AND schedule a respawn (random position + type later).
  update duo_coins
    set collected_by = v_pl.player_id,
        collected_at = v_now,
        respawn_at = v_now + 4000
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
-- 7. duo_steal — same objective-chain treatment after a successful steal.
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
  v_new_stolen int;
  v_satisfied boolean;
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
        mission_done = duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    where room_code = v_code and slot = v_pl.slot;

  -- The victim loses a coin and is briefly slowed.
  update duo_players
    set coins = greatest(0, coins - 1),
        slowed_until = (extract(epoch from now()) * 1000)::bigint + 400
    where room_code = v_code and slot = v_opp.slot;

  -- Objective chain: reroll if the steal objective is now satisfied.
  select duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    into v_satisfied;
  if v_satisfied then
    perform duo_reroll_objective(v_code, v_pl.slot);
  end if;

  return jsonb_build_object('ok', true, 'stolen', v_new_stolen, 'objectiveDone', v_satisfied);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. duo_tick — respawn collected coins whose timer has elapsed. Each respawn
--    gets a random position and a random type (diamond excluded).
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

  -- 6. respawn collected coins whose timer elapsed — random spot + random type.
  update duo_coins
    set x = 8 + random() * 84,
        y = 8 + random() * 84,
        type = (array['gold','blue','red','emerald']::duo_coin_type[])[floor(random() * 4)::int + 1],
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
-- 9. duo_public_state — expose `objectivesDone` and coin `respawnAt`.
-- ---------------------------------------------------------------------------
create or replace function duo_public_state(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_me duo_players;
  v_room duo_rooms;
  v_count int;
  v_players jsonb;
  v_coins jsonb;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  select * into v_me from duo_players where room_code = v_code and token = p_token;
  if not found then
    raise exception 'not_member' using errcode = 'P0001';
  end if;

  select count(*) into v_count from duo_players where room_code = v_code;

  select jsonb_agg(
    jsonb_build_object(
      'id', p.player_id,
      'name', p.name,
      'x', p.x,
      'y', p.y,
      'coins', p.coins,
      'stolen', p.stolen,
      'score', p.score,
      'roundScore', p.round_score,
      'totalScore', p.total_score,
      'objectivesDone', p.objectives_done,
      'collectedTypes', p.collected_types,
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
    'playerCount', v_count,
    'serverNow', v_now,
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
-- 10. duo_start_round — reset objectives_done to 0 for the new round.
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
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'room_not_found');
  end if;

  select * into v_pl from duo_players where room_code = v_code and token = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;

  if v_pl.player_id <> 'p1' then
    return jsonb_build_object('ok', false, 'reason', 'not_host');
  end if;

  select count(*) into v_count from duo_players where room_code = v_code;
  if v_count < 2 then
    return jsonb_build_object('ok', false, 'reason', 'not_ready');
  end if;

  if v_room.phase not in ('lobby', 'results') then
    return jsonb_build_object('ok', false, 'reason', 'not_ready', 'phase', v_room.phase);
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
        objectives_done = 0,
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

  return jsonb_build_object('ok', true, 'round', v_room.round, 'countdownEndsAt', v_countdown_end, 'serverNow', v_now);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Grants (mirror 0008_grants.sql for the new function).
-- ---------------------------------------------------------------------------
grant execute on function duo_random_objective(text) to anon, authenticated;
grant execute on function duo_reroll_objective(text, int) to anon, authenticated;
