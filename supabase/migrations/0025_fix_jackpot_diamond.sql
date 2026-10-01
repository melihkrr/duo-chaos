-- ============================================================================
-- 0025_fix_jackpot_diamond.sql
--
-- SORUN (mantık hatası — "elması alsam bile hemen tekrar çıkıyor"):
--
--   Jackpot (elmas) TEK SEFERLİK, 50 puanlık bir ödüldür. Ancak üç ayrı yerde
--   elmas normal bir coin gibi davranıyordu:
--
--   1) SUNUCU `duo_collect` (0022): elmas toplandığında `respawn_at = now+3000`
--      yazıyordu. `duo_respawn_coins` (0016) elmasları `type <> 'diamond'`
--      filtresiyle canlandırmasa da, `respawn_at > 0` kalan elmas satırı
--      istemciye "3 sn sonra geri gelecek" sinyali veriyordu.
--
--   2) SUNUCU `duo_tick` (0020) jackpot bloğu: yalnızca "toplanmamış elmas var
--      mı?" diye bakıyordu (`collected_by is null`). Elmas toplandıktan sonra
--      bu koşul YENİDEN doğru oluyor ve blok her tick'te elması yeniden
--      eklemeye çalışıyordu. `on conflict (room_code, coin_id) do nothing`
--      sayesinde satır yeniden OLUŞMUYOR ama `collected_by` hâlâ dolu olduğu
--      için elmas "alınmış" kalıyordu; yine de bu, mantığın kırılgan olmasına
--      ve istemci tarafındaki canlandırma ile birleşince elmasın "yeniden
--      belirmesine" yol açıyordu.
--
--   3) İSTEMCİ (lib/useGameLoop.ts + lib/useDuoChaos.ts): `respawnAt` dolan
--      HER coini (elmas dahil) canlandırıyordu. Bu, 0025 ile birlikte
--      düzeltildi (istemci tarafı ayrı commit'te).
--
-- ÇÖZÜM:
--   * `duo_collect`: elmas için `respawn_at = 0` yaz (asla canlanmaz). Normal
--     coinler için 3000 ms (0022 ile aynı) korunur.
--   * `duo_tick` jackpot bloğu: elmasın o turda DAHA ÖNCE hiç eklenip
--     eklenmediğine bak (`collected_by` durumundan BAĞIMSIZ). Böylece elmas
--     tur başına tam olarak BİR KEZ doğar; alınsa da alınmasa da tekrar
--     eklenmez. (Tur değişince `coin_id = 900 + round` farklılaşır ve yeni tur
--     için taze bir elmas doğabilir.)
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0020 ve 0022'den SONRA çalışır,
-- bu yüzden nihai `duo_tick` ve `duo_collect` tanımları buradadır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_collect — elmas için respawn planlama (0022 mantığı korunur).
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

  -- ELMAS İSTİSNASI (0025): elmas TEK SEFERLİKTİR. `respawn_at = 0` yazarız;
  -- böylece `duo_respawn_coins` (zaten `type <> 'diamond'` filtreliyor) ve
  -- istemci tarafı onu ASLA canlandırmaz. Normal coinler 3000 ms sonra aynı
  -- konum/renkte geri gelir (0022 ile hizalı).
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

grant execute on function duo_collect(text, text, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_tick — jackpot elması TUR BAŞINA BİR KEZ doğar (0020 mantığı korunur).
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
  v_respawned int;
  v_round_scores jsonb;
  v_match_scores jsonb;
  v_next_phase duo_phase;
  v_winner text;
  v_p1_obj jsonb;
  v_p2_obj jsonb;
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

  -- 2. battle -> results/matchover (SUNUCU OTORİTESİ).
  if v_room.phase = 'battle' and v_now >= v_room.ends_at then
    v_round_scores := '{}'::jsonb;
    v_match_scores := coalesce(v_room.match_scores, '{}'::jsonb);

    update duo_players
      set round_score = score,
          total_score = coalesce((v_match_scores->>player_id)::int, 0) + score
      where room_code = v_code;

    select jsonb_object_agg(player_id, score) into v_round_scores
      from duo_players where room_code = v_code;

    select jsonb_object_agg(player_id, total_score) into v_match_scores
      from duo_players where room_code = v_code;

    v_next_phase := case when v_room.round >= 3 then 'matchover' else 'results' end;

    if v_next_phase = 'matchover' then
      select player_id into v_winner
        from duo_players
        where room_code = v_code
        order by total_score desc, slot asc
        limit 1;
    end if;

    update duo_rooms
      set phase = v_next_phase,
          round_scores = v_round_scores,
          match_scores = v_match_scores,
          winner = v_winner,
          chaos_event = null,
          chaos_ends_at = 0,
          updated_at = now()
      where code = v_code;

    return jsonb_build_object(
      'ok', true,
      'phase', v_next_phase,
      'winner', v_winner,
      'roundScores', v_round_scores,
      'matchScores', v_match_scores,
      'changed', true
    );
  end if;

  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', true, 'phase', v_room.phase, 'changed', v_changed);
  end if;

  v_battle_start := v_room.ends_at - 90000;
  v_half := v_battle_start + 45000;

  -- 3. trigger chaos event at the halfway point (once per round)
  if v_room.chaos_event is null and v_now >= v_half then
    v_event := duo_chaos_for_round(v_room.round_seed);

    insert into duo_events (room_code, round, event, started_at, ends_at)
    values (v_code, v_room.round, v_event, v_now, v_now + 15000);

    -- Diamond appears ONLY for the jackpot event.
    --
    -- DÜZELTME (0025): eskiden yalnızca "toplanmamış elmas var mı?" kontrol
    -- ediliyordu (`collected_by is null`). Elmas toplandıktan sonra bu koşul
    -- yeniden doğru oluyor ve blok her tick'te elması yeniden eklemeye
    -- çalışıyordu. Artık o TUR için elmasın DAHA ÖNCE hiç eklenip
    -- eklenmediğine bakıyoruz (`coin_id = 900 + round`), `collected_by`
    -- durumundan BAĞIMSIZ. Böylece elmas tur başına tam olarak BİR KEZ doğar;
    -- alınsa da alınmasa da tekrar eklenmez.
    if v_event = 'jackpot' then
      select exists(
        select 1 from duo_coins
        where room_code = v_code and coin_id = 900 + v_room.round
      ) into v_has_diamond;

      if not v_has_diamond then
        insert into duo_coins (room_code, coin_id, x, y, type)
        values (v_code, 900 + v_room.round, 50, 50, 'diamond')
        on conflict (room_code, coin_id) do nothing;
      end if;
    end if;

    -- CHAOS SWAP — GERÇEK KARŞILIKLI TAKAS.
    if v_event = 'swap' then
      select objective into v_p1_obj
        from duo_players where room_code = v_code and slot = 1;
      select objective into v_p2_obj
        from duo_players where room_code = v_code and slot = 2;

      if v_p1_obj is not null and v_p2_obj is not null then
        update duo_players
          set objective = case when slot = 1 then v_p2_obj else v_p1_obj end,
              coins = 0,
              stolen = 0,
              collected_types = '{}'::jsonb,
              mission_done = false
          where room_code = v_code and slot in (1, 2);
      end if;
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

  -- 4. expire the chaos event
  if v_room.chaos_event is not null and v_now >= v_room.chaos_ends_at then
    update duo_rooms
      set chaos_event = null, chaos_ends_at = 0, updated_at = now()
      where code = v_code;
    v_room.chaos_event := null;
    v_room.chaos_ends_at := 0;
    v_changed := true;
  end if;

  -- 5. resource wave every 12s of battle
  v_wave := floor((v_now - v_battle_start) / 12000.0)::int;
  if v_wave > 0 then
    perform duo_spawn_wave(v_code, v_room.round, v_wave);
  end if;

  -- 6. magnet drift toward the centre
  if v_room.chaos_event = 'magnet' and v_now < v_room.chaos_ends_at then
    update duo_coins
      set x = x + (50 - x) * 0.018,
          y = y + (50 - y) * 0.018
      where room_code = v_code
        and collected_by is null
        and type <> 'diamond';
    v_changed := true;
  end if;

  -- 7. respawn collected coins whose timer elapsed — SAME spot, SAME colour.
  v_respawned := duo_respawn_coins(v_code);
  if v_respawned > 0 then
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

-- PostgREST şema önbelleğini tazele.
notify pgrst, 'reload schema';
