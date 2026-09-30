-- ============================================================================
-- DUO CHAOS — 0003 RPC: room lifecycle
-- duo_create_room, duo_join_room, duo_leave, duo_rematch, duo_public_state
-- ============================================================================

-- ---------------------------------------------------------------------------
-- duo_create_room(p_code, p_token) — host creates the room (slot 1)
-- ---------------------------------------------------------------------------
create or replace function duo_create_room(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_existing duo_rooms;
begin
  if v_code !~ '^[A-Z0-9]{6}$' then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;

  select * into v_existing from duo_rooms where code = v_code;
  if found then
    raise exception 'room_exists' using errcode = 'P0001';
  end if;

  insert into duo_rooms (code, phase, round, round_seed)
  values (v_code, 'lobby', 1, v_code || ':1');

  insert into duo_players (room_code, slot, player_id, token, name, x, y)
  values (v_code, 1, 'p1', p_token, 'PLAYER 1', 18, 50);

  perform duo_spawn_coins(v_code);

  return jsonb_build_object('code', v_code, 'slot', 1, 'player_id', 'p1');
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_join_room(p_code, p_token) — second player joins (slot 2).
-- Idempotent: if the token already belongs to a slot, return that slot.
-- ---------------------------------------------------------------------------
create or replace function duo_join_room(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_room duo_rooms;
  v_existing duo_players;
  v_count int;
begin
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  -- Already a member? Return the existing slot (reconnect path).
  select * into v_existing
    from duo_players
    where room_code = v_code and token = p_token;
  if found then
    update duo_players set last_seen_at = now()
      where room_code = v_code and slot = v_existing.slot;
    return jsonb_build_object('code', v_code, 'slot', v_existing.slot, 'player_id', v_existing.player_id);
  end if;

  select count(*) into v_count from duo_players where room_code = v_code;
  if v_count >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  insert into duo_players (room_code, slot, player_id, token, name, x, y)
  values (v_code, 2, 'p2', p_token, 'PLAYER 2', 82, 50);

  return jsonb_build_object('code', v_code, 'slot', 2, 'player_id', 'p2');
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_leave(p_code, p_token) — remove the caller from the room.
-- If the room becomes empty it is deleted (cascades coins/players).
-- ---------------------------------------------------------------------------
create or replace function duo_leave(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_remaining int;
begin
  select * into v_pl from duo_players where room_code = v_code and token = p_token;
  if not found then
    return jsonb_build_object('ok', true, 'removed', false);
  end if;

  delete from duo_players where room_code = v_code and slot = v_pl.slot;

  select count(*) into v_remaining from duo_players where room_code = v_code;
  if v_remaining = 0 then
    delete from duo_rooms where code = v_code;
  end if;

  return jsonb_build_object('ok', true, 'removed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_rematch(p_code, p_token) — flag the caller ready; when both are ready,
-- reset the room back to the lobby for a fresh match.
-- ---------------------------------------------------------------------------
create or replace function duo_rematch(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_ready int;
begin
  v_pl := duo_require_player(v_code, p_token);

  update duo_players set rematch = true
    where room_code = v_code and slot = v_pl.slot;

  select count(*) into v_ready
    from duo_players where room_code = v_code and rematch = true;

  if v_ready >= 2 then
    update duo_rooms
      set phase = 'lobby',
          round = 1,
          countdown_ends_at = 0,
          ends_at = 0,
          chaos_event = null,
          chaos_ends_at = 0,
          winner = null,
          round_scores = '{}'::jsonb,
          match_scores = '{}'::jsonb,
          round_seed = v_code || ':1',
          updated_at = now()
      where code = v_code;

    update duo_players
      set coins = 0, stolen = 0, collected_types = '{}'::jsonb,
          score = 0, round_score = 0, total_score = 0,
          mission_done = false, rematch = false,
          scout_charges = 2, scout_used_at = 0, revealed_hint = null,
          slowed_until = 0,
          x = case when slot = 1 then 18 else 82 end,
          y = 50
      where room_code = v_code;

    perform duo_spawn_coins(v_code);
  end if;

  return jsonb_build_object('ok', true, 'ready', v_ready);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_public_state(p_code, p_token) — the authoritative snapshot the client
-- polls. The opponent's objective is redacted unless revealed via scouting.
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
