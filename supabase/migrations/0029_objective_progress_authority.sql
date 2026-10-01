-- ============================================================================
-- 0029_objective_progress_authority.sql
--
-- SORUN (kullanıcı şikâyeti — "görev ilerleme akışı çelişkili"):
--   Görev ilerleme sayacı tutarsızdı: "denileni yapıyorum yine de artmıyor,
--   bazen artıyor, bazen artıp geri düşüyor". İki istemci aynı oyuncu için
--   farklı ilerleme gösterebiliyordu.
--
-- KÖK NEDEN:
--   İlerleme, istemcide `collectedTypes`/`coins`/`stolen` sayaçlarından
--   YENİDEN İNŞA ediliyordu (bkz. lib/display.ts `progressOf`). Ancak bu
--   sayaçlar `duo_reroll_objective` tarafından görev tamamlanınca SIFIRLANIR.
--   İstemci iyimser (optimistic) artırım yapıp, ardından gelen sunucu
--   snapshot'ı (görev tamamlanmış + sayaçlar sıfırlanmış) değeri EZİYORDU:
--       "artıyor → sonra geri düşüyor".
--   Ayrıca görev değişimini yakalayan `objectiveIdRef`/`objectiveChanged`
--   mantığı zamanlamaya duyarlıydı; geçiş kaçırılınca sayaç zıplıyordu.
--
-- ÇÖZÜM (SUNUCU OTORİTESİ — görev ilerlemesi):
--   1. `duo_mission_progress(objective, collected, stolen, coins)` yardımcısı
--      eklenir. `duo_mission_satisfied` ile AYNI ilerleme mantığını izler ve
--      HAM ilerleme sayısını döndürür (0..target).
--   2. `duo_public_state` her oyuncu için `objectiveProgress` (sunucu-hesaplı
--      ham ilerleme) döndürür. Böylece istemci ilerlemeyi sayaçlardan YENİDEN
--      İNŞA ETMEK ZORUNDA KALMAZ; doğrudan sunucu değerini gösterir.
--   3. İstemci, sunucu `objectiveProgress` değerini görev `id`'siyle birlikte
--      uygular. Görev değişmediği sürece ilerleme MONOTONİK artar (asla geri
--      düşmez); görev değiştiğinde yeni görevin ilerlemesi (0'dan) uygulanır.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0028'den SONRA çalışır, bu
-- yüzden nihai `duo_public_state` tanımı buradadır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_mission_progress — görev ilerlemesinin HAM sayısı.
--    `duo_mission_satisfied` (0002) ile BİREBİR aynı mantık:
--      - `requirements` varsa: progress = Σ min(collected[key], required)
--      - `coinType` (mixed değil) varsa: progress = collected[coinType]
--      - aksi halde: progress = stolen (steal) veya coins
--    ÖNEMLİ: `requirements` + `steal` görevlerinde çalma progress'e EKLENMEZ;
--    çalma ayrı bir `steals_met` koşuludur (bkz. 0002 satır 269-271).
-- ---------------------------------------------------------------------------
create or replace function duo_mission_progress(
  p_objective jsonb,
  p_collected jsonb,
  p_stolen int,
  p_coins int
)
returns int
language plpgsql
immutable
as $$
declare
  reqs jsonb;
  req_key text;
  req_val int;
  progress int := 0;
begin
  if p_objective is null then return 0; end if;
  reqs := p_objective->'requirements';

  if reqs is not null and jsonb_typeof(reqs) = 'object' then
    for req_key, req_val in
      select key, (value)::text::int from jsonb_each(reqs)
    loop
      progress := progress + least(coalesce((p_collected->>req_key)::int, 0), req_val);
    end loop;
  elsif (p_objective->>'coinType') is not null and (p_objective->>'coinType') <> 'mixed' then
    progress := coalesce((p_collected->>(p_objective->>'coinType'))::int, 0);
  else
    progress := case when (p_objective->>'kind') = 'steal' then p_stolen else p_coins end;
  end if;

  return coalesce(progress, 0);
end;
$$;

grant execute on function duo_mission_progress(jsonb, jsonb, int, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_public_state — her oyuncu için `objectiveProgress` döndür.
--    Gövde 0027 ile aynıdır; yalnızca `objectiveProgress` alanı eklenmiştir.
--    Bu alan SUNUCU-hesaplıdır ve istemci tarafından AYNEN gösterilir.
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
  -- `objectiveProgress`: SUNUCU-hesaplı ham ilerleme (0..target). İstemci bunu
  -- doğrudan gösterir; sayaçlardan yeniden inşa etmez.
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
      'objectiveProgress', duo_mission_progress(p.objective, p.collected_types, p.stolen, p.coins),
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
