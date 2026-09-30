-- ============================================================================
-- DUO CHAOS — 0010 Lobby readiness
--
-- Problem: the host's "Start match" button was gated on Supabase Realtime
-- *presence*, which flips to `true` the moment the rival's channel subscribes.
-- That can happen before the rival's `duo_join_room` row is committed (or when
-- the rival joined through a stale link whose row no longer exists). The host
-- then called `duo_start_round`, which correctly rejected with `not_ready`
-- because `count(duo_players) < 2`.
--
-- Fix: make the database the single source of truth for lobby readiness.
--   1. `duo_public_state` now exposes `playerCount` (real row count).
--   2. `duo_start_round` returns a structured `{ok:false, reason}` instead of
--      raising, so the client can show a friendly message and retry.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- duo_public_state(p_code, p_token) — add `playerCount` to the snapshot.
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
  v_count int;
begin
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  v_me := duo_require_player(v_code, p_token);

  update duo_players set last_seen_at = now()
    where room_code = v_code and slot = v_me.slot;

  select count(*) into v_count from duo_players where room_code = v_code;

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
    'playerCount', v_count,
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
-- duo_start_round(p_code, p_token) — soft failure instead of raising.
--
-- Returns `{ok:false, reason:'not_ready'|'not_host'|'room_not_found'}` so the
-- client can surface a friendly message and simply retry once the rival's row
-- has landed. On success returns `{ok:true, round, countdownEndsAt, endsAt}`.
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
    'countdownEndsAt', v_countdown_end,
    'endsAt', v_battle_end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (idempotent — signatures are unchanged, but re-grant for safety).
-- ---------------------------------------------------------------------------
grant execute on function duo_public_state(text, text) to anon, authenticated;
grant execute on function duo_start_round(text, text) to anon, authenticated;
