-- ---------------------------------------------------------------------------
-- 0026_reveal_all_objectives.sql
--
-- KULLANICI İSTEĞİ: "🔒 Hidden objective olmasın; iki kullanıcı da birbirinin
-- görevini görsün."
--
-- ÖNCEKİ DAVRANIŞ:
--   `duo_public_state` rakibin görevini `null` olarak GİZLİYORDU; yalnızca
--   `revealed_hint` doluysa (scout ile) açıyordu. İstemci `null` görünce
--   `defaultObjectiveForPlayer('p2')` ile SAHTE bir görev uyduruyordu; bu da
--   iki istemcide FARKLI görev görünmesine yol açıyordu ("görevler çelişkili").
--
-- YENİ DAVRANIŞ:
--   Her iki oyuncunun görevi de HER ZAMAN açıktır. Böylece iki istemci de
--   birbirinin gerçek görevini ve ilerlemesini görür; sahte/uydurma görev
--   tamamen ortadan kalkar.
--
-- NOT: `revealed_hint` / `scout_charges` alanları geriye dönük uyumluluk için
--   korunur (istemci bunları okumaya devam edebilir), ancak artık görev
--   görünürlüğünü ETKİLEMEZ.
--
-- Bu dosya 0017'den SONRA çalıştığı için nihai `duo_public_state` tanımıdır.
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
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  v_me := duo_require_player(v_code, p_token);

  update duo_players set last_seen_at = now()
    where room_code = v_code and slot = v_me.slot;

  -- LAZY RESPAWN: süresi dolan coinleri snapshot'tan önce canlandır.
  perform duo_respawn_coins(v_code);

  select count(*) into v_count from duo_players where room_code = v_code;

  -- Oyuncu listesi. GÖREVLER ARTIK HERKESE AÇIK: iki oyuncu da birbirinin
  -- görevini ve ilerlemesini görür (kullanıcı isteği).
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

grant execute on function duo_public_state(text, text) to anon, authenticated;
