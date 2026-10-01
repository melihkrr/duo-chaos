-- ============================================================================
-- 0023_soft_start_round.sql
--
-- SORUN (REGRESYON — sert hata, "maç başlamıyor" / "sonraki tur başlamıyor"):
--
--   0010_lobby_readiness.sql `duo_start_round`'u YUMUŞAK hata sözleşmesine
--   çevirdi: başarısızlıkta `raise exception` yerine
--   `jsonb_build_object('ok', false, 'reason', ...)` döndürür. İstemci
--   (`lib/useDuoChaos.ts` → `startGame`) tam olarak bunu bekler:
--
--       if (res && res.ok === false) { setError(friendlyError(res.reason, ...)); return }
--
--   Ancak 0021_points_scoring.sql `duo_start_round`'u YENİDEN tanımlarken
--   yumuşak dönüşleri tekrar `raise exception 'not_ready'` (HTTP 400) yaptı.
--   Sonuçlar:
--
--     * Host, rakip satırı henüz commit edilmeden "Start"a basarsa istemci
--       `ok:false` dalına GİREMEZ; genel `catch`'e düşer ve belirsiz bir hata
--       gösterir ("maç başlamıyor" hissi).
--     * DAHA KRİTİK: 0019'daki `duo_next_round` sonunda `duo_start_round`'u
--       ÇAĞIRIR. Oda fazı o an `lobby`/`results` değilse (gecikmiş/çift çağrı,
--       `duo_tick` ile yarış) sert `raise` TÜM tur geçişini iptal eder →
--       "iki oyuncu da Next Round'a bastı ama tur başlamadı" hatası.
--
-- ÇÖZÜM:
--   `duo_start_round`'u 0021'deki PUAN TABANLI sıfırlama mantığını KORUYARAK
--   yeniden tanımlar; yalnızca başarısızlık dönüşlerini 0010'daki YUMUŞAK
--   sözleşmeye çevirir (`ok:false, reason`). Böylece:
--     * istemci `ok:false` dalını kullanır ve anlaşılır mesaj gösterir;
--     * `duo_next_round` içindeki çağrı, oda zaten ilerlemişse sessizce
--       mevcut durumu döndürür (tur İKİ KEZ ilerlemez, geçiş iptal olmaz).
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0021'den SONRA çalışır, bu
-- yüzden nihai `duo_start_round` tanımı buradadır.
-- ============================================================================

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

-- PostgREST şema önbelleğini tazele.
notify pgrst, 'reload schema';
