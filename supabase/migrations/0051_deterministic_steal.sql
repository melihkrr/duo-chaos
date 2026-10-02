-- ============================================================================
-- 0051_deterministic_steal.sql
--
-- SORUN (kullanıcı raporu):
--   "bir çalışıyor bir çalışmıyor, bir puanı çalana veriyor bir puanı çalınana
--    veriyor" — çalma ne güvenilir ne de doğru tarafa atfediliyor.
--
-- KÖK NEDENLER (iki ayrı hata):
--
--   1) GÜVENİLMEZLİK ("bir çalışıyor bir çalışmıyor"):
--      İstemci çalmayı CANLI (tahmin edilen) rakip konumuna göre tetikler
--      (`liveRivalPos`), ancak sunucu 0049/0050'de SUNUCU-DEPOLU konumlara
--      göre doğrular. İki konum ayrışır → istemci "temas var" der, sunucu
--      `too_far` döner. Ayrıca 0050'nin yön koruması 300ms'lik taze bir
--      hareket örneği ister; istemci `duo_move` heartbeat'i 1000ms olduğundan
--      örnek çoğu zaman bayattır → `not_chasing`. Sonuç: çalma neredeyse hiç
--      güvenilir tetiklenmez.
--
--   2) YANLIŞ TARAF ("puanı çalınana veriyor"):
--      Yön koruması "kim kovalıyor?" sorusunu BAYAT sunucu örnekleriyle
--      yanıtlamaya çalışır. İki istemci de temas algılayıp RPC çağırır;
--      hangisinin örneği "taze" görünürse o kazanır. Bu neredeyse rastgeledir
--      → bazen ÇALINAN oyuncu +25 alır.
--
-- ÇÖZÜM (PROFESYONEL — deterministik, sunucu otoritesi):
--   Çalan istemci, `duo_collect_batch` ile AYNI desende KENDİ GÜNCEL KONUMUNU
--   (`p_x`, `p_y`) gönderir. Sunucu:
--     a) Konumu `duo_step_ok` ile doğrular (anti-teleport). Geçersizse
--        sunucu-depolu konuma düşer (istemci koordinatına güvenilmez).
--     b) TEMAS: doğrulanmış konum ile rakibin sunucu-depolu konumu arasındaki
--        mesafe `STEAL_RADIUS + SLACK` içinde olmalı. SLACK, rakip konumunun
--        ~1 sn'lik yoklama gecikmesini telafi eder.
--     c) YAKLAŞMA (deterministik saldırgan kuralı): çağıranın GÖNDERDİĞİ
--        konum, sunucu-depolu ÖNCEKİ konumuna göre rakibe DAHA YAKIN olmalı
--        (`dist_after < dist_before`). Böylece yalnızca GERÇEKTEN rakibe doğru
--        hareket edip temasa giren oyuncu çalabilir. Hareketsiz duran ya da
--        uzaklaşan oyuncunun çağrısı `not_approaching` ile reddedilir →
--        "çalınan oyuncu +25 alıyor" hatası ortadan kalkar.
--        Bu kural 0050'den FARKLI olarak BAYAT örneğe değil, çağrı ANINDA
--        gönderilen taze konuma dayanır; bu yüzden güvenilirdir.
--     d) SERİLEŞTİRME: her iki satır `FOR UPDATE ... order by slot` ile
--        kilitlenir; `last_stolen_at` temas koruması (700ms) ikinci çağrıyı
--        reddeder. Gerçek eşzamanlı temas yarışında İLK çağrı kazanır
--        (deterministik).
--
--   AYRICA: sunucu ÇALINANIN sonuç durumunu `victimState` olarak döndürür.
--   Çalan istemci bunu `steal` yayınıyla rakibe iletir; ÇALINAN istemci kendi
--   -25'ini ANINDA ve OTORİTER uygular (bayat yoklamaya bağımlı kalmaz).
--
-- KORUNANLAR:
--   * +25 / -25 puan (tek oyunculu `STEAL_SCORE` = 25).
--   * Görev zinciri / ilerleme / tur sayaçları (0040/0041 davranışı).
--   * `duo_steal` sarmalayıcı imzası DEĞİŞMEZ.
--   * Yeni `victimState` alanı GERİYE UYUMLUDUR (eski istemciler yok sayar).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. `duo_steal_versioned` — deterministik, konum-gönderimli çalma.
--
--    İMZA DEĞİŞİR: `p_x`, `p_y` eklenir (duo_collect_batch ile aynı desen).
--    Eski imza (4 argüman) KORUNUR ve yeni imzaya delege eder; böylece
--    geriye dönük uyumluluk bozulmaz.
-- ---------------------------------------------------------------------------
create or replace function public.duo_steal_versioned(
  p_code text,
  p_token text,
  p_expected_objectives_done int,
  p_expected_round int,
  p_x numeric,
  p_y numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_opp duo_players;
  v_room duo_rooms;
  v_pos jsonb;
  v_new_x numeric;
  v_new_y numeric;
  v_step_ok boolean;
  v_dist_before numeric;
  v_dist_after numeric;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  -- PUAN (0042): +25/-25 (tek oyunculu `STEAL_SCORE` ile birebir).
  v_steal_score int := 25;
  -- TEMAS KORUMASI (0042): aynı oyuncu bu süre içinde tekrar çalamaz.
  v_contact_guard_ms int := 700;
  -- Çalma menzili (lib/config.ts STEAL_RADIUS = PLAYER_HIT_R * 2 = 5.2).
  v_steal_radius numeric := 5.2;
  -- TEMAS PAYI: rakibin sunucu-depolu konumu ~1 sn'lik yoklama gecikmesi
  -- taşıyabilir. Hareketli rakipte konum 60Hz `duo_move` ile tazelenir; asıl
  -- gecikme rakip HAREKETSİZKEN önemsizdir (konum değişmez). Yine de küçük bir
  -- pay, ağ jitter'ını ve yuvarlamayı tolere eder.
  v_contact_slack numeric := 2.0;
  v_new_stolen int;
  v_progress int;
  v_completed_progress int;
  v_satisfied boolean := false;
  v_counts_for_objective boolean;
  v_after duo_players;
  v_victim_after duo_players;
  v_reroll jsonb;
begin
  v_pl := duo_require_player(v_code, p_token);

  -- SERİLEŞTİRME (0039/0042): HER İKİ oyuncu satırını SABİT sırayla kilitle.
  -- Böylece karşılıklı çalma çağrıları sıraya girer ve yalnızca İLKİ geçer.
  perform 1
    from duo_players
    where room_code = v_code
    order by slot
    for update;

  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', false, 'reason', 'not_battle');
  end if;
  if p_expected_round is not null and p_expected_round <> v_room.round then
    return jsonb_build_object('ok', false, 'reason', 'stale_round');
  end if;

  select * into v_opp
    from duo_players
    where room_code = v_code and slot <> v_pl.slot;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_opponent');
  end if;

  -- TEMAS KORUMASI: kilit ALTINDA her iki satırın da çalınma damgası kontrol
  -- edilir. İlk çağrı kurbanı damgalar; ikinci çağrı burada reddedilir.
  if coalesce(v_opp.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_opp.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'victim_guarded');
  end if;
  if coalesce(v_pl.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_pl.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'steal_cooldown');
  end if;

  -- Kurbanın çalınacak coini olmalı.
  if coalesce(v_opp.coins, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_coins');
  end if;

  -- ÇAĞIRANIN KONUMU (duo_collect_batch deseni): istemci kendi GÜNCEL konumunu
  -- gönderir. Anti-teleport doğrulaması yapılır; geçersizse sunucu-depolu
  -- konuma düşülür (istemci koordinatına ASLA güvenilmez).
  v_pos := duo_clamp_pos(p_x, p_y);
  v_new_x := (v_pos->>'x')::numeric;
  v_new_y := (v_pos->>'y')::numeric;
  v_step_ok := duo_step_ok(
    v_pl.x, v_pl.y, v_pl.last_move_at, v_new_x, v_new_y, v_pl.slowed_until, v_now_ms
  );
  if not v_step_ok then
    v_new_x := v_pl.x;
    v_new_y := v_pl.y;
  end if;

  -- TEMAS: doğrulanmış çağıran konumu ile rakibin sunucu-depolu konumu.
  v_dist_after := sqrt(power(v_opp.x - v_new_x, 2) + power(v_opp.y - v_new_y, 2));
  if v_dist_after > v_steal_radius + v_contact_slack then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  -- YAKLAŞMA (deterministik saldırgan kuralı): çağıran, ÖNCEKİ sunucu-depolu
  -- konumuna göre rakibe DAHA YAKIN olmalı. Böylece yalnızca gerçekten rakibe
  -- doğru hareket edip temasa giren oyuncu çalabilir; hareketsiz/uzaklaşan
  -- oyuncunun çağrısı reddedilir.
  v_dist_before := sqrt(power(v_opp.x - v_pl.x, 2) + power(v_opp.y - v_pl.y, 2));
  if v_dist_after >= v_dist_before then
    return jsonb_build_object('ok', false, 'reason', 'not_approaching');
  end if;

  v_counts_for_objective :=
    p_expected_objectives_done is null
    or p_expected_objectives_done = coalesce(v_pl.objectives_done, 0);
  v_new_stolen := coalesce(v_pl.stolen, 0);
  if v_counts_for_objective then
    v_new_stolen := v_new_stolen + 1;
    v_progress := duo_mission_progress(
      v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins
    );
    v_satisfied := duo_mission_satisfied(
      v_pl.objective, v_pl.collected_types, v_new_stolen, v_pl.coins
    );
  else
    v_progress := coalesce(v_pl.objective_progress, 0);
  end if;

  -- ÇALAN: +25 puan, çalma sayacı, görev ilerlemesi. Ayrıca doğrulanmış konumu
  -- yazarız (istemci zaten oraya hareket etti; sunucu konumu yakınsar).
  update duo_players
    set stolen = v_new_stolen,
        round_stolen = coalesce(round_stolen, 0) + 1,
        objective_progress = case when v_counts_for_objective
          then greatest(coalesce(objective_progress, 0), v_progress)
          else objective_progress end,
        mission_done = case when v_counts_for_objective then v_satisfied else mission_done end,
        score = coalesce(score, 0) + v_steal_score,
        round_score = coalesce(round_score, 0) + v_steal_score,
        x = v_new_x,
        y = v_new_y,
        last_move_at = now(),
        last_seen_at = now()
    where room_code = v_code and slot = v_pl.slot;

  -- KURBAN: -25 puan, 1 coin kaybı, kısa yavaşlama, çalınma damgası.
  update duo_players
    set coins = greatest(0, coins - 1),
        round_coins = greatest(0, coalesce(round_coins, 0) - 1),
        score = greatest(0, coalesce(score, 0) - v_steal_score),
        round_score = greatest(0, coalesce(round_score, 0) - v_steal_score),
        slowed_until = v_now_ms + 400,
        last_stolen_at = v_now_ms
    where room_code = v_code and slot = v_opp.slot;

  v_completed_progress := v_progress;
  if v_satisfied then
    v_reroll := duo_reroll_objective_carry(
      v_code, v_pl.slot, v_pl.collected_types, v_new_stolen, v_pl.coins
    );
  end if;

  select * into v_after
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  -- ÇALINANIN SONUÇ DURUMU: istemci bunu `steal` yayınıyla rakibe iletir;
  -- ÇALINAN istemci kendi -25'ini ANINDA ve OTORİTER uygular.
  select * into v_victim_after
    from duo_players
    where room_code = v_code and slot = v_opp.slot;

  return jsonb_build_object(
    'ok', true,
    'stolen', v_new_stolen,
    'score', v_steal_score,
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
    ),
    -- ÇALINANIN durumu: yalnızca puan/coin alanları (görev alanları çalınana
    -- ait DEĞİL; çalınanın görevi çalmadan ETKİLENMEZ).
    'victimState', jsonb_build_object(
      'coins', v_victim_after.coins,
      'roundCoins', coalesce(v_victim_after.round_coins, 0),
      'score', coalesce(v_victim_after.score, 0),
      'roundScore', coalesce(v_victim_after.round_score, 0)
    )
  );
end;
$function$;

grant execute on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Geriye dönük uyumluluk: eski 4-argümanlı imza yeni imzaya delege eder.
--    (Eski istemciler konum göndermez; sunucu-depolu konum kullanılır ve
--    yaklaşma kuralı yine uygulanır.)
-- ---------------------------------------------------------------------------
create or replace function public.duo_steal_versioned(
  p_code text,
  p_token text,
  p_expected_objectives_done int,
  p_expected_round int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
begin
  v_pl := duo_require_player(v_code, p_token);
  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot;
  return duo_steal_versioned(
    v_code, p_token, p_expected_objectives_done, p_expected_round, v_pl.x, v_pl.y
  );
end;
$function$;

grant execute on function public.duo_steal_versioned(text, text, integer, integer)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. `duo_steal` (sarmalayıcı) — imza ve davranış DEĞİŞMEZ (0042 ile aynı).
-- ---------------------------------------------------------------------------
create or replace function public.duo_steal(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
begin
  v_pl := duo_require_player(v_code, p_token);
  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  return duo_steal_versioned(v_code, p_token, v_pl.objectives_done, null, v_pl.x, v_pl.y);
end;
$function$;

grant execute on function public.duo_steal(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
