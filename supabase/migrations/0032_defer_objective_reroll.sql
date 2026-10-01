-- ============================================================================
-- 0032_defer_objective_reroll.sql
--
-- SORUN (kullanıcı şikâyeti — "3/3 gördüm, sonra 2/3'e düştü"):
--   Görev TAMAMLANDIĞI ANDA `duo_reroll_objective` AYNI transaction içinde
--   çağrılıyordu (bkz. 0031 `duo_collect` satır 268-270, `duo_steal` satır
--   347-349). Bu fonksiyon:
--       * `objective_progress = 0` yapar,
--       * `coins = 0, stolen = 0, collected_types = '{}'` sıfırlar,
--       * YENİ bir görev atar.
--   Sonuç: oyuncu 3. çalmayı yaptığı anda sunucu ilerlemeyi 0'a çekip yeni
--   görev atıyordu. İstemci iyimser olarak 3/3 gösterip kutlama yapıyor, bir
--   sonraki `duo_public_state` yoklaması (yeni görev + sıfır ilerleme) gelince
--   bar GERİ DÜŞÜYORDU. Kullanıcının gördüğü "3/3 → 2/3" tam olarak budur:
--   yeni görevde bir sonraki eylem ilerlemeyi 1 yapar ama eski görevin
--   tamamlanmış hâli artık kaybolmuştur.
--
-- ÇÖZÜM (ERTELENMİŞ REROLL — "defer"):
--   Görev tamamlandığında ARTIK ANINDA reroll YAPILMAZ. Bunun yerine:
--     1. `mission_done = true` ve `objective_progress = target` olarak KALIR;
--        oyuncu tamamlanmış görevi (3/3) görmeye devam eder.
--     2. Reroll, oyuncunun BİR SONRAKİ collect/steal eyleminde, o eylem
--        UYGULANMADAN ÖNCE "tembel" (lazy) olarak yapılır. Yani:
--          - Eğer mevcut görev zaten tamamlanmışsa (`mission_done = true`),
--            önce `duo_reroll_objective` çağrılır (sayaçlar sıfırlanır, yeni
--            görev atanır), SONRA yeni eylem yeni göreve uygulanır.
--          - Böylece tamamlanmış görevin ilerlemesi asla "geri düşmez";
--            yeni görev ancak oyuncu yeni bir eylem yaptığında başlar.
--     3. `duo_reroll_objective` içindeki `objective_progress = 0` KORUNUR
--        (yeni görev sıfırdan başlar) — ama artık tamamlanma anında değil,
--        bir sonraki eylemde tetiklenir.
--
--   Bu, "görev tamamlandı → kutlama → oyuncu devam eder → yeni görev başlar"
--   akışını sağlar ve ilerleme barının geri düşmesini TAMAMEN ortadan kaldırır.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0031'den SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_collect — reroll'u ERTELE.
--    Gövde 0031 ile aynıdır; yalnızca reroll ZAMANLAMASI değişti:
--      * Eylemden ÖNCE: mevcut görev tamamlanmışsa reroll et (yeni görev).
--      * Eylemden SONRA: reroll ETME (görev tamamlanmış olarak kalır).
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

  -- ERTELENMİŞ REROLL (0032): Önceki görev tamamlanmışsa, YENİ eylemi
  -- uygulamadan ÖNCE yeni görevi ata. Böylece tamamlanmış görevin ilerlemesi
  -- (3/3) oyuncu yeni bir eylem yapana kadar EKRANDA KALIR ve geri düşmez.
  if v_pl.mission_done then
    perform duo_reroll_objective(v_code, v_pl.slot);
    -- Sayaçlar sıfırlandı; güncel satırı yeniden oku.
    select * into v_pl from duo_players
      where room_code = v_code and slot = v_pl.slot;
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

  -- ERTELENMİŞ REROLL (0032): Burada ARTIK reroll YAPILMAZ. Görev tamamlanmış
  -- olsa bile `mission_done = true` ve `objective_progress = target` olarak
  -- kalır; reroll bir sonraki eylemde (yukarıdaki blok) yapılır.
  select duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    into v_satisfied;

  return jsonb_build_object('ok', true, 'value', v_value, 'type', v_coin.type, 'objectiveDone', v_satisfied);
end;
$$;

grant execute on function duo_collect(text, text, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_steal — reroll'u ERTELE.
--    Gövde 0031 ile aynıdır; yalnızca reroll ZAMANLAMASI değişti.
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

  -- ERTELENMİŞ REROLL (0032): Önceki görev tamamlanmışsa, YENİ çalmayı
  -- uygulamadan ÖNCE yeni görevi ata. Böylece tamamlanmış görevin ilerlemesi
  -- (3/3) oyuncu yeni bir çalma yapana kadar EKRANDA KALIR ve geri düşmez.
  if v_pl.mission_done then
    perform duo_reroll_objective(v_code, v_pl.slot);
    select * into v_pl from duo_players
      where room_code = v_code and slot = v_pl.slot;
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

  -- ERTELENMİŞ REROLL (0032): Burada ARTIK reroll YAPILMAZ. Görev tamamlanmış
  -- olsa bile `mission_done = true` ve `objective_progress = target` olarak
  -- kalır; reroll bir sonraki çalmada (yukarıdaki blok) yapılır.
  select duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    into v_satisfied;

  return jsonb_build_object('ok', true, 'stolen', v_new_stolen, 'score', v_steal_score, 'objectiveDone', v_satisfied);
end;
$$;

grant execute on function duo_steal(text, text) to anon, authenticated;
