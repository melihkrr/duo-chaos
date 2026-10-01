-- ============================================================================
-- 0030_fix_chaos_once_per_round.sql
--
-- SORUN (kullanıcı şikâyeti — "Jackpot bir kez çıkıyor, 2. veya 3. kez
-- çıkmıyor / elmas görünmüyor"):
--
--   Chaos olayı (ör. Jackpot) tur içinde BİRDEN FAZLA kez tetikleniyordu.
--   `duo_tick` (0025) tetikleme koşulu şuydu:
--
--       if v_room.chaos_event is null and v_now >= v_half then ...
--
--   Olay 15 sn sürüyor; süre dolunca 4. adım `chaos_event = null` yapıyor.
--   Ama `v_now >= v_half` hâlâ doğru olduğu için bir sonraki tick'te koşul
--   YENİDEN sağlanıyor ve olay AYNI TURDA tekrar tetikleniyordu.
--
--   Jackpot için bu özellikle kırıcıydı: elmas `coin_id = 900 + round` ile
--   TUR BAŞINA BİR KEZ doğar (0025). Olay ikinci kez tetiklendiğinde
--   `v_has_diamond` (coin_id = 900 + round zaten var) TRUE dönüyor ve YENİ
--   elmas EKLENMİYORDU. Sonuç: banner tekrar görünüyor ama ortada elmas yok.
--   ("bir den fazla çıkınca 2. veya 3. de çıkmıyor")
--
-- ÇÖZÜM:
--   Chaos tetiklemesini TUR BAŞINA TAM OLARAK BİR KEZ ile sınırlarız.
--   `duo_events` tablosu zaten her olayı (room_code, round, event) olarak
--   loglar. Tetiklemeden ÖNCE bu tur için bir kayıt var mı diye bakarız;
--   varsa olayı YENİDEN tetiklemeyiz (ne banner ne elmas ne swap).
--
--   Böylece:
--     * Olay turda bir kez tetiklenir, 15 sn sürer, biter ve bir daha
--       tetiklenmez (tur bitene kadar).
--     * Jackpot elması tur başına bir kez doğar ve görünür.
--     * Swap tur başına bir kez uygulanır (tekrar tekrar görev takaslanmaz).
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0025'ten SONRA çalışır, bu
-- yüzden nihai `duo_tick` tanımı buradadır.
-- ============================================================================

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
  v_already_fired boolean;
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

  -- 3. trigger chaos event at the halfway point — TUR BAŞINA TAM BİR KEZ.
  --
  -- DÜZELTME (0030): eskiden koşul yalnızca `chaos_event is null` idi. Olay
  -- 15 sn sonra expire olup `chaos_event = null` yapınca, `v_now >= v_half`
  -- hâlâ doğru olduğu için olay AYNI TURDA tekrar tetikleniyordu. Artık
  -- `duo_events`'te bu tur için bir kayıt olup olmadığına da bakarız; varsa
  -- olayı yeniden tetiklemeyiz.
  if v_room.chaos_event is null and v_now >= v_half then
    select exists(
      select 1 from duo_events
      where room_code = v_code and round = v_room.round
    ) into v_already_fired;

    if not v_already_fired then
      v_event := duo_chaos_for_round(v_room.round_seed);

      insert into duo_events (room_code, round, event, started_at, ends_at)
      values (v_code, v_room.round, v_event, v_now, v_now + 15000);

      -- Diamond appears ONLY for the jackpot event.
      --
      -- DÜZELTME (0025): elmasın o turda DAHA ÖNCE hiç eklenip eklenmediğine
      -- bak (`coin_id = 900 + round`), `collected_by` durumundan BAĞIMSIZ.
      -- Böylece elmas tur başına tam olarak BİR KEZ doğar.
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
