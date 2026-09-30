-- ---------------------------------------------------------------------------
-- 0011_server_clock.sql — expose the server clock so clients can correct for
-- clock skew.
--
-- Problem: `duo_rooms.countdown_ends_at` / `ends_at` are absolute epoch-ms
-- values produced by the DATABASE clock. If a client's clock differs from the
-- database clock (common on VMs / serverless Postgres), the client compares
-- those deadlines against its own `Date.now()` and either fires the phase
-- transition immediately (skew ahead) or never (skew behind). The server then
-- rejects the premature `duo_advance_phase` with `not_ready`, and the room
-- appears stuck in `countdown`.
--
-- Fix: every snapshot / start response also returns `serverNow` (the database
-- clock at response time). The client computes `offset = serverNow - Date.now()`
-- and translates server deadlines into its own clock before storing them.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- duo_public_state(p_code, p_token) — now also returns `serverNow`.
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
      'collectedBy', c.collected_by
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
-- duo_start_round(p_code, p_token) — now also returns `serverNow`.
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

  -- Only start from lobby (first round) or results (next round).
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

  return jsonb_build_object(
    'ok', true,
    'round', v_room.round,
    'serverNow', v_now,
    'countdownEndsAt', v_countdown_end,
    'endsAt', v_battle_end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_advance_phase(p_code, p_token) — also return `serverNow` so the client
-- can keep its offset fresh across phase transitions.
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
    return jsonb_build_object('ok', true, 'phase', 'battle', 'serverNow', v_now, 'endsAt', v_now + 90000);

  elsif v_room.phase = 'battle' then
    if v_now < v_room.ends_at - 500 then
      raise exception 'not_ready' using errcode = 'P0001';
    end if;

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

    return jsonb_build_object('ok', true, 'phase', v_next_phase, 'winner', v_winner, 'serverNow', v_now);

  elsif v_room.phase = 'results' then
    if v_pl.player_id <> 'p1' then
      raise exception 'not_host' using errcode = 'P0001';
    end if;
    if v_room.round >= 3 then
      raise exception 'not_ready' using errcode = 'P0001';
    end if;

    update duo_rooms set round = round + 1, updated_at = now() where code = v_code;
    return duo_start_round(v_code, p_token);
  end if;

  return jsonb_build_object('ok', true, 'phase', v_room.phase, 'serverNow', v_now);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (idempotent).
-- ---------------------------------------------------------------------------
grant execute on function duo_public_state(text, text) to anon, authenticated;
grant execute on function duo_start_round(text, text) to anon, authenticated;
grant execute on function duo_advance_phase(text, text) to anon, authenticated;

-- Reload the PostgREST schema cache so the new response shape is picked up.
notify pgrst, 'reload schema';
