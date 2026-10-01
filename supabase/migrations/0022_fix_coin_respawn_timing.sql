-- ============================================================================
-- 0022_fix_coin_respawn_timing.sql
--
-- SORUN (istemci/sunucu uyumsuzluğu — "coin görünüyor ama toplanmıyor"):
--
--   İstemci toplanan bir coini `COIN_RESPAWN_MS = 3000` ms sonra AYNI konumda
--   yeniden doğurur (lib/config.ts) ve rakibe de `respawnAt: now + 3000`
--   yayınlar (lib/useGameLoop.ts → broadcast('collect')).
--
--   Ancak sunucudaki `duo_collect` (0021_points_scoring.sql) `respawn_at`'i
--   `v_now + 4000` olarak ayarlıyordu. Yani:
--
--     * t=0    : oyuncu coini toplar. İstemci coini t=3000'de geri getirir.
--     * t=3000 : istemci coini "toplanabilir" gösterir; oyuncu üstüne gider.
--     * t=3000 : sunucu hâlâ `collected_by is not null` olduğu için
--                `duo_collect` → `already_collected` döner.
--     * t=4000 : sunucu coini geri getirir.
--
--   Sonuç: 1 saniyelik pencerede coin EKRANDA GÖRÜNÜR ama TOPLANAMAZ; istemci
--   skoru artar gibi olur ama sunucu reddeder → iki istemci arasında skor
--   uyumsuzluğu ve "coin titriyor / geri geliyor" hissi.
--
-- ÇÖZÜM:
--   Sunucudaki respawn gecikmesini istemcinin `COIN_RESPAWN_MS` değeriyle
--   (3000 ms) BİREBİR hizala. Böylece istemci ile sunucu aynı anda canlandırır
--   ve toplama penceresi tutarlı olur.
--
--   NOT: `duo_respawn_coins` (0016) yalnızca `respawn_at <= now` olanları
--   canlandırır; gecikme değerini kendisi belirlemez. Bu yüzden tek yer
--   `duo_collect`'tir. 0021'deki tanımı (puan tabanlı skor + görev zinciri)
--   KORUYARAK yalnızca `respawn_at` değerini düzeltiriz.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0021'den SONRA çalışır, bu
-- yüzden nihai `duo_collect` tanımı buradadır.
-- ============================================================================

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

  -- Mark collected AND schedule a respawn (same spot, same colour — 0013/0020).
  -- DÜZELTME (0022): gecikme istemcinin `COIN_RESPAWN_MS` değeriyle (3000 ms)
  -- BİREBİR aynı olmalı. Önceden 4000 ms idi → 1 sn'lik "görünür ama
  -- toplanamaz" penceresi ve skor uyumsuzluğu yaratıyordu.
  update duo_coins
    set collected_by = v_pl.player_id,
        collected_at = v_now,
        respawn_at = v_now + 3000
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

-- PostgREST şema önbelleğini tazele.
notify pgrst, 'reload schema';
