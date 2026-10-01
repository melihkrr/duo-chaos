-- ============================================================================
-- 0027_round_stats_authority.sql
--
-- SORUN (kullanıcı şikâyeti — "çelişkili round result"):
--   Round sonuç ekranında İKİ istemci AYNI oyuncular için FARKLI istatistik
--   gösteriyordu. Örnek:
--       İstemci A: Melih 🪙59 🦹6 🎯0 | Rival 🪙1  🦹0 🎯4
--       İstemci B: Rival 🪙37 🦹7 🎯4 | Melih 🪙50 🦹4 🎯0
--
-- KÖK NEDEN:
--   Sonuç ekranı `player.coins` / `player.stolen` / `player.objectivesDone`
--   alanlarını gösteriyordu. Ancak `coins` ve `stolen` TUR TOPLAMI DEĞİLDİR:
--   `duo_reroll_objective` her görev tamamlandığında bu sayaçları SIFIRLAR
--   (bkz. 0021 satır 78-79). Yani `coins` = "son görev tamamlanmasından beri
--   toplanan coin" olur. Ayrıca istemci bu alanları iyimser (optimistic) yerel
--   durumdan güncellediği için iki istemcide farklı değerler oluşuyordu.
--   `roundTotalRef` yalnızca YEREL oyuncunun toplamını düzeltiyordu; rakibin
--   ve görev sayacının desync'i devam ediyordu.
--
-- ÇÖZÜM (SUNUCU OTORİTESİ — tur istatistikleri):
--   1. `duo_players` tablosuna `round_coins` ve `round_stolen` sütunları eklenir.
--      Bu sayaçlar TUR boyunca BİRİKİR ve görev tamamlanmasında SIFIRLANMAZ.
--   2. `duo_collect`  → `round_coins = round_coins + 1`.
--   3. `duo_steal`    → `round_stolen = round_stolen + 1` (kurbanın `round_coins`
--      değeri 1 azalır; taban 0 — çalınan coin tur toplamından düşülür).
--   4. `duo_start_round` → tur başında `round_coins = 0`, `round_stolen = 0`.
--   5. `duo_public_state` → her oyuncu için `roundCoins` / `roundStolen` döner.
--      Böylece İKİ istemci de AYNI sunucu değerlerini görür; desync imkânsız.
--
--   `objectivesDone` zaten tur başına sıfırlanan ve sunucudan gelen bir
--   sayaçtır; sonuç ekranı onu sunucudan okumaya devam eder.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0026'dan SONRA çalışır, bu
-- yüzden nihai `duo_public_state` tanımı buradadır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Sütunlar: tur boyunca biriken GERÇEK toplamlar.
-- ---------------------------------------------------------------------------
alter table duo_players
  add column if not exists round_coins int not null default 0;

alter table duo_players
  add column if not exists round_stolen int not null default 0;

-- ---------------------------------------------------------------------------
-- 2. duo_collect — tur toplamını da artır (görev sıfırlamasından BAĞIMSIZ).
--    Gövde 0021'deki tanımla aynıdır; yalnızca `round_coins = round_coins + 1`
--    eklenmiştir.
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
        -- TUR TOPLAMI: görev sıfırlamasından bağımsız, tur boyunca birikir.
        round_coins = coalesce(round_coins, 0) + 1,
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
-- 3. duo_steal — tur toplamını da artır (görev sıfırlamasından BAĞIMSIZ).
--    Gövde 0021'deki tanımla aynıdır; `round_stolen`/`round_coins` eklenmiştir.
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
        -- TUR TOPLAMI: çalınan coin tur boyunca birikir.
        round_stolen = coalesce(round_stolen, 0) + 1,
        -- PUAN TABANLI SKOR: çalma puanını EKLE.
        score = coalesce(score, 0) + v_steal_score,
        round_score = coalesce(round_score, 0) + v_steal_score,
        mission_done = duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    where room_code = v_code and slot = v_pl.slot;

  -- The victim loses a coin AND the stolen points (never below zero) + is slowed.
  -- TUR TOPLAMI: kurbanın tur toplamından da 1 düşer (taban 0) — çalınan coin
  -- artık onun değildir; iki istemci de aynı değeri görür.
  update duo_players
    set coins = greatest(0, coins - 1),
        round_coins = greatest(0, coalesce(round_coins, 0) - 1),
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
-- 4. duo_start_round — tur başında tur toplamlarını sıfırla.
--    ÖNEMLİ: Gövde 0023_soft_start_round.sql'deki YUMUŞAK hata sözleşmesini
--    KORUR (`raise exception` DEĞİL, `jsonb_build_object('ok', false, ...)`).
--    0021'in sert sürümünü kullanmak 0023 regresyonunu geri getirirdi
--    ("maç başlamıyor" / "sonraki tur başlamıyor"). Yalnızca `round_coins` /
--    `round_stolen` sıfırlaması eklenmiştir.
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
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'room_not_found');
  end if;

  select * into v_pl from duo_players where room_code = v_code and token = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;

  if v_pl.player_id <> 'p1' then
    return jsonb_build_object('ok', false, 'reason', 'not_host');
  end if;

  select count(*) into v_count from duo_players where room_code = v_code;
  if v_count < 2 then
    return jsonb_build_object('ok', false, 'reason', 'not_ready');
  end if;

  -- Yalnızca ilk tur (lobby) veya sonraki tur (results) başlatılabilir.
  -- Oda zaten countdown/battle ise (gecikmiş/çift çağrı) mevcut durumu
  -- döndürürüz — tur İKİ KEZ başlamaz ve `duo_next_round` iptal olmaz.
  if v_room.phase not in ('lobby', 'results') then
    return jsonb_build_object(
      'ok', false,
      'reason', 'not_ready',
      'phase', v_room.phase,
      'round', v_room.round,
      'countdownEndsAt', v_room.countdown_ends_at,
      'serverNow', v_now
    );
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
        -- TUR TOPLAMI: yeni turda sıfırlanır.
        round_coins = 0,
        round_stolen = 0,
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

  return jsonb_build_object(
    'ok', true,
    'round', v_room.round,
    'countdownEndsAt', v_countdown_end,
    'endsAt', v_battle_end,
    'serverNow', v_now
  );
end;
$$;

grant execute on function duo_start_round(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. duo_public_state — her oyuncu için `roundCoins` / `roundStolen` döndür.
--    Gövde 0026 ile aynıdır; iki alan eklenmiştir. Böylece sonuç ekranı İKİ
--    istemcide de AYNI sunucu değerlerini gösterir.
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
      'roundCoins', p.round_coins,
      'roundStolen', p.round_stolen,
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
