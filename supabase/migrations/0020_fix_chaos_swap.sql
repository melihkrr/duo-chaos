-- ============================================================================
-- 0020_fix_chaos_swap.sql
--
-- SORUN (mantık hatası): "Chaos Swap" olayı görevleri KARŞILIKLI takas etmiyordu.
--
--   0018'deki `duo_tick` swap bloğu `lead(objective) over (order by slot)` ve
--   `lag(objective) over (order by slot)` kullanıyordu:
--
--     update duo_players p
--       set objective = o.objective
--       from (
--         select player_id,
--                lead(objective) over (order by slot) as objective,
--                lag(objective)  over (order by slot) as prev_objective
--         from duo_players where room_code = v_code
--       ) o
--       where p.room_code = v_code
--         and p.player_id = o.player_id
--         and o.objective is not null;
--
--   İki oyuncu için `lead` sıralaması:
--     slot 1 (p1) → lead = p2.objective   (güncellenir)
--     slot 2 (p2) → lead = NULL           (guard yüzünden ATLANIR)
--
--   Yani yalnızca p1'in görevi p2'ninkine eşitleniyor; p2'nin görevi
--   DEĞİŞMİYOR. Sonuç: iki oyuncu AYNI göreve sahip oluyor (takas değil,
--   kopyalama) ve "Chaos Swap" amacına aykırı davranıyor.
--
-- ÇÖZÜM: Görevleri gerçekten KARŞILIKLI takas et. İki oyuncu için tek bir
--   UPDATE ile `case` kullanarak p1'e p2'nin, p2'ye p1'in görevini yazarız.
--   (Genel N oyuncu için `lead`+`lag` birleşimi gerekir; oyun 2 oyunculu
--   olduğundan basit ve deterministik bir takas yeterlidir.)
--
-- Idempotent: güvenle tekrar çalıştırılabilir.
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

    -- CHAOS SWAP — GERÇEK KARŞILIKLI TAKAS.
    -- Önce iki oyuncunun mevcut görevlerini oku, sonra tek UPDATE ile
    -- p1'e p2'nin, p2'ye p1'in görevini yaz. `lead`/`lag` yaklaşımı yalnızca
    -- bir oyuncuyu güncelliyordu (bkz. dosya başlığı).
    if v_event = 'swap' then
      select objective into v_p1_obj
        from duo_players where room_code = v_code and slot = 1;
      select objective into v_p2_obj
        from duo_players where room_code = v_code and slot = 2;

      if v_p1_obj is not null and v_p2_obj is not null then
        update duo_players
          set objective = case when slot = 1 then v_p2_obj else v_p1_obj end,
              -- Takas sonrası ilerleme sıfırlanır: yeni görev temiz başlar.
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
