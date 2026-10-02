create or replace function duo_chaos_for_round(p_seed text)
returns duo_chaos_event
language plpgsql
immutable
as $$
declare
  events duo_chaos_event[] := array[
    'gold-rush',
    'blackout',
    'magnet',
    'swap',
    'jackpot',
    'double-score',
    'red-alert'
  ]::duo_chaos_event[];
  total int := 0;
  i int;
begin
  for i in 1..char_length(p_seed) loop
    total := total + ascii(substr(p_seed, i, 1));
  end loop;
  return events[(total % array_length(events, 1)) + 1];
end;
$$;

create or replace function duo_coin_value(
  p_type duo_coin_type,
  p_chaos duo_chaos_event,
  p_objective jsonb
)
returns int
language plpgsql
immutable
as $$
declare
  is_target boolean := false;
  base int;
begin
  if p_type = 'diamond' then return 50; end if;

  if p_objective is not null then
    if (p_objective->'requirements') ? p_type::text then
      is_target := true;
    elsif (p_objective->>'coinType') = p_type::text then
      is_target := true;
    end if;
  end if;

  base := case
    when p_type = 'emerald' then 25
    when is_target then 15
    else 5
  end;

  if p_chaos = 'gold-rush' and p_type = 'gold' then
    return base + 25;
  end if;
  if p_chaos = 'double-score' then
    return base * 2;
  end if;
  if p_chaos = 'red-alert' and p_type = 'red' then
    return base + 25;
  end if;
  return base;
end;
$$;

create or replace function duo_reset_objective_progress_on_change()
returns trigger
language plpgsql
as $$
begin
  if new.objective is distinct from old.objective then
    new.objective_progress := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists duo_reset_objective_progress_on_change on duo_players;
create trigger duo_reset_objective_progress_on_change
  before update of objective on duo_players
  for each row
  when (new.objective is distinct from old.objective)
  execute function duo_reset_objective_progress_on_change();

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
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  v_me := duo_require_player(v_code, p_token);

  update duo_players set last_seen_at = now()
    where room_code = v_code and slot = v_me.slot;

  perform duo_respawn_coins(v_code);
  select count(*) into v_count from duo_players where room_code = v_code;

  select jsonb_agg(
    jsonb_build_object(
      'id', p.player_id,
      'name', p.name,
      'x', p.x,
      'y', p.y,
      'coins', p.coins,
      'stolen', p.stolen,
      'roundCoins', p.round_coins,
      'roundStolen', p.round_stolen,
      'collectedTypes', p.collected_types,
      'objectiveProgress', coalesce(p.objective_progress, 0),
      'score', p.score,
      'roundScore', p.round_score,
      'totalScore', p.total_score,
      'objectivesDone', p.objectives_done,
      'objective', p.objective,
      'missionDone', p.mission_done,
      'rematch', p.rematch,
      'emote', p.emote,
      'trail', p.trail,
      'slowedUntil', p.slowed_until,
      'scoutCharges', case when p.player_id = v_me.player_id then p.scout_charges else null end,
      'scoutUsedAt', case when p.player_id = v_me.player_id then p.scout_used_at else null end,
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
          when 'blackout' then 'Blackout'
          when 'magnet' then 'Magnet Storm'
          when 'swap' then 'Chaos Swap'
          when 'jackpot' then 'Jackpot'
          when 'double-score' then 'Double Points'
          when 'red-alert' then 'Red Alert'
        end,
        'description', case v_room.chaos_event
          when 'gold-rush' then 'Gold coins grant +25 points for 15s.'
          when 'blackout' then 'Arena visibility drops for 15s. Follow the glow and keep moving.'
          when 'magnet' then 'Coins drift toward the center and pressure rises.'
          when 'swap' then 'One of your targets is swapped mid-round.'
          when 'jackpot' then 'A single Diamond appears. First player gets +50.'
          when 'double-score' then 'All standard coins are worth double for 15s.'
          when 'red-alert' then 'Red coins grant +25 bonus points for 15s.'
        end,
        'boost', case v_room.chaos_event
          when 'gold-rush' then 'Gold bonus +25'
          when 'blackout' then 'Visibility reduced'
          when 'magnet' then 'Resource control'
          when 'swap' then 'Plans break'
          when 'jackpot' then 'Diamond +50'
          when 'double-score' then '2x coin points'
          when 'red-alert' then 'Red bonus +25'
        end
      ) end,
    'chaosEventEndsAt', v_room.chaos_ends_at,
    'winner', v_room.winner,
    'roundScores', v_room.round_scores,
    'matchScores', v_room.match_scores,
    'coins', coalesce(v_coins, '[]'::jsonb),
    'players', coalesce(v_players, '[]'::jsonb)
  );
end;
$$;

grant execute on function duo_public_state(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
