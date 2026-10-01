-- ============================================================================
-- 0037_cap_objective_progress.sql
--
-- SORUN (kullanıcı şikâyeti — görev sayacı temelden yanlış):
--   "Collect 2 Red + 1 Emerald · 0/3" görevinde 2 Red toplayınca ilerleme
--   TAM 2/3 olmalı. Ancak `coinType`-only görevlerde (ör. "Collect 3 Gold",
--   "Collect 4 Blue") ilerleme HEDEFİ AŞABİLİYORDU: 5 Gold toplayınca
--   "5/3", 6 Blue toplayınca "6/4" gösteriyordu. Ayrıca kalıcı kolon
--   `objective_progress` `greatest()` ile yazıldığı için bu AŞIRI değer
--   KALICI olarak kilitleniyor ve asla düzelmiyordu.
--
-- KÖK NEDEN:
--   `duo_mission_progress` (0029) ve `duo_mission_satisfied` (0002) yalnızca
--   `requirements` dalında `least(collected, required)` ile sınırlıyordu.
--   `coinType` (mixed değil) dalı `collected[coinType]` değerini SINIRLAMADAN
--   döndürüyordu; `else` dalı da ham `coins`/`stolen` döndürüyordu. Bu yüzden
--   hedef aşılabiliyordu.
--
-- ÇÖZÜM (TEK OTORİTE — SUNUCU):
--   Her iki fonksiyon da döndürdüğü `progress` değerini görevin `target`'ı ile
--   SINIRLAR (`least(progress, target)`). Böylece:
--     * "Collect 3 Gold" + 5 Gold → 3/3 (5/3 DEĞİL)
--     * "Collect 4 Blue" + 6 Blue → 4/4 (6/4 DEĞİL)
--     * "Collect 2 Red + 1 Emerald" + 2 Red → 2/3 (zaten doğruydu)
--   `duo_mission_satisfied`'ın boolean sonucu DEĞİŞMEZ (yalnızca iç `progress`
--   sınırlanır; `resources_met`/`steals_met` ayrı koşullardır).
--
--   İstemci (`lib/display.ts` `progressOf`, `lib/useDuoChaos.ts` iyimser
--   türetim) AYNI sınırlamayı uygular; böylece sunucu ve istemci birebir
--   uyuşur ve hiçbir dal hedefi aşamaz.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0036'dan SONRA çalışır.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_mission_progress — ilerlemeyi HEDEF ile sınırla.
--    Gövde 0029 ile aynıdır; yalnızca dönüş `least(progress, target)` olur.
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
  elsif (p_objective->>'coinType') is not null and (p_objective->>'coinType') <> 'mixed' then
    progress := coalesce((p_collected->>(p_objective->>'coinType'))::int, 0);
  else
    progress := case when (p_objective->>'kind') = 'steal' then p_stolen else p_coins end;
  end if;

  -- HEDEF SINIRI (0037): ilerleme hedefi ASLA aşamaz.
  if target > 0 then
    progress := least(progress, target);
  end if;

  return coalesce(progress, 0);
end;
$$;

grant execute on function duo_mission_progress(jsonb, jsonb, int, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. duo_mission_satisfied — iç `progress`'i HEDEF ile sınırla.
--    Boolean sonuç değişmez; yalnızca `progress >= target` karşılaştırması
--    sınırlı değerle yapılır (matematiksel olarak aynı sonuç).
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
  elsif (p_objective->>'coinType') is not null and (p_objective->>'coinType') <> 'mixed' then
    progress := coalesce((p_collected->>(p_objective->>'coinType'))::int, 0);
  else
    progress := case when (p_objective->>'kind') = 'steal' then p_stolen else p_coins end;
  end if;

  if (p_objective->>'kind') = 'steal' then
    steals_met := p_stolen >= coalesce((p_objective->>'stealTarget')::int, target);
  end if;

  -- HEDEF SINIRI (0037): karşılaştırma sınırlı değerle yapılır.
  if target > 0 then
    progress := least(progress, target);
  end if;

  return resources_met and steals_met and progress >= target;
end;
$$;

grant execute on function duo_mission_satisfied(jsonb, jsonb, int, int) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Mevcut AŞIRI `objective_progress` değerlerini hedefe indir (onarım).
--    Geçmişte kilitlenmiş "5/3" gibi değerler bir sonraki okumada düzelir.
-- ---------------------------------------------------------------------------
update duo_players
  set objective_progress = least(
    coalesce(objective_progress, 0),
    coalesce((objective->>'target')::int, coalesce(objective_progress, 0))
  )
  where objective is not null
    and objective_progress is not null
    and (objective->>'target') is not null
    and objective_progress > (objective->>'target')::int;
