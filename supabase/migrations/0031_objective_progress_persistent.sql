-- ============================================================================
-- 0031_objective_progress_persistent.sql
--
-- SORUN (kullanıcı şikâyeti — "Steal 3 from your rival · 2/3"):
--   "3 defa çaldım 3/3 olarak gördüm, progress bar doldu; ancak sonrasında
--    2'ye düştü. Aynı durumu coinlerde de yaşıyorum."
--
-- KÖK NEDEN:
--   Görev ilerlemesi `duo_mission_progress(objective, collected_types, stolen,
--   coins)` ile HAM sayaçlardan YENİDEN HESAPLANIYORDU (0029). Ancak görev
--   tamamlandığında `duo_reroll_objective` (0021) şu sayaçları SIFIRLAR:
--
--       coins = 0, stolen = 0, collected_types = '{}'::jsonb
--
--   Yani oyuncu 3 kez çalıp görevi tamamlayınca:
--     1. `duo_steal` → stolen = 3 → mission_satisfied = true
--     2. `duo_reroll_objective` → stolen = 0, YENİ görev atanır
--     3. Bir sonraki `duo_public_state` → `duo_mission_progress` YENİ görev
--        için stolen = 0 okur → objectiveProgress = 0 döner.
--
--   İstemci (lib/useDuoChaos.ts `mergeProgress`) yalnızca BAYAT snapshot'a
--   karşı monotonikti (`max(yerel, sunucu)`). Ama burada sunucu GERÇEKTEN
--   düşük bir değer döndürüyor (görev değiştiği için). İstemci görev
--   değişimini `objectiveChanged` ile yakalasa da, sunucu yeni görevin
--   ilerlemesini 0 döndürdüğü için bar "3/3 → 0" olur; kullanıcı bunu
--   "2/3'e düştü" olarak görür (reroll ile yeni görev + eski ilerleme
--   karışımı). Aynı sorun `coins` tabanlı görevlerde de yaşanır.
--
-- ÇÖZÜM (SUNUCU OTORİTESİ — KALICI İLERLEME):
--   1. `duo_players.objective_progress int not null default 0` kolonu eklenir.
--      Bu, AKTİF görevin ilerlemesini KALICI olarak tutar.
--   2. `duo_public_state` artık `duo_mission_progress(...)` ile YENİDEN
--      hesaplamak yerine bu KALICI değeri döndürür. Sayaçlar sıfırlansa bile
--      ilerleme korunur.
--   3. `duo_collect` / `duo_steal`: ilerlemeyi `duo_mission_progress` ile
--      yeniden hesaplayıp `objective_progress`'e MONOTONİK yazar
--      (`greatest(mevcut, yeni)`). Böylece ilerleme asla geri düşmez.
--   4. `duo_reroll_objective`: yeni görev atanırken `objective_progress = 0`
--      yapar (yeni görev sıfırdan başlar) — ama bu, görev TAMAMLANDIĞI anda
--      olur ve istemci `objectiveChanged` ile yeni görevi (0 ilerlemeyle)
--      benimser. Tamamlanan görevin "3/3" görüntüsü kutlama süresince
--      istemcide korunur (objectiveHold).
--   5. `duo_start_round`: tur başında `objective_progress = 0` sıfırlar.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0030'dan SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Kalıcı ilerleme kolonu.
-- ---------------------------------------------------------------------------
alter table duo_players
  add column if not exists objective_progress int not null default 0;

-- ---------------------------------------------------------------------------
-- 2. duo_public_state — `objectiveProgress` artık KALICI kolondan okunur.
--    Gövde 0029 ile aynıdır; yalnızca `objectiveProgress` satırı değişmiştir.
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

  -- Oyuncu listesi. GÖREVLER ARTIK HERKESE AÇIK.
  -- `objectiveProgress`: KALICI kolon (0031). Sayaçlar sıfırlansa bile
  -- ilerleme korunur; istemci bunu doğrudan gösterir.
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
      'objectiveProgress', coalesce(p.objective_progress, 0),
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
    'coins', coalesce(v_coins, '[]'::jsonb),
    'players', coalesce(v_players, '[]'::jsonb)
  );
end;
$$;

grant execute on function duo_public_state(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. duo_collect — kalıcı ilerlemeyi MONOTONİK güncelle.
--    Gövde 0025 ile aynıdır; `objective_progress` güncellemesi eklenmiştir.
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

  -- Objective chain: if the objective is now satisfied, reroll it (adds bonus).
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
-- 4. duo_steal — kalıcı ilerlemeyi MONOTONİK güncelle.
--    Gövde 0027 ile aynıdır; `objective_progress` güncellemesi eklenmiştir.
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

  -- Objective chain: reroll if the steal objective is now satisfied (adds bonus).
  select duo_mission_satisfied(v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins)
    into v_satisfied;
  if v_satisfied then
    perform duo_reroll_objective(v_code, v_pl.slot);
  end if;

  return jsonb_build_object('ok', true, 'stolen', v_new_stolen, 'score', v_steal_score, 'objectiveDone', v_satisfied);
end;
$$;

grant execute on function duo_steal(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. duo_reroll_objective — yeni görev atanırken kalıcı ilerlemeyi SIFIRLA.
--    Gövde 0021 ile aynıdır; `objective_progress = 0` eklenmiştir.
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
        score = coalesce(score, 0) + v_bonus,
        round_score = coalesce(round_score, 0) + v_bonus,
        objective = v_next,
        coins = 0,
        stolen = 0,
        collected_types = '{}'::jsonb,
        -- KALICI İLERLEME (0031): yeni görev sıfırdan başlar.
        objective_progress = 0,
        mission_done = false
    where room_code = p_room and slot = p_slot;
end;
$$;

revoke execute on function duo_reroll_objective(text, int) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. duo_start_round — tur başında kalıcı ilerlemeyi sıfırla.
--    Gövde 0027'deki tanımla BİREBİR aynıdır (yumuşak hata sözleşmesi,
--    `duo_objective_pair`, skor/spawn sıfırlamaları korunur); yalnızca
--    `objective_progress = 0` eklenmiştir.
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
        -- KALICI İLERLEME (0031): yeni turda sıfırlanır.
        objective_progress = 0,
        -- PUAN TABANLI SKOR: tur başına puan sıfırlanır.
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

-- PostgREST şema önbelleğini tazele.
notify pgrst, 'reload schema';
