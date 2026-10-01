-- ============================================================================
-- 0019_advance_phase_idempotent.sql
--
-- SORUN (0018'in getirdiği YARIŞ DURUMU / race condition):
--
--   0018 ile `duo_tick` artık süre dolduğunda turu SUNUCUDA bitiriyor
--   (`battle -> results/matchover`). Ancak istemci de süre dolduğunda
--   `duo_advance_phase` çağırıyor. İki çağrı YARIŞIYOR:
--
--     1. `duo_tick` önce çalışırsa oda `results` olur.
--     2. İstemcinin `duo_advance_phase` çağrısı `results` dalına düşer; bu dal
--        `round = round + 1` yapıp `duo_start_round` çağırır → SONUÇ EKRANI
--        ATLANIR ve tur kendiliğinden başlar ("sonuç ekranı görünmeden yeni tur
--        başlıyor" hatası).
--
--   Ayrıca `duo_advance_phase`'in `results` dalı, "turu bitir" çağrısıyla
--   "sonraki tura geç" çağrısını AYNI fonksiyonda birleştirdiği için bu iki
--   niyeti ayırt edemiyor.
--
-- ÇÖZÜM:
--   1. `duo_advance_phase` YALNIZCA `countdown -> battle` ve
--      `battle -> results/matchover` geçişlerini yapar. Oda zaten
--      `results`/`matchover` ise (yani tur bitmişse) HİÇBİR ŞEY yapmadan
--      mevcut fazı döndürür (idempotent). Böylece `duo_tick` ile yarışsa bile
--      tur İKİ KEZ ilerlemez ve sonuç ekranı atlanmaz.
--   2. Sonraki tura geçiş için AYRI bir `duo_next_round` RPC'si eklenir.
--      Yalnızca host (p1) çağırabilir, yalnızca `results` fazında çalışır ve
--      turu artırıp `duo_start_round`'u başlatır. İstemci "next round"
--      el sıkışması tamamlandığında bunu çağırır.
--
-- Idempotent: güvenle tekrar çalıştırılabilir.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_advance_phase — yalnızca countdown->battle ve battle->results.
--    `results`/`matchover` fazında idempotent (no-op).
-- ---------------------------------------------------------------------------
create or replace function duo_advance_phase(p_code text, p_token text)
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
  v_round_scores jsonb;
  v_match_scores jsonb;
  v_next_phase duo_phase;
  v_winner text;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  if v_room.phase = 'countdown' then
    if v_now < v_room.countdown_ends_at - 250 then
      raise exception 'not_ready' using errcode = 'P0001';
    end if;
    update duo_rooms
      set phase = 'battle',
          countdown_ends_at = 0,
          ends_at = v_now + 90000,
          updated_at = now()
      where code = v_code;
    return jsonb_build_object('ok', true, 'phase', 'battle', 'serverNow', v_now, 'endsAt', v_now + 90000);

  elsif v_room.phase = 'battle' then
    if v_now < v_room.ends_at - 500 then
      raise exception 'not_ready' using errcode = 'P0001';
    end if;

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
      'serverNow', v_now
    );
  end if;

  -- `results` / `matchover` / `lobby`: tur zaten bitmiş (veya hiç başlamamış).
  -- Burada HİÇBİR ŞEY yapmayız; mevcut fazı döndürürüz. Böylece `duo_tick`
  -- ile yarışan bir "turu bitir" çağrısı turu İKİ KEZ ilerletemez ve sonuç
  -- ekranı atlanmaz. Sonraki tura geçiş yalnızca `duo_next_round` ile olur.
  return jsonb_build_object(
    'ok', true,
    'phase', v_room.phase,
    'winner', v_room.winner,
    'roundScores', v_room.round_scores,
    'matchScores', v_room.match_scores,
    'serverNow', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. duo_next_round — sonuç ekranından SONRAKİ tura geçiş (yalnızca host).
--    `results` fazında turu artırır ve `duo_start_round`'u başlatır.
-- ---------------------------------------------------------------------------
create or replace function duo_next_round(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_room duo_rooms;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  if v_pl.player_id <> 'p1' then
    raise exception 'not_host' using errcode = 'P0001';
  end if;

  -- Yalnızca sonuç ekranından ilerlenebilir. Oda zaten bir sonraki turun
  -- `countdown`/`battle` fazındaysa (gecikmiş/çift çağrı) mevcut durumu
  -- döndürürüz — tur İKİ KEZ artmaz.
  if v_room.phase <> 'results' then
    return jsonb_build_object(
      'ok', true,
      'phase', v_room.phase,
      'round', v_room.round,
      'countdownEndsAt', v_room.countdown_ends_at,
      'serverNow', (extract(epoch from now()) * 1000)::bigint
    );
  end if;

  if v_room.round >= 3 then
    raise exception 'not_ready' using errcode = 'P0001';
  end if;

  update duo_rooms set round = round + 1, updated_at = now() where code = v_code;
  return duo_start_round(v_code, p_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Grants (idempotent).
-- ---------------------------------------------------------------------------
grant execute on function duo_advance_phase(text, text) to anon, authenticated;
grant execute on function duo_next_round(text, text) to anon, authenticated;
