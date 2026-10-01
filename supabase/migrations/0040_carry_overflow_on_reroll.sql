-- ============================================================================
-- 0040_carry_overflow_on_reroll.sql
--
-- SORUN (kullanıcı şikâyeti — GENELLEŞTİRİLMİŞ, Blue'a özel DEĞİL):
--   "Gerekenden FAZLA geçerli coin toplarsam, görev ilerlemesi asla gerçekte
--    işlenen geçerli toplama sayısından DÜŞÜK olmamalı."
--   Örnek: "Collect 4 Blue" → 4 mavi topluyorum ama ilerleme 3'te kalıyor
--   (veya 0'a düşüyor). Aynı hata HER coin türü ve HER görev için olur.
--
-- KÖK NEDEN (TAM AKIŞ İZİ — ampirik olarak yeniden üretildi):
--   `duo_collect` (0039) görev TAMAMLANDIĞINDA şu sırayı izliyordu:
--     1. `v_progress := duo_mission_progress(...)` → 4 (tamamlandı).
--     2. `update duo_players set objective_progress = greatest(..., 4)`.
--     3. `if satisfied then perform duo_reroll_objective(...)`.
--     4. `select * into v_after ...` → OTORİTE DURUM.
--     5. `return ... 'objectiveProgress', v_after.objective_progress`.
--
--   `duo_reroll_objective` (0031) `objective_progress = 0` YAPAR ve
--   `collected_types = '{}'` SIFIRLAR. Dolayısıyla 4. adımda okunan değer
--   ARTIK 0'dır. İstemciye dönen `objectiveProgress` = 0 olur; TAMAMLAMA
--   (4/4) HİÇBİR ZAMAN gözlemlenemez. İstemci monotonik birleştirme yaptığı
--   için bu, "4 topladım ama 3/0 gösteriyor" kaybına yol açar.
--
--   Ayrıca AYNI partide toplanan FAZLA coinler (ör. 6 mavi / hedef 4) reroll
--   sırasında `collected_types` SIFIRLANDIĞI için YENİ göreve TAŞINMAZ →
--   geçerli toplamalar kaybolur.
--
-- ÇÖZÜM (SUNUCU ATOMİKLİĞİ — TAŞIMA + TAMAMLAMA RAPORU):
--   1. YENİ `duo_reroll_objective_carry(p_room, p_slot, p_collected, p_stolen,
--      p_coins)`: yeni görev atar ama `collected_types`/`stolen`/`coins`
--      sayaçlarını SIFIRLAMAZ; yeni görevin ilk ilerlemesini BU sayaçlardan
--      `duo_mission_progress` ile hesaplar. Böylece fazla toplamalar YENİ
--      göreve TAŞINIR (kaybolmaz).
--   2. `duo_collect` / `duo_steal`: görev tamamlandığında
--        * tamamlanan görevin SON ilerlemesini (`v_completed_progress`) sakla,
--        * taşımalı reroll'u çağır,
--        * yanıtta HEM `objectiveDone: true` HEM `completedProgress`
--          (tamamlanan görevin 4/4 değeri) HEM de yeni görevin taşınmış
--          `objectiveProgress` değerini döndür.
--      İstemci `completedProgress`'i anlık gösterir; `objectiveProgress` yeni
--      görevin TAŞINMIŞ değeridir → hiçbir geçerli toplama kaybolmaz.
--   3. `duo_public_state`: aynı taşıma mantığını kullanır (kolon zaten
--      taşınmış değeri tutar); ek değişiklik gerekmez.
--
--   NOT: `duo_reroll_objective` (void) KORUNUR (başka çağıranlar var);
--   yalnızca `duo_collect`/`duo_steal` taşımalı sürümü kullanır.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0039'dan SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_reroll_objective_carry — yeni görev atar, sayaçları TAŞIR.
--    Dönen jsonb: { objective, objectiveProgress, objectivesDone, score,
--                   roundScore, collectedTypes, stolen, coins }
-- ---------------------------------------------------------------------------
create or replace function duo_reroll_objective_carry(
  p_room text,
  p_slot int,
  p_collected jsonb,
  p_stolen int,
  p_coins int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pl duo_players;
  v_done int;
  v_bonus int;
  v_next jsonb;
  v_carried jsonb;
  v_progress int;
  v_after duo_players;
begin
  select * into v_pl from duo_players where room_code = p_room and slot = p_slot for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_player');
  end if;

  v_done := coalesce(v_pl.objectives_done, 0) + 1;
  v_bonus := coalesce((v_pl.objective->>'points')::int, 50);
  v_next := duo_random_objective(v_pl.objective->>'id');

  -- TAŞIMA (0040): toplanan/çalınan sayaçları KORU. Yeni görevin ilk
  -- ilerlemesini bu sayaçlardan hesapla; böylece aynı partideki FAZLA
  -- toplamalar yeni göreve TAŞINIR (kaybolmaz).
  v_carried := coalesce(p_collected, '{}'::jsonb);
  v_progress := duo_mission_progress(v_next, v_carried, coalesce(p_stolen, 0), coalesce(p_coins, 0));

  update duo_players
    set objectives_done = v_done,
        score = coalesce(score, 0) + v_bonus,
        round_score = coalesce(round_score, 0) + v_bonus,
        objective = v_next,
        -- TAŞIMA: sayaçlar SIFIRLANMAZ; yeni göreve devredilir.
        coins = coalesce(p_coins, 0),
        stolen = coalesce(p_stolen, 0),
        collected_types = v_carried,
        objective_progress = v_progress,
        mission_done = duo_mission_satisfied(v_next, v_carried, coalesce(p_stolen, 0), coalesce(p_coins, 0))
    where room_code = p_room and slot = p_slot;

  select * into v_after from duo_players where room_code = p_room and slot = p_slot;

  return jsonb_build_object(
    'ok', true,
    'objective', v_after.objective,
    'objectiveProgress', coalesce(v_after.objective_progress, 0),
    'objectivesDone', coalesce(v_after.objectives_done, 0),
    'score', coalesce(v_after.score, 0),
    'roundScore', coalesce(v_after.round_score, 0),
    'collectedTypes', coalesce(v_after.collected_types, '{}'::jsonb),
    'coins', v_after.coins,
    'stolen', v_after.stolen,
    'missionDone', v_after.mission_done
  );
end;
$$;

revoke execute on function duo_reroll_objective_carry(text, int, jsonb, int, int) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_collect — taşımalı reroll + tamamlama raporu.
--    Gövde 0039 ile AYNIDIR; yalnızca reroll çağrısı ve yanıt zenginleştirildi.
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
  v_completed_progress int;
  v_after duo_players;
  v_reroll jsonb;
begin
  v_pl := duo_require_player(v_code, p_token);

  -- SERİLEŞTİRME (0039): oyuncu satırını KİLİTLE.
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

  v_value := duo_coin_value(
    v_coin.type,
    case when v_room.chaos_ends_at > v_now then v_room.chaos_event else null end,
    v_pl.objective
  );

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
        round_coins = coalesce(round_coins, 0) + 1,
        collected_types = v_collected,
        objective_progress = greatest(coalesce(objective_progress, 0), v_progress),
        score = coalesce(score, 0) + v_value,
        round_score = coalesce(round_score, 0) + v_value,
        mission_done = duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    where room_code = v_code and slot = v_pl.slot;

  select duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    into v_satisfied;

  -- TAMAMLAMA RAPORU (0040): tamamlanan görevin SON ilerlemesini sakla.
  -- Reroll bu değeri sıfırlayacağı için yanıtta AYRICA döndürürüz; istemci
  -- 4/4'ü anlık gösterir, sonra yeni görevin TAŞINMIŞ ilerlemesine geçer.
  v_completed_progress := v_progress;

  if v_satisfied then
    -- TAŞIMALI REROLL (0040): sayaçları SIFIRLAMAZ; fazla toplamalar yeni
    -- göreve taşınır. Yeni görevin ilerlemesi bu sayaçlardan hesaplanır.
    v_reroll := duo_reroll_objective_carry(
      v_code, v_pl.slot, v_collected, v_pl.stolen, v_pl.coins + 1
    );
  end if;

  select * into v_after from duo_players where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object(
    'ok', true,
    'value', v_value,
    'type', v_coin.type,
    'objectiveDone', v_satisfied,
    -- TAMAMLANAN görevin son ilerlemesi (ör. 4). Görev tamamlanmadıysa NULL.
    'completedProgress', case when v_satisfied then v_completed_progress else null end,
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
-- 3. duo_steal — taşımalı reroll + tamamlama raporu.
--    Gövde 0039 ile AYNIDIR; yalnızca reroll çağrısı ve yanıt zenginleştirildi.
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
  v_completed_progress int;
  v_after duo_players;
  v_reroll jsonb;
begin
  v_pl := duo_require_player(v_code, p_token);

  -- SERİLEŞTİRME (0039): oyuncu satırını KİLİTLE.
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

  v_progress := duo_mission_progress(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins);

  update duo_players
    set stolen = v_new_stolen,
        round_stolen = coalesce(round_stolen, 0) + 1,
        objective_progress = greatest(coalesce(objective_progress, 0), v_progress),
        score = coalesce(score, 0) + v_steal_score,
        round_score = coalesce(round_score, 0) + v_steal_score,
        mission_done = duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    where room_code = v_code and slot = v_pl.slot;

  update duo_players
    set coins = greatest(0, coins - 1),
        round_coins = greatest(0, coalesce(round_coins, 0) - 1),
        score = greatest(0, coalesce(score, 0) - v_steal_score),
        round_score = greatest(0, coalesce(round_score, 0) - v_steal_score),
        slowed_until = (extract(epoch from now()) * 1000)::bigint + 400
    where room_code = v_code and slot = v_opp.slot;

  select duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    into v_satisfied;

  v_completed_progress := v_progress;

  if v_satisfied then
    -- TAŞIMALI REROLL (0040): toplanan coinler + çalınan sayısı yeni göreve taşınır.
    v_reroll := duo_reroll_objective_carry(
      v_code, v_pl.slot, v_pl.collected_types, v_new_stolen, v_pl.coins
    );
  end if;

  select * into v_after from duo_players where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object(
    'ok', true,
    'stolen', v_new_stolen,
    'score', v_steal_score,
    'objectiveDone', v_satisfied,
    'completedProgress', case when v_satisfied then v_completed_progress else null end,
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
