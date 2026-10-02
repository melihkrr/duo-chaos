-- ============================================================================
-- 0051_risky_coins.sql
--
-- STEAL KALDIRILDI → "RISKY COIN" (yüksek puanlı bonus coin yarışı)
--
-- Neden: Temas tabanlı çalma mekaniği (0042/0049/0050) istemci-sunucu konum
-- örneklemesine bağlıydı ve "bazen çalıyor bazen çalmıyor" şeklinde
-- tekrarlanabilir olmayan hatalar üretiyordu. Temas modeli tamamen kaldırıldı.
--
-- Yeni sistem (temas YOK, sadece toplama yarışı):
--   * Haritada periyodik olarak (her ~15s) yüksek puanlı "risky" coin doğar.
--   * Coin id aralığı 2000+ (şema değişikliği YOK; mevcut coin_id int kolonu).
--   * Değerler: risky gold=40, risky emerald=45, risky diamond=60.
--   * Doğduktan sonra 8s içinde toplanmazsa kaybolur (despawn).
--   * Toplanınca ASLA yeniden doğmaz (diamond gibi respawn_at = 0).
--   * İlk toplayan kazanır — mevcut satır kilidi (FOR UPDATE) atomikliği yeterli.
--
-- Geriye dönük uyumlu: eski istemciler duo_steal_versioned çağırırsa
-- {ok:false, reason:'removed'} alır (hata değil, sessiz no-op).
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0050'den SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Risky coin sabitleri (tek yerde; fonksiyonlar bunları kullanır)
-- ---------------------------------------------------------------------------
create or replace function duo_risky_coin_id_base()
returns int
language sql
immutable
as $$ select 2000 $$;

-- Doğuş noktaları: deterministik "hot-spot" rotasyonu (merkez + iki yan).
create or replace function duo_risky_spawn_point(p_index int)
returns jsonb
language sql
immutable
as $$
  select case (p_index % 3)
    when 0 then jsonb_build_object('x', 50, 'y', 50)
    when 1 then jsonb_build_object('x', 50, 'y', 22)
    else        jsonb_build_object('x', 50, 'y', 78)
  end;
$$;

-- Risky coin tipi rotasyonu: gold → emerald → diamond → gold ...
create or replace function duo_risky_coin_type(p_index int)
returns duo_coin_type
language sql
immutable
as $$
  select (array['gold','emerald','diamond']::duo_coin_type[])[(p_index % 3) + 1];
$$;

-- ---------------------------------------------------------------------------
-- 2. duo_coin_value — risky coin id'leri (2000+) yüksek puan döndürür.
--    İmza değişmez; yalnızca yeni bir "p_coin_id" parametresi EKLENMEZ
--    (mevcut çağrılar bozulmasın) → bunun yerine ayrı bir yardımcı fonksiyon
--    duo_risky_coin_value(type) eklenir ve duo_collect_batch onu kullanır.
-- ---------------------------------------------------------------------------
create or replace function duo_risky_coin_value(p_type duo_coin_type)
returns int
language sql
immutable
as $$
  select case p_type
    when 'gold'    then 40
    when 'emerald' then 45
    when 'diamond' then 60
    else 30
  end;
$$;

-- ---------------------------------------------------------------------------
-- 3. duo_spawn_risky_coin — tek bir risky coin doğurur.
--    p_index: deterministik rotasyon indeksi (tick sayacından türetilir).
--    Aynı anda yalnızca BİR risky coin olsun diye önce eskiler temizlenir.
-- ---------------------------------------------------------------------------
create or replace function duo_spawn_risky_coin(p_room text, p_index int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base int := duo_risky_coin_id_base();
  v_id int := v_base + (p_index % 1000);
  v_point jsonb := duo_risky_spawn_point(p_index);
  v_type duo_coin_type := duo_risky_coin_type(p_index);
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  -- Önce toplanmamış eski risky coinleri sil (aynı anda tek risky coin).
  delete from duo_coins
    where room_code = p_room
      and coin_id >= v_base
      and collected_by is null;

  insert into duo_coins (room_code, coin_id, x, y, type, respawn_at)
  values (
    p_room,
    v_id,
    (v_point->>'x')::numeric,
    (v_point->>'y')::numeric,
    v_type,
    -- respawn_at burada "despawn deadline" olarak kullanılır (8s).
    v_now + 8000
  )
  on conflict (room_code, coin_id) do update
    set x = excluded.x,
        y = excluded.y,
        type = excluded.type,
        collected_by = null,
        collected_at = null,
        respawn_at = excluded.respawn_at;

  return v_id;
end;
$$;

revoke execute on function duo_spawn_risky_coin(text, int) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. duo_tick — her ~15s'de bir risky coin doğur + süresi geçenleri sil.
--    Gövde 0005 ile aynıdır; yalnızca (a) risky spawn ve (b) risky despawn
--    adımları eklenmiştir.
-- ---------------------------------------------------------------------------
create or replace function duo_tick(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_room duo_rooms;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_battle_start bigint;
  v_half bigint;
  v_wave int;
  v_event duo_chaos_event;
  v_has_diamond boolean;
  v_changed boolean := false;
  v_risky_base int := duo_risky_coin_id_base();
  v_risky_slot int;
  v_risky_count int;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  -- 1. countdown -> battle
  if v_room.phase = 'countdown' and v_now >= v_room.countdown_ends_at then
    update duo_rooms
      set phase = 'battle',
          countdown_ends_at = 0,
          ends_at = v_now + 90000,
          updated_at = now()
      where code = v_code;
    v_room.phase := 'battle';
    v_room.ends_at := v_now + 90000;
    v_changed := true;
  end if;

  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', true, 'phase', v_room.phase, 'changed', v_changed);
  end if;

  v_battle_start := v_room.ends_at - 90000;
  v_half := v_battle_start + 45000;

  -- 2. trigger chaos event at the halfway point (once per round)
  if v_room.chaos_event is null and v_now >= v_half then
    v_event := duo_chaos_for_round(v_room.round_seed);

    insert into duo_events (room_code, round, event, started_at, ends_at)
    values (v_code, v_room.round, v_event, v_now, v_now + 15000);

    -- jackpot: drop a single diamond in the centre if none exists
    if v_event = 'jackpot' then
      select exists(
        select 1 from duo_coins
        where room_code = v_code and type = 'diamond' and collected_by is null
      ) into v_has_diamond;

      if not v_has_diamond then
        insert into duo_coins (room_code, coin_id, x, y, type)
        values (v_code, 900 + v_room.round, 50, 50, 'diamond')
        on conflict (room_code, coin_id) do nothing;
      end if;
    end if;

    -- swap: exchange the two players' objectives
    if v_event = 'swap' then
      update duo_players p
        set objective = o.objective
        from (
          select
            player_id,
            lead(objective) over (order by slot) as objective,
            lag(objective) over (order by slot) as prev_objective
          from duo_players
          where room_code = v_code
        ) o
        where p.room_code = v_code
          and p.player_id = o.player_id
          and o.objective is not null;
    end if;

    update duo_rooms
      set chaos_event = v_event,
          chaos_ends_at = v_now + 15000,
          updated_at = now()
      where code = v_code;

    v_room.chaos_event := v_event;
    v_room.chaos_ends_at := v_now + 15000;
    v_changed := true;
  end if;

  -- 5. expire the chaos event
  if v_room.chaos_event is not null and v_now >= v_room.chaos_ends_at then
    update duo_rooms
      set chaos_event = null, chaos_ends_at = 0, updated_at = now()
      where code = v_code;
    v_room.chaos_event := null;
    v_room.chaos_ends_at := 0;
    v_changed := true;
  end if;

  -- 3. resource wave every 12s of battle
  v_wave := floor((v_now - v_battle_start) / 12000.0)::int;
  if v_wave > 0 then
    perform duo_spawn_wave(v_code, v_room.round, v_wave);
  end if;

  -- 3b. RISKY COIN: her ~15s'de bir yüksek puanlı bonus coin doğur.
  --     Rotasyon indeksi battle başlangıcından bu yana geçen 15s dilimleridir.
  v_risky_slot := floor((v_now - v_battle_start) / 15000.0)::int;
  if v_risky_slot > 0 then
    -- Aynı dilimde zaten doğduysa tekrar doğurma (idempotent).
    select count(*) into v_risky_count
      from duo_coins
      where room_code = v_code
        and coin_id = v_risky_base + (v_risky_slot % 1000);
    if v_risky_count = 0 then
      perform duo_spawn_risky_coin(v_code, v_risky_slot);
      v_changed := true;
    end if;
  end if;

  -- 3c. RISKY COIN despawn: 8s içinde toplanmayan risky coinleri sil.
  delete from duo_coins
    where room_code = v_code
      and coin_id >= v_risky_base
      and collected_by is null
      and respawn_at > 0
      and respawn_at <= v_now;

  -- 4. magnet drift toward the centre (risky coinleri etkilemez)
  if v_room.chaos_event = 'magnet' and v_now < v_room.chaos_ends_at then
    update duo_coins
      set x = x + (50 - x) * 0.018,
          y = y + (50 - y) * 0.018
      where room_code = v_code
        and collected_by is null
        and type <> 'diamond'
        and coin_id < v_risky_base;
    v_changed := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'phase', v_room.phase,
    'chaosEvent', v_room.chaos_event,
    'chaosEndsAt', v_room.chaos_ends_at,
    'changed', v_changed
  );
end;
$$;

grant execute on function duo_tick(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. duo_collect_batch — risky coinler (id >= 2000) yüksek puan verir ve
--    toplanınca ASLA yeniden doğmaz (diamond gibi respawn_at = 0).
--    Gövde 0041 ile aynıdır; yalnızca değer ve respawn_at satırları değişti.
-- ---------------------------------------------------------------------------
create or replace function duo_collect_batch(
  p_code text,
  p_token text,
  p_coin_ids int[],
  p_x numeric,
  p_y numeric,
  p_expected_objectives_done int,
  p_expected_round int
)
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
  v_pos jsonb;
  v_coin_id int;
  v_dist numeric;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_value int;
  v_total_value int := 0;
  v_objective_coins int;
  v_round_coins int := 0;
  v_collected jsonb;
  v_progress int;
  v_completed_progress int;
  v_satisfied boolean := false;
  v_counts_for_objective boolean;
  v_accepted_ids int[] := '{}';
  v_after duo_players;
  v_reroll jsonb;
  v_risky_base int := duo_risky_coin_id_base();
  v_is_risky boolean;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_a_player');
  end if;

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', false, 'reason', 'not_battle');
  end if;
  if p_expected_round is not null and p_expected_round <> v_room.round then
    return jsonb_build_object('ok', false, 'reason', 'stale_round');
  end if;

  v_pos := duo_clamp_pos(p_x, p_y);
  v_pl.x := (v_pos->>'x')::numeric;
  v_pl.y := (v_pos->>'y')::numeric;
  update duo_players
    set x = v_pl.x, y = v_pl.y, last_seen_at = now()
    where room_code = v_code and slot = v_pl.slot;

  v_counts_for_objective :=
    p_expected_objectives_done is null
    or p_expected_objectives_done = coalesce(v_pl.objectives_done, 0);
  v_objective_coins := coalesce(v_pl.coins, 0);
  v_collected := coalesce(v_pl.collected_types, '{}'::jsonb);

  -- Stable lock ordering avoids deadlocks if both clients overlap multiple coins.
  for v_coin_id in
    select distinct requested_id
      from unnest(coalesce(p_coin_ids, '{}'::int[])) as requested(requested_id)
      where requested_id is not null
      order by requested_id
  loop
    select * into v_coin
      from duo_coins
      where room_code = v_code and coin_id = v_coin_id
      for update;
    if not found or v_coin.collected_by is not null then
      continue;
    end if;

    v_dist := sqrt(power(v_coin.x - v_pl.x, 2) + power(v_coin.y - v_pl.y, 2));
    if v_dist > 9 then
      continue;
    end if;

    v_is_risky := v_coin.coin_id >= v_risky_base;

    if v_is_risky then
      v_value := duo_risky_coin_value(v_coin.type);
    else
      v_value := duo_coin_value(
        v_coin.type,
        case when v_room.chaos_ends_at > v_now then v_room.chaos_event else null end,
        v_pl.objective
      );
    end if;

    update duo_coins
      set collected_by = v_pl.player_id,
          collected_at = v_now,
          -- risky coinler ve diamond ASLA yeniden doğmaz.
          respawn_at = case
            when v_is_risky or v_coin.type = 'diamond' then 0
            else v_now + 3000
          end
      where room_code = v_code and coin_id = v_coin_id;

    v_accepted_ids := array_append(v_accepted_ids, v_coin_id);
    v_round_coins := v_round_coins + 1;
    v_total_value := v_total_value + v_value;

    -- Risky coinler görev ilerlemesine SAYILMAZ (saf bonus puan).
    if v_counts_for_objective and not v_is_risky then
      v_objective_coins := v_objective_coins + 1;
      v_collected := jsonb_set(
        v_collected,
        array[v_coin.type::text],
        to_jsonb(coalesce((v_collected->>v_coin.type::text)::int, 0) + 1),
        true
      );
    end if;
  end loop;

  if cardinality(v_accepted_ids) = 0 then
    select * into v_after
      from duo_players
      where room_code = v_code and slot = v_pl.slot;
    return jsonb_build_object(
      'ok', true,
      'acceptedCoinIds', '[]'::jsonb,
      'objectiveDone', false,
      'completedProgress', null,
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
  end if;

  if v_counts_for_objective then
    v_progress := duo_mission_progress(
      v_pl.objective, v_collected, v_pl.stolen, v_objective_coins
    );
    v_satisfied := duo_mission_satisfied(
      v_pl.objective, v_collected, v_pl.stolen, v_objective_coins
    );
    update duo_players
      set coins = v_objective_coins,
          collected_types = v_collected,
          objective_progress = greatest(coalesce(v_pl.objective_progress, 0), v_progress),
          mission_done = v_satisfied,
          round_coins = coalesce(round_coins, 0) + v_round_coins,
          score = coalesce(score, 0) + v_total_value,
          round_score = coalesce(round_score, 0) + v_total_value
      where room_code = v_code and slot = v_pl.slot;
  else
    update duo_players
      set round_coins = coalesce(round_coins, 0) + v_round_coins,
          score = coalesce(score, 0) + v_total_value,
          round_score = coalesce(round_score, 0) + v_total_value
      where room_code = v_code and slot = v_pl.slot;
    v_progress := coalesce(v_pl.objective_progress, 0);
  end if;

  v_completed_progress := v_progress;
  if v_satisfied then
    v_reroll := duo_reroll_objective_carry(
      v_code, v_pl.slot, v_collected, v_pl.stolen, v_objective_coins
    );
  end if;

  select * into v_after
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object(
    'ok', true,
    'acceptedCoinIds', to_jsonb(v_accepted_ids),
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

grant execute on function duo_collect_batch(text, text, int[], numeric, numeric, int, int)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. duo_steal_versioned — NÖTRLEŞTİRİLDİ. Artık hiçbir şey yapmaz.
--    Eski istemciler çağırırsa sessizce {ok:false, reason:'removed'} alır.
-- ---------------------------------------------------------------------------
create or replace function duo_steal_versioned(
  p_code text,
  p_token text,
  p_expected_objectives_done int,
  p_expected_round int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Steal mekaniği oyundan tamamen kaldırıldı (bkz. 0051_risky_coins.sql).
  return jsonb_build_object('ok', false, 'reason', 'removed');
end;
$$;

revoke execute on function duo_steal_versioned(text, text, int, int) from anon, authenticated;

-- duo_steal sarmalayıcısı da nötrleştirilir.
create or replace function duo_steal(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return jsonb_build_object('ok', false, 'reason', 'removed');
end;
$$;

revoke execute on function duo_steal(text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. duo_objective_pool — steal görevleri kaldırıldı, yerine iki yeni
--    toplama görevi eklendi. lib/config.ts OBJECTIVE_POOL ile birebir.
-- ---------------------------------------------------------------------------
create or replace function duo_objective_pool()
returns jsonb
language sql
immutable
as $$
  -- `points` = görev tamamlanınca kazanılan PUAN ödülü. lib/config.ts
  -- OBJECTIVE_POOL ile BİREBİR aynı olmalıdır (puan dengesi).
  select '[
    {"id":"gold-rush","kind":"collect","label":"Collect 3 Gold","shortLabel":"3 Gold","target":3,"coinType":"gold","points":45},
    {"id":"blue-raid","kind":"collect","label":"Collect 2 Blue + 2 Red","shortLabel":"2 Blue + 2 Red","target":4,"coinType":"mixed","requirements":{"blue":2,"red":2},"points":60},
    {"id":"emerald-hunt","kind":"collect","label":"Collect 3 Emerald","shortLabel":"3 Emerald","target":3,"coinType":"emerald","points":55},
    {"id":"risky-hunter","kind":"collect","label":"Collect 2 Risky Coins","shortLabel":"2 Risky","target":2,"coinType":"mixed","points":65},
    {"id":"jackpot-run","kind":"collect","label":"Collect 1 Gold + 2 Blue","shortLabel":"1 Gold + 2 Blue","target":3,"coinType":"mixed","requirements":{"gold":1,"blue":2},"points":50},
    {"id":"red-burn","kind":"collect","label":"Collect 2 Red + 1 Emerald","shortLabel":"2 Red + 1 Emerald","target":3,"coinType":"mixed","requirements":{"red":2,"emerald":1},"points":55},
    {"id":"blue-pressure","kind":"collect","label":"Collect 4 Blue","shortLabel":"4 Blue","target":4,"coinType":"blue","points":50},
    {"id":"emerald-rush","kind":"collect","label":"Collect 2 Emerald + 1 Gold","shortLabel":"2 Emerald + 1 Gold","target":3,"coinType":"mixed","requirements":{"emerald":2,"gold":1},"points":70}
  ]'::jsonb;
$$;

-- ---------------------------------------------------------------------------
-- 8. Şema yeniden yükleme bildirimi (PostgREST).
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
