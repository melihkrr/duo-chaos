-- ============================================================================
-- 0021_points_scoring.sql
--
-- SORUN (mantık hatası — kullanıcı şikâyeti):
--   "score anlamında karşılaştırma kıstasımız görev değil puan olmalı ... score
--    yapısını görev sayısı değil puan olarak değiştirmen lazım."
--
--   Mevcut skor, TAMAMLANAN GÖREV SAYISINA (`objectives_done`) eşitleniyordu:
--
--     * 0004_rpc_gameplay.sql → `duo_collect`  : score = score + v_value  (PUAN)
--     * 0004_rpc_gameplay.sql → `duo_steal`    : score = score + 20       (PUAN)
--     * 0012_objective_chain.sql → `duo_collect`/`duo_steal` YENİDEN tanımlandı
--       ve `score = score + ...` satırlarını DÜŞÜRDÜ (artık puan eklemiyor).
--     * 0012 + 0018 → `duo_reroll_objective` : score = objectives_done
--       (her görev tamamlandığında skoru EZİYOR).
--
--   Sonuç: görevler sık tamamlandığı için `score` sürekli `objectives_done`
--   değerine sıfırlanıyordu → coin toplama ve çalma puanları KAYBOLUYORDU.
--   Yani skor fiilen "görev sayısı" idi. Kullanıcının gördüğü tam olarak buydu.
--
-- ÇÖZÜM (PUAN TABANLI SKOR):
--   1. `duo_collect`  → toplanan coin'in PUANINI skora EKLER (duo_coin_value).
--   2. `duo_steal`    → 20 PUAN ekler (kurbandan 20 düşer, taban 0).
--   3. `duo_reroll_objective` → skoru EZMEZ; görevin `points` ödülünü skora
--      EKLER. Böylece görevler önemini korur (ödül birkaç coin'den yüksek)
--      ama tek başına skoru belirlemez; coin/çalma da katkı verir.
--
--   Skor artık şu üç kaynağın TOPLAMIDIR:
--       score = Σ(coin puanları) + Σ(çalma puanları) + Σ(görev ödülleri)
--
--   `objectives_done` yalnızca İSTATİSTİK olarak tutulur (skor DEĞİL).
--
-- PUAN DENGESİ (görevler önemini yitirmesin diye):
--   coin: sıradan 5 / hedef 15 / zümrüt 25 / elmas 50 / gold-rush +25
--   çalma: 20
--   görev ödülü: 45-70 (bkz. duo_objective_pool)
--   90 sn'lik turda oyuncu ~15-25 coin (~150-250 puan) toplar; görevler
--   skorun yaklaşık yarısını oluşturur → belirleyici ama tek başına yeterli
--   değil. Böylece hem görevler hem coin/çalma önemini korur.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0018/0020'den SONRA çalışır,
-- bu yüzden nihai tanımlar buradadır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_reroll_objective — görev ödülünü skora EKLE (EZME!).
--    `objectives_done` yalnızca sayaç olarak artar; skor ayrı birikimdir.
-- ---------------------------------------------------------------------------
create or replace function duo_reroll_objective(p_room text, p_slot int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pl duo_players;
  v_done int;
  v_bonus int;
  v_next jsonb;
begin
  select * into v_pl from duo_players where room_code = p_room and slot = p_slot for update;
  if not found then return; end if;

  v_done := coalesce(v_pl.objectives_done, 0) + 1;

  -- Görev ödülü: görevin `points` alanı. Eksikse güvenli bir varsayılan (50).
  v_bonus := coalesce((v_pl.objective->>'points')::int, 50);

  v_next := duo_random_objective(v_pl.objective->>'id');

  update duo_players
    set objectives_done = v_done,
        -- PUAN TABANLI SKOR: mevcut puanı KORU ve görev ödülünü EKLE.
        -- (Eski hatalı davranış: score = v_done → biriken puanı eziyordu.)
        score = coalesce(score, 0) + v_bonus,
        round_score = coalesce(round_score, 0) + v_bonus,
        objective = v_next,
        coins = 0,
        stolen = 0,
        collected_types = '{}'::jsonb,
        mission_done = false
    where room_code = p_room and slot = p_slot;
end;
$$;

-- Doğrudan istemci çağrısını KAPAT: yalnızca sunucu içi kullanım (0018 ile aynı).
revoke execute on function duo_reroll_objective(text, int) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_collect — coin PUANINI skora EKLE + görev zinciri.
--    0012 bu satırı düşürmüştü; puan tabanlı skor için geri getiriyoruz.
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

  -- Mark collected AND schedule a respawn (same spot, same colour — 0013/0020).
  update duo_coins
    set collected_by = v_pl.player_id,
        collected_at = v_now,
        respawn_at = v_now + 4000
    where room_code = v_code and coin_id = p_coin_id;

  v_collected := coalesce(v_pl.collected_types, '{}'::jsonb);
  v_collected := jsonb_set(
    v_collected,
    array[v_coin.type::text],
    to_jsonb(coalesce((v_collected->>v_coin.type::text)::int, 0) + 1),
    true
  );

  update duo_players
    set coins = coins + 1,
        collected_types = v_collected,
        -- PUAN TABANLI SKOR: coin puanını EKLE.
        score = coalesce(score, 0) + v_value,
        round_score = coalesce(round_score, 0) + v_value,
        mission_done = duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    where room_code = v_code and slot = v_pl.slot;

  -- Objective chain: if the objective is now satisfied, reroll it (adds bonus).
  select duo_mission_satisfied(v_pl.objective, v_collected, v_pl.stolen, v_pl.coins + 1)
    into v_satisfied;
  if v_satisfied then
    perform duo_reroll_objective(v_code, v_pl.slot);
  end if;

  return jsonb_build_object('ok', true, 'value', v_value, 'type', v_coin.type, 'objectiveDone', v_satisfied);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. duo_steal — çalma PUANINI skora EKLE + görev zinciri.
--    0012 bu satırı düşürmüştü; puan tabanlı skor için geri getiriyoruz.
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

  update duo_players
    set stolen = v_new_stolen,
        -- PUAN TABANLI SKOR: çalma puanını EKLE.
        score = coalesce(score, 0) + v_steal_score,
        round_score = coalesce(round_score, 0) + v_steal_score,
        mission_done = duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    where room_code = v_code and slot = v_pl.slot;

  -- The victim loses a coin AND the stolen points (never below zero) + is slowed.
  update duo_players
    set coins = greatest(0, coins - 1),
        score = greatest(0, coalesce(score, 0) - v_steal_score),
        round_score = greatest(0, coalesce(round_score, 0) - v_steal_score),
        slowed_until = (extract(epoch from now()) * 1000)::bigint + 400
    where room_code = v_code and slot = v_opp.slot;

  -- Objective chain: reroll if the steal objective is now satisfied (adds bonus).
  select duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    into v_satisfied;
  if v_satisfied then
    perform duo_reroll_objective(v_code, v_pl.slot);
  end if;

  return jsonb_build_object('ok', true, 'stolen', v_new_stolen, 'score', v_steal_score, 'objectiveDone', v_satisfied);
end;
$$;

grant execute on function duo_collect(text, text, int) to anon, authenticated;
grant execute on function duo_steal(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. duo_start_round — tur başında `objectives_done` sayacını da sıfırla.
--    0004 bu alanı sıfırlamıyordu; puan tabanlı skorda `objectives_done`
--    yalnızca istatistiktir ama tur başına sıfırlanması doğru davranıştır
--    (aksi halde sayaç turlar arası birikir ve yanıltıcı olur).
--    `score`/`round_score` zaten sıfırlanır (tur başına puan).
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
  v_pl := duo_require_player(v_code, p_token);

  if v_pl.player_id <> 'p1' then
    raise exception 'not_host' using errcode = 'P0001';
  end if;

  select * into v_room from duo_rooms where code = v_code;

  select count(*) into v_count from duo_players where room_code = v_code;
  if v_count < 2 then
    raise exception 'not_ready' using errcode = 'P0001';
  end if;

  if v_room.phase not in ('lobby', 'results') then
    raise exception 'not_ready' using errcode = 'P0001';
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
        -- PUAN TABANLI SKOR: tur başına puan sıfırlanır; `objectives_done`
        -- yalnızca istatistik olduğu için o da tur başına sıfırlanır.
        score = 0,
        round_score = 0,
        objectives_done = 0,
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

  return jsonb_build_object('ok', true, 'round', v_room.round, 'countdownEndsAt', v_countdown_end);
end;
$$;

grant execute on function duo_start_round(text, text) to anon, authenticated;
