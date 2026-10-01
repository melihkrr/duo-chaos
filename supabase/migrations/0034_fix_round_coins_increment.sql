-- ============================================================================
-- 0034_fix_round_coins_increment.sql
--
-- SORUN (kullanıcı şikâyeti — "coins collected hiç artmıyor"):
--   Sonuç ekranında 🪙 (coins collected) HER İKİ oyuncu için de 0 gösteriyordu;
--   🦹 (stolen) ise doğru artıyordu (3 / 8).
--
-- KÖK NEDEN:
--   0027_round_stats_authority.sql, `duo_collect` içine tur toplamı artırımını
--   eklemişti:
--       round_coins = coalesce(round_coins, 0) + 1
--   Ancak 0031_objective_progress_persistent.sql `duo_collect`'i YENİDEN
--   yazdığında bu satır KAYBOLDU (yalnızca `coins = coins + 1` kaldı). 0032 ve
--   0033 de aynı gövdeyi kopyaladığı için regresyon zincirlendi. Sonuç:
--   `round_coins` hiç artmıyor, sonuç ekranı 0 gösteriyordu. `round_stolen`
--   ise `duo_steal` içinde hâlâ artırıldığı için doğru görünüyordu.
--
-- ÇÖZÜM:
--   `duo_collect` yeniden tanımlanır ve `round_coins = coalesce(round_coins, 0)
--   + 1` satırı GERİ EKLENİR. Gövde 0033 ile aynıdır; yalnızca bu satır
--   eklenmiştir (anında reroll davranışı KORUNUR).
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0033'ten SONRA çalışır.
-- ============================================================================

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
        -- TUR TOPLAMI (0034 — GERİ EKLENDİ): görev sıfırlamasından bağımsız,
        -- tur boyunca birikir. 0031'de yanlışlıkla düşürülmüştü; sonuç ekranı
        -- 🪙 0 gösteriyordu.
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

  return jsonb_build_object('ok', true, 'value', v_value, 'type', v_coin.type, 'objectiveDone', v_satisfied);
end;
$$;

grant execute on function duo_collect(text, text, int) to anon, authenticated;
