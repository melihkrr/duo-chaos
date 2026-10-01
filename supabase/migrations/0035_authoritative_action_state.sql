-- ============================================================================
-- 0035_authoritative_action_state.sql
--
-- SORUN (kullanıcı şikâyetleri — görev sistemi hâlâ temelden bozuk):
--   1. "3 tane topla diyor, 3 tane topluyorum, 2 gösteriyor."
--   2. "Bazen 3 tane topladım olarak gösteriyor, birden 1 tane toplamışım
--      gibi gösteriyor."
--   3. "Görev bittikten sonra uzun süre bekletiyor, yeni görevi sonra veriyor."
--   4. İlerleme ASLA geri düşmemeli; yeni görev ANINDA gelmeli.
--
-- KÖK NEDEN (TAM AKIŞ İZİ):
--   Görev ilerlemesi için İKİ BAĞIMSIZ "doğruluk kaynağı" yarışıyordu:
--
--   (A) SUNUCU: `duo_players.objective_progress` (kalıcı, `greatest()` ile
--       monotonik). `duo_public_state` bunu ~1 sn'de bir döndürür.
--
--   (B) İSTEMCİ: `lib/useGameLoop.ts` HER KAREDE ilerlemeyi
--       `me.collectedTypes` (yalnızca 1 sn'lik yoklamayla güncellenir) + bu
--       karenin coinlerinden YENİDEN İNŞA ediyor ve
--       `state.players[0].objectiveProgress`'e yazıyordu. Ardından
--       `mergeProgress` (`lib/useDuoChaos.ts`) `Math.max(yerel, sunucu)`
--       uyguluyordu.
--
--   İstemcinin yeniden inşası BAYAT tabandan (`collectedTypes`) beslendiği için
--   YANLIŞ (fazla yüksek) değer üretebiliyordu. `Math.max` bu yanlış değeri
--   KALICI olarak kilitliyordu (asla düşmediği için) → "3 gösterip sonra 1'e
--   düşme" ve "3 topladım 2 gösteriyor" hataları.
--
--   Ayrıca görev tamamlanınca yeni görev SUNUCUDA anında atanıyordu (0033),
--   ancak istemci bunu YALNIZCA 1 sn'lik yoklamada öğreniyordu → "uzun süre
--   bekletiyor" (Hata 3).
--
-- ÇÖZÜM (TEK OTORİTE KAYNAĞI — SUNUCU):
--   1. `duo_collect` / `duo_steal` artık eylemin SONUCUNDAKİ TAM OTORİTE
--      DURUMU döndürür: `objective`, `objectiveProgress`, `collectedTypes`,
--      `coins`, `stolen`, `roundCoins`, `roundStolen`, `missionDone`,
--      `objectivesDone`, `score`, `roundScore`. Böylece istemci, yoklamayı
--      BEKLEMEDEN sunucunun onayladığı değeri ANINDA uygular. Görev
--      tamamlanması + yeni görev ataması ATOMİK ve ANINDA olur (Hata 3).
--   2. İstemci artık ilerlemeyi KAREDE YENİDEN İNŞA ETMEZ; yalnızca sunucu
--      yanıtını uygular. Böylece istemci sunucuyu ASLA geçemez ve `Math.max`
--      kilitlenmesi ortadan kalkar (Hata 1 & 2).
--   3. `duo_public_state` yoklaması yalnızca YEDEK/yakınsama kaynağıdır;
--      ilerleme için `max` yerine sunucu değeri AYNEN uygulanır (görev
--      değişmediği sürece sunucu zaten monotoniktir).
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0034'ten SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_collect — eylem sonrası TAM otorite durumu döndür.
--    Gövde 0034 ile aynıdır; yalnızca dönüş değeri genişletilmiştir.
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
  v_respawn_at bigint;
  v_progress int;
  v_after duo_players;
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

  -- ELMAS İSTİSNASI (0025): elmas TEK SEFERLİKTİR. `respawn_at = 0`.
  v_respawn_at := case when v_coin.type = 'diamond' then 0 else v_now + 3000 end;

  update duo_coins
    set collected_by = v_pl.player_id,
        collected_at = v_now,
        respawn_at = v_respawn_at
    where room_code = v_code and coin_id = p_coin_id;

  v_collected := coalesce(v_pl.collected_types, '{}'::jsonb);
  v_collected := jsonb_set(
    v_collected,
    array[v_coin.type::text],
    to_jsonb(coalesce((v_collected->>v_coin.type::text)::int, 0) + 1),
    true
  );

  -- KALICI İLERLEME (0031): yeni sayaçlarla hesapla ve MONOTONİK yaz.
  v_progress := duo_mission_progress(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1);

  update duo_players
    set coins = coins + 1,
        -- TUR TOPLAMI (0034): görev sıfırlamasından bağımsız, tur boyunca birikir.
        round_coins = coalesce(round_coins, 0) + 1,
        collected_types = v_collected,
        objective_progress = greatest(coalesce(objective_progress, 0), v_progress),
        -- PUAN TABANLI SKOR: coin puanını EKLE.
        score = coalesce(score, 0) + v_value,
        round_score = coalesce(round_score, 0) + v_value,
        mission_done = duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    where room_code = v_code and slot = v_pl.slot;

  -- ANINDA REROLL (0033): görev tamamlandıysa DERHAL yeni görev ata.
  select duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    into v_satisfied;
  if v_satisfied then
    perform duo_reroll_objective(v_code, v_pl.slot);
  end if;

  -- OTORİTE DURUM (0035): reroll SONRASI güncel satırı oku ve döndür.
  -- Böylece istemci yeni görevi + sıfırlanmış sayaçları ANINDA alır.
  select * into v_after from duo_players where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object(
    'ok', true,
    'value', v_value,
    'type', v_coin.type,
    'objectiveDone', v_satisfied,
    'state', jsonb_build_object(
      'objective', v_after.objective,
      'objectiveProgress', coalesce(v_after.objective_progress, 0),
      'collectedTypes', coalesce(v_after.collected_types, '{}'::jsonb),
      'coins', v_after.coins,
      'stolen', v_after.stolen,
      'roundCoins', coalesce(v_after.round_coins, 0),
      'roundStolen', coalesce(v_after.round_stolen, 0),
      'missionDone', v_after.mission_done,
      'objectivesDone', coalesce(v_after.objectives_done, 0),
      'score', coalesce(v_after.score, 0),
      'roundScore', coalesce(v_after.round_score, 0)
    )
  );
end;
$$;

grant execute on function duo_collect(text, text, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_steal — eylem sonrası TAM otorite durumu döndür.
--    Gövde 0033 ile aynıdır; yalnızca dönüş değeri genişletilmiştir.
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
  v_steal_score int := 20;
  v_new_stolen int;
  v_satisfied boolean;
  v_progress int;
  v_after duo_players;
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

  -- KALICI İLERLEME (0031): yeni stolen ile hesapla ve MONOTONİK yaz.
  v_progress := duo_mission_progress(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins);

  update duo_players
    set stolen = v_new_stolen,
        -- TUR TOPLAMI: çalınan coin tur boyunca birikir.
        round_stolen = coalesce(round_stolen, 0) + 1,
        objective_progress = greatest(coalesce(objective_progress, 0), v_progress),
        -- PUAN TABANLI SKOR: çalma puanını EKLE.
        score = coalesce(score, 0) + v_steal_score,
        round_score = coalesce(round_score, 0) + v_steal_score,
        mission_done = duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    where room_code = v_code and slot = v_pl.slot;

  -- The victim loses a coin AND the stolen points (never below zero) + is slowed.
  update duo_players
    set coins = greatest(0, coins - 1),
        round_coins = greatest(0, coalesce(round_coins, 0) - 1),
        score = greatest(0, coalesce(score, 0) - v_steal_score),
        round_score = greatest(0, coalesce(round_score, 0) - v_steal_score),
        slowed_until = (extract(epoch from now()) * 1000)::bigint + 400
    where room_code = v_code and slot = v_opp.slot;

  -- ANINDA REROLL (0033): görev tamamlandıysa DERHAL yeni görev ata.
  select duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    into v_satisfied;
  if v_satisfied then
    perform duo_reroll_objective(v_code, v_pl.slot);
  end if;

  -- OTORİTE DURUM (0035): reroll SONRASI güncel satırı oku ve döndür.
  select * into v_after from duo_players where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object(
    'ok', true,
    'stolen', v_new_stolen,
    'score', v_steal_score,
    'objectiveDone', v_satisfied,
    'state', jsonb_build_object(
      'objective', v_after.objective,
      'objectiveProgress', coalesce(v_after.objective_progress, 0),
      'collectedTypes', coalesce(v_after.collected_types, '{}'::jsonb),
      'coins', v_after.coins,
      'stolen', v_after.stolen,
      'roundCoins', coalesce(v_after.round_coins, 0),
      'roundStolen', coalesce(v_after.round_stolen, 0),
      'missionDone', v_after.mission_done,
      'objectivesDone', coalesce(v_after.objectives_done, 0),
      'score', coalesce(v_after.score, 0),
      'roundScore', coalesce(v_after.round_score, 0)
    )
  );
end;
$$;

grant execute on function duo_steal(text, text) to anon, authenticated;
