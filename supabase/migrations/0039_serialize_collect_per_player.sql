-- ============================================================================
-- 0039_serialize_collect_per_player.sql
--
-- SORUN (kullanıcı şikâyeti):
--   Görev: "Collect 4 Blue". Oyuncu 4 mavi coini GÖRÜNÜR şekilde topluyor,
--   ancak görev "3/4"te kalıyor. Toplama başarılı (coin kaybolur, skor artar)
--   ama GEÇERLİ bir toplama görev ilerlemesine SAYILMIYOR.
--
-- KÖK NEDEN (TAM AKIŞ İZİ — eşzamanlılık yarışı):
--   `duo_collect` (0035) oyuncu satırını `duo_require_player` ile OKUR; bu
--   fonksiyon DÜZ bir `SELECT` yapar ve oyuncu satırını KİLİTLEMEZ
--   (`FOR UPDATE` YOK). Fonksiyon içindeki `for update` (satır ~84) YALNIZCA
--   COIN satırını kilitler — oyuncu satırını DEĞİL.
--
--   İki hızlı `duo_collect` çağrısı AYNI oyuncu için eşzamanlı çalıştığında:
--     1. İkisi de `duo_require_player` ile AYNI `collected_types`'ı okur
--        (ör. {blue:2}) — BAYAT okuma.
--     2. İkisi de FARKLI coin satırlarını kilitler; birbirini BLOKLAMAZ.
--     3. İkisi de `v_collected`'ı AYNI tabandan hesaplar → {blue:3}.
--     4. İkinci `UPDATE duo_players ... collected_types = v_collected`
--        BİRİNCİYİ EZER. → Bir toplama KAYBOLUR → ilerleme 3/4'te takılır.
--
--   Bu, "son gerekli coin"de özellikle görülür: iki coin neredeyse aynı anda
--   toplandığında (veya istemcinin sıralı `await` döngüsü bir yoklama/aksiyonla
--   çakıştığında) son toplama kaybolur ve görev tamamlanmaz.
--
-- ÇÖZÜM (SUNUCU ATOMİKLİĞİ):
--   `duo_collect` ve `duo_steal` başında OYUNCU satırını `FOR UPDATE` ile
--   kilitle. Böylece aynı oyuncu için eşzamanlı aksiyonlar SERİLEŞİR: her
--   aksiyon EN GÜNCEL sayaçları okur ve atomik olarak uygular. Hiçbir geçerli
--   toplama kaybolmaz. Kilit sırası tutarlıdır (önce oyuncu, sonra coin) →
--   deadlock riski yoktur.
--
--   NOT: `duo_require_player`'ı DEĞİŞTİRMEYİZ (başka çağıranlar var); kilidi
--   yalnızca aksiyon fonksiyonlarının içinde, okumadan hemen sonra alırız.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0038'den SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_collect — oyuncu satırını FOR UPDATE ile kilitle (serileştirme).
--    Gövde 0035 ile AYNIDIR; yalnızca kilit eklenmiştir.
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

  -- SERİLEŞTİRME (0039): oyuncu satırını KİLİTLE. Aynı oyuncu için eşzamanlı
  -- `duo_collect`/`duo_steal` çağrıları burada sıraya girer; her biri EN GÜNCEL
  -- `collected_types`/`stolen`/`coins` değerlerini okur. Kilit olmadan iki
  -- eşzamanlı toplama aynı tabandan hesaplayıp birbirini ezerdi (kayıp toplama).
  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot
    for update;

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
-- 2. duo_steal — oyuncu satırını FOR UPDATE ile kilitle (serileştirme).
--    Gövde 0035 ile AYNIDIR; yalnızca kilit eklenmiştir.
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

  -- SERİLEŞTİRME (0039): oyuncu satırını KİLİTLE (bkz. duo_collect).
  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot
    for update;

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
