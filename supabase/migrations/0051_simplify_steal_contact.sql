-- ============================================================================
-- 0051_simplify_steal_contact.sql
--
-- SORUN (kullanıcı raporu — "steal akışı çalışmıyor"):
--   Çalma neredeyse hiç gerçekleşmiyordu. Oyuncu rakibine yaklaşıp TEMAS
--   ettiğinde (doğal çalma yolu) sunucu `not_chasing` ile reddediyordu.
--
-- KÖK NEDEN:
--   0049/0050, "kim kovalıyor?" sorusunu YÖN/HIZ analiziyle çözmeye çalıştı:
--     * `previous_position_at` / `position_updated_at` damgalarının 300ms'den
--       taze olması,
--     * oyuncunun yaklaşma hızının rakibinkinden en az 0.5 birim/sn FAZLA
--       olması.
--   Bu damgalar YALNIZCA `x`/`y` DEĞİŞTİĞİNDE (tetikleyici) yazılır. Oyuncu
--   rakibin üstüne gelip DURDUĞUNDA (çalmanın doğal anı) konum değişmez →
--   damga 300ms içinde bayatlar → sunucu `not_chasing` döner. Ayrıca istemci
--   `duo_move` heartbeat'i 1000ms'de birdir; 300ms'lik tazelik penceresi
--   heartbeat'ten KISA olduğu için hareket hâlinde bile örnek çoğu zaman
--   bayat kalır. Sonuç: çalma pratikte hiç tetiklenmez.
--
--   Önceki oturum bu sorunu "lookback" yamalarıyla (0051–0058) çözmeye
--   çalıştı; yapı giderek karmaşıklaştı ve bir REGRESYONA yol açtı, ardından
--   geri alındı (commit bb40144). Bu yüzden temiz 0050 tabanına dönüldü.
--
-- ÇÖZÜM (PROFESYONEL — basit ve sağlam):
--   Yön/hız analizini TAMAMEN KALDIR. Çalma, SUNUCU-DEPOLU konumlara dayanan
--   bir TEMAS kontrolüdür:
--     1. İki oyuncu da `STEAL_RADIUS` (5.2) içinde olmalı (sunucu konumları).
--     2. Kurbanın en az 1 coini olmalı.
--     3. TEMAS KORUMASI (0042): son 700ms içinde çalınan kurban / çalan oyuncu
--        tekrar çalamaz.
--   Bu üç kural, "karşılıklı çalma yarışı"nı zaten çözer:
--     * Satırlar `FOR UPDATE` ile KİLİTLENİR → eşzamanlı iki çağrı SERİLEŞİR.
--     * İlk çağrı kurbanın `last_stolen_at`'ini damgalar → ikinci çağrı
--       `victim_guarded` ile reddedilir.
--   Yani yön analizi GEREKSİZDİ ve yalnızca zarar veriyordu.
--
-- KORUNANLAR:
--   * +25 / -25 puan (0042 ile birebir; tek oyunculu `STEAL_SCORE` = 25).
--   * Görev zinciri / ilerleme / tur sayaçları (0040/0041 davranışı).
--   * Sunucu otoritesi: mesafe SUNUCU-DEPOLU `x`/`y`'den ölçülür; istemci
--     koordinatı ASLA güvenilmez.
--   * `duo_steal` sarmalayıcı imzası DEĞİŞMEZ.
-- ============================================================================

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
  v_opp duo_players;
  v_room duo_rooms;
  v_dist numeric;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  -- PUAN (0042): +25/-25 (tek oyunculu `STEAL_SCORE` ile birebir).
  v_steal_score int := 25;
  -- TEMAS KORUMASI (0042): aynı oyuncu bu süre içinde tekrar çalamaz.
  v_contact_guard_ms int := 700;
  -- Çalma menzili (lib/config.ts STEAL_RADIUS = PLAYER_HIT_R * 2 = 5.2).
  v_steal_radius numeric := 5.2;
  v_new_stolen int;
  v_progress int;
  v_completed_progress int;
  v_satisfied boolean := false;
  v_counts_for_objective boolean;
  v_after duo_players;
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

  -- TEMAS: mesafe SUNUCU-DEPOLU konumlardan ölçülür (istemci koordinatına
  -- güvenilmez). Yön/hız analizi YOK — yalnızca menzil.
  v_dist := sqrt(power(v_opp.x - v_pl.x, 2) + power(v_opp.y - v_pl.y, 2));
  if v_dist > v_steal_radius then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
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

  -- ÇALAN: +25 puan, çalma sayacı, görev ilerlemesi.
  update duo_players
    set stolen = v_new_stolen,
        round_stolen = coalesce(round_stolen, 0) + 1,
        objective_progress = case when v_counts_for_objective
          then greatest(coalesce(objective_progress, 0), v_progress)
          else objective_progress end,
        mission_done = case when v_counts_for_objective then v_satisfied else mission_done end,
        score = coalesce(score, 0) + v_steal_score,
        round_score = coalesce(round_score, 0) + v_steal_score
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
    )
  );
end;
$function$;

grant execute on function public.duo_steal_versioned(text, text, integer, integer)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- duo_steal (sarmalayıcı) — imza ve davranış DEĞİŞMEZ (0042 ile aynı).
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

  return duo_steal_versioned(v_code, p_token, v_pl.objectives_done, null);
end;
$function$;

grant execute on function public.duo_steal(text, text) to anon, authenticated;
