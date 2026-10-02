-- ============================================================================
-- 0042_steal_authority_and_contact_guard.sql
--
-- SORUNLAR (kullanıcı raporu — "steal mekaniği"):
--   1. PUAN YANLIŞ: Çalma başına +20/-20 uygulanıyordu. Beklenen +25/-25.
--   2. KARŞILIKLI ÇALMA (asıl hata): İki istemci de temas anını BAĞIMSIZ
--      algılar ve İKİSİ de `duo_steal_versioned` çağırır. Sunucu satırları
--      kilitler ve SERİLEŞTİRİR; bu yüzden İKİ çağrı da BAŞARILI olur →
--      iki oyuncu AYNI temasta birbirinden çalar (A +20 & B -20, sonra
--      B +20 & A -20) → net ~0 ve "asla iki taraf da çalamaz / tek temasta
--      en fazla bir çalma" kuralı İHLAL edilir. Sunucu tarafında temas
--      başına bir koruma YOKTU; yalnızca istemci başına 700ms cooldown vardı
--      ve bu, KARŞI istemcinin çalmasını engelleyemez.
--   3. BOŞ KURBAN: Kurbanın hiç coin'i olmasa bile çalma başarılı oluyor ve
--      kurbanın skoru düşürülüyordu. Kurbanın gerçekten çalınacak bir coin'i
--      olmalı.
--
-- ÇÖZÜM (SUNUCU OTORİTESİ — minimum değişiklik):
--   1. `v_steal_score := 25` (tek oyunculu `STEAL_SCORE` ile eşitlenir).
--   2. TEMAS KORUMASI: `duo_players.last_stolen_at` (epoch ms) kolonu eklenir.
--      Çalma başarılı olduğunda KURBANIN satırına çalınma anı yazılır. Yeni bir
--      çalma isteği, KURBANIN son çalınmasından `STEAL_CONTACT_GUARD_MS` (700ms)
--      içindeyse REDDEDİLİR. Böylece:
--        * Tek temas → en fazla BİR başarılı çalma (aynı kurban korunur).
--        * Karşılıklı temas → ilk çağrı kazanır ve KURBANI damgalar; ikinci
--          çağrının kurbanı (ilk çalan) HENÜZ çalınmadığı için... DİKKAT:
--          bu yüzden ikinci çağrı da başarılı olabilir. Bunu engellemek için
--          kilit altında HER İKİ satırın da `last_stolen_at`'i kontrol edilir:
--          çağıran (çalan) son 700ms içinde ÇALINDIYSA da reddedilir. Yani
--          "aynı temasta hem çalan hem çalınan olma" yasaktır.
--      NOT: Kilit SIRASI korunur (slot sırası) → deadlock yok.
--   3. KURBAN COIN KONTROLÜ: Kurbanın `coins <= 0` ise `no_coins` ile reddet.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0041'den SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Şema: temas koruması için `last_stolen_at` kolonu (epoch ms).
--    KURBANIN satırına, çalındığı an yazılır.
-- ---------------------------------------------------------------------------
alter table duo_players
  add column if not exists last_stolen_at bigint not null default 0;

-- ---------------------------------------------------------------------------
-- 1. duo_steal_versioned — +25/-25, temas koruması, kurban coin kontrolü.
--    Gövde 0041 ile aynıdır; yalnızca yukarıdaki üç değişiklik eklenmiştir.
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
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_opp duo_players;
  v_room duo_rooms;
  v_dist numeric;
  -- PUAN (0042): +25/-25 (tek oyunculu `STEAL_SCORE` ile birebir).
  v_steal_score int := 25;
  -- TEMAS KORUMASI (0042): aynı oyuncu bu süre içinde tekrar çalamaz.
  v_contact_guard_ms int := 700;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_new_stolen int;
  v_progress int;
  v_completed_progress int;
  v_satisfied boolean := false;
  v_counts_for_objective boolean;
  v_after duo_players;
  v_reroll jsonb;
begin
  v_pl := duo_require_player(v_code, p_token);

  -- Lock both player rows in a stable order so opposite-direction steals do
  -- not acquire the same rows in reverse order.
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

  -- TEMAS KORUMASI (0042): TEK temasta EN FAZLA BİR çalma.
  --   * KURBAN son 700ms içinde çalındıysa reddet → aynı temasta mükerrer
  --     çalma (farming) engellenir.
  --   * ÇAĞIRAN (çalan) son 700ms içinde ÇALINDIYSA da reddet → karşılıklı
  --     temasta "hem çalan hem çalınan olma" (iki taraf da çalma) engellenir.
  -- Her iki satır da yukarıda `for update` ile kilitli olduğu için bu kontrol
  -- atomiktir; eşzamanlı iki çağrı SERİLEŞİR ve yalnızca ilki geçer.
  if coalesce(v_opp.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_opp.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'victim_guarded');
  end if;
  if coalesce(v_pl.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_pl.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'steal_cooldown');
  end if;

  -- KURBAN COIN KONTROLÜ (0042): çalınacak bir coin yoksa reddet.
  if coalesce(v_opp.coins, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_coins');
  end if;

  v_dist := sqrt(power(v_opp.x - v_pl.x, 2) + power(v_opp.y - v_pl.y, 2));
  if v_dist > 10 then
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

  update duo_players
    set coins = greatest(0, coins - 1),
        round_coins = greatest(0, coalesce(round_coins, 0) - 1),
        score = greatest(0, coalesce(score, 0) - v_steal_score),
        round_score = greatest(0, coalesce(round_score, 0) - v_steal_score),
        slowed_until = v_now_ms + 400,
        -- TEMAS KORUMASI: KURBANIN çalınma anını damgala.
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
$$;

grant execute on function duo_steal_versioned(text, text, int, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_steal (sarmalayıcı) — AYNEN korunur (0041 ile aynı).
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
begin
  v_pl := duo_require_player(v_code, p_token);
  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot;

  return duo_steal_versioned(v_code, p_token, v_pl.objectives_done, null);
end;
$$;

grant execute on function duo_steal(text, text) to anon, authenticated;
