-- ============================================================================
-- 0033_immediate_reroll_and_progress_fix.sql
--
-- SORUN (kullanıcı şikâyetleri — üç ciddi hata):
--   1. "3 tane topla diyor, 3 tane topluyorum, 2 gösteriyor."
--   2. "Bazen 3 tane topladım olarak gösteriyor, birden 1 tane toplamışım
--      gibi gösteriyor."
--   3. "Görev bittikten sonra uzun süre bekletiyor, yeni görevi sonra veriyor."
--
-- KÖK NEDENLER:
--   * Hata 3 — ERTELENMİŞ REROLL (0032): Görev tamamlandığında reroll ANINDA
--     yapılmıyor; oyuncunun BİR SONRAKİ collect/steal eylemine erteleniyordu.
--     Oyuncu coinlerden uzaktaysa ya da eylem yapmıyorsa, tamamlanmış görev
--     (3/3) ekranda KALIYOR ve yeni görev uzun süre gelmiyordu. Bu, kullanıcının
--     "uzun süre bekletiyor" şikâyetinin tam nedenidir.
--
--   * Hata 1 & 2 — İSTEMCİ ÇİFT SAYMA / TABAN KAYMASI: İstemci
--     (`lib/useGameLoop.ts`) `countedCoinIdsRef` adlı KALICI bir Set ile coin
--     id'lerini "bir kez sayıldı" diye işaretliyordu. Ancak coinler 3 sn sonra
--     AYNI id ile yeniden doğar. Oyuncu aynı coini ikinci kez topladığında
--     istemci onu ATLIYOR (id zaten Set'te), sunucu ise `collected_types`'ı
--     YENİDEN artırıyordu. Sonuç: istemci 2, sunucu 3 gösteriyordu ("3 topladım
--     2 gösteriyor"). Ayrıca `objectiveCompleted` bayrağı, görev tamamlandıktan
--     SONRAKİ ilk eylemde tabanı 0'a çekiyordu; sunucunun ANINDA reroll yapıp
--     yeni görev atadığı anda bu taban sıfırlama ile sunucu snapshot'ı
--     yarışıyor ve bar "3 → 1" gibi zıplıyordu.
--
-- ÇÖZÜM:
--   1. ERTELENMİŞ REROLL GERİ ALINIR (0032 → 0031 davranışı): Görev
--      tamamlandığı ANDA `duo_reroll_objective` çağrılır. Böylece yeni görev
--      ANINDA atanır; oyuncu beklemez (Hata 3 çözülür).
--   2. İstemci tarafında `countedCoinIdsRef` KALDIRILIR ve iyimser ilerleme
--      doğrudan sunucu sayaçlarından (`collected_types` + bu karenin coinleri)
--      türetilir. Böylece respawn sonrası yeniden toplanan coin de SAYILIR ve
--      istemci/sunucu birebir uyuşur (Hata 1 çözülür).
--   3. İstemci `objectiveCompleted` taban sıfırlaması KALDIRILIR; görev
--      değişimi YALNIZCA `objective.id` değişimiyle algılanır. Sunucu anında
--      reroll yaptığı için yeni görev id'si bir sonraki yoklamada gelir ve
--      temiz bir sıfırlama olur (Hata 2 çözülür).
--
-- Bu migration yalnızca sunucu tarafını (reroll zamanlaması) geri alır.
-- İstemci düzeltmeleri `lib/useGameLoop.ts` içindedir.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0032'den SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_collect — reroll'u ANINDA yap (0031 davranışına dön).
--    Gövde 0031 ile aynıdır; 0032'nin "eylemden önce reroll" bloğu KALDIRILIR
--    ve tamamlanma anında reroll YENİDEN eklenir.
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
        collected_types = v_collected,
        objective_progress = greatest(coalesce(objective_progress, 0), v_progress),
        -- PUAN TABANLI SKOR: coin puanını EKLE.
        score = coalesce(score, 0) + v_value,
        round_score = coalesce(round_score, 0) + v_value,
        mission_done = duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    where room_code = v_code and slot = v_pl.slot;

  -- ANINDA REROLL (0033): görev tamamlandıysa DERHAL yeni görev ata. Böylece
  -- oyuncu beklemez; yeni görev bir sonraki yoklamada gelir.
  select duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    into v_satisfied;
  if v_satisfied then
    perform duo_reroll_objective(v_code, v_pl.slot);
  end if;

  return jsonb_build_object('ok', true, 'value', v_value, 'type', v_coin.type, 'objectiveDone', v_satisfied);
end;
$$;

grant execute on function duo_collect(text, text, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_steal — reroll'u ANINDA yap (0031 davranışına dön).
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

  return jsonb_build_object('ok', true, 'stolen', v_new_stolen, 'score', v_steal_score, 'objectiveDone', v_satisfied);
end;
$$;

grant execute on function duo_steal(text, text) to anon, authenticated;
