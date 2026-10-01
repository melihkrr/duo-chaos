-- ============================================================================
-- 0038_steal_requirements_progress.sql
--
-- SORUN (kullanıcı şikâyeti):
--   Görev: "Steal 2 and secure 1 Gold" (gold-robbery).
--   `requirements = {"gold":1}`, `stealTarget = 2`, `target = 3`.
--   Çalma efekti devreye giriyor AMA ilerleme ARTMIYOR (1/3'te takılı kalıyor).
--
-- KÖK NEDEN:
--   `duo_mission_progress` (0029) ve `duo_mission_satisfied` (0002) içindeki
--   `requirements` dalı YALNIZCA toplanan coinleri topluyordu:
--       progress = Σ min(collected[key], required)
--   Çalma (stolen) bu dala HİÇ eklenmiyordu. Oysa `gold-robbery` görevi HEM
--   kaynak (1 Gold) HEM çalma (2 steal) gerektiriyor. Sonuç: 2 kez çalmak
--   ilerlemeyi 0 artırıyordu → görev asla tamamlanamıyordu.
--
-- ÇÖZÜM:
--   `requirements` dalına, görevde `stealTarget` varsa çalmayı da EKLE:
--       progress = Σ min(collected[key], required) + min(stolen, stealTarget)
--   Bu, hedefe (target) sınırlanır (0037). Örnek ("Steal 2 + 1 Gold"):
--       1 steal            → 1/3
--       2 steal            → 2/3
--       2 steal + 1 Gold   → 3/3  (tamamlandı)
--   `steals_met` koşulu (stolen >= stealTarget) AYNEN korunur; yani görev
--   yalnızca HEM kaynak HEM çalma sağlandığında tamamlanır.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0037'den SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_mission_progress — requirements + stealTarget birlikte desteklenir.
-- ---------------------------------------------------------------------------
create or replace function duo_mission_progress(
  p_objective jsonb,
  p_collected jsonb,
  p_stolen int,
  p_coins int
)
returns int
language plpgsql
immutable
as $$
declare
  reqs jsonb;
  req_key text;
  req_val int;
  progress int := 0;
  target int;
  steal_target int;
begin
  if p_objective is null then return 0; end if;
  target := coalesce((p_objective->>'target')::int, 0);
  reqs := p_objective->'requirements';

  if reqs is not null and jsonb_typeof(reqs) = 'object' then
    for req_key, req_val in
      select key, (value)::text::int from jsonb_each(reqs)
    loop
      progress := progress + least(coalesce((p_collected->>req_key)::int, 0), req_val);
    end loop;
    -- ÇALMA BİLEŞENİ (0038): "Steal 2 and secure 1 Gold" gibi HEM kaynak HEM
    -- çalma gerektiren görevlerde çalma da ilerlemeye eklenir.
    steal_target := coalesce((p_objective->>'stealTarget')::int, 0);
    if steal_target > 0 then
      progress := progress + least(coalesce(p_stolen, 0), steal_target);
    end if;
  elsif (p_objective->>'coinType') is not null and (p_objective->>'coinType') <> 'mixed' then
    progress := coalesce((p_collected->>(p_objective->>'coinType'))::int, 0);
  else
    progress := case when (p_objective->>'kind') = 'steal' then p_stolen else p_coins end;
  end if;

  -- HEDEF SINIRI (0037): ilerleme hedefi ASLA aşamaz.
  if target > 0 then progress := least(progress, target); end if;
  return coalesce(progress, 0);
end;
$$;

grant execute on function duo_mission_progress(jsonb, jsonb, int, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_mission_satisfied — aynı mantık (requirements + stealTarget).
-- ---------------------------------------------------------------------------
create or replace function duo_mission_satisfied(
  p_objective jsonb,
  p_collected jsonb,
  p_stolen int,
  p_coins int
)
returns boolean
language plpgsql
immutable
as $$
declare
  reqs jsonb;
  req_key text;
  req_val int;
  resources_met boolean := true;
  steals_met boolean := true;
  progress int := 0;
  target int;
  steal_target int;
begin
  if p_objective is null then return false; end if;
  target := coalesce((p_objective->>'target')::int, 0);
  reqs := p_objective->'requirements';

  if reqs is not null and jsonb_typeof(reqs) = 'object' then
    for req_key, req_val in
      select key, (value)::text::int from jsonb_each(reqs)
    loop
      if coalesce((p_collected->>req_key)::int, 0) < req_val then
        resources_met := false;
      end if;
      progress := progress + least(coalesce((p_collected->>req_key)::int, 0), req_val);
    end loop;
    -- ÇALMA BİLEŞENİ (0038): kaynak + çalma görevlerinde çalma da sayılır.
    steal_target := coalesce((p_objective->>'stealTarget')::int, 0);
    if steal_target > 0 then
      progress := progress + least(coalesce(p_stolen, 0), steal_target);
    end if;
  elsif (p_objective->>'coinType') is not null and (p_objective->>'coinType') <> 'mixed' then
    progress := coalesce((p_collected->>(p_objective->>'coinType'))::int, 0);
  else
    progress := case when (p_objective->>'kind') = 'steal' then p_stolen else p_coins end;
  end if;

  -- HEDEF SINIRI (0037): ilerleme hedefi ASLA aşamaz.
  if target > 0 then progress := least(progress, target); end if;

  if (p_objective->>'kind') = 'steal' then
    steals_met := p_stolen >= coalesce((p_objective->>'stealTarget')::int, target);
  end if;

  return resources_met and steals_met and progress >= target;
end;
$$;

grant execute on function duo_mission_satisfied(jsonb, jsonb, int, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. ONARIM: mevcut oyuncuların `objective_progress` değerini yeni mantıkla
--    yeniden hesapla (çalma bileşeni eksik kalmış olabilir). Monotonik
--    `greatest` ile yazıldığı için yalnızca ARTIRIR, asla düşürmez.
-- ---------------------------------------------------------------------------
update duo_players p
  set objective_progress = greatest(
    coalesce(p.objective_progress, 0),
    duo_mission_progress(p.objective, p.collected_types, p.stolen, p.coins)
  )
  where p.objective is not null
    and (p.objective->>'stealTarget') is not null
    and coalesce(p.objective_progress, 0) < duo_mission_progress(p.objective, p.collected_types, p.stolen, p.coins);
