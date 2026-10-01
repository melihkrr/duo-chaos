-- ============================================================================
-- DUO CHAOS — 0002 helpers
-- Pure SQL helpers shared by the RPC layer: objective pool, deterministic
-- seeding, coin spawning, scoring and progression math.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Deterministic 32-bit FNV-1a hash, mirroring lib/config.ts generateObjectivePair
-- ---------------------------------------------------------------------------
create or replace function duo_fnv1a(value text)
returns bigint
language plpgsql
immutable
as $$
declare
  result bigint := 2166136261;
  i int;
  c int;
begin
  if value is null then return 0; end if;
  for i in 1..char_length(value) loop
    c := ascii(substr(value, i, 1));
    result := result # c;
    result := (result * 16777619) % 4294967296;
  end loop;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Objective pool — must stay in sync with OBJECTIVE_POOL in lib/config.ts
-- ---------------------------------------------------------------------------
create or replace function duo_objective_pool()
returns jsonb
language sql
immutable
as $$
  -- `points` = görev tamamlanınca kazanılan PUAN ödülü. lib/config.ts
  -- OBJECTIVE_POOL ile BİREBİR aynı olmalıdır (puan dengesi).
  select '[
    {"id":"gold-rush","kind":"collect","label":"Collect 3 Gold","shortLabel":"3 Gold","target":3,"coinType":"gold","points":45},
    {"id":"blue-raid","kind":"collect","label":"Collect 2 Blue + 2 Red","shortLabel":"2 Blue + 2 Red","target":4,"coinType":"mixed","requirements":{"blue":2,"red":2},"points":60},
    {"id":"emerald-hunt","kind":"collect","label":"Collect 3 Emerald","shortLabel":"3 Emerald","target":3,"coinType":"emerald","points":55},
    {"id":"resource-control","kind":"steal","label":"Steal 3 from your rival","shortLabel":"3 stolen","target":3,"coinType":"mixed","points":60},
    {"id":"jackpot-run","kind":"collect","label":"Collect 1 Gold + 2 Blue","shortLabel":"1 Gold + 2 Blue","target":3,"coinType":"mixed","requirements":{"gold":1,"blue":2},"points":50},
    {"id":"red-burn","kind":"collect","label":"Collect 2 Red + 1 Emerald","shortLabel":"2 Red + 1 Emerald","target":3,"coinType":"mixed","requirements":{"red":2,"emerald":1},"points":55},
    {"id":"blue-pressure","kind":"collect","label":"Collect 4 Blue","shortLabel":"4 Blue","target":4,"coinType":"blue","points":50},
    {"id":"gold-robbery","kind":"steal","label":"Steal 2 and secure 1 Gold","shortLabel":"2 stolen + 1 Gold","target":3,"coinType":"mixed","requirements":{"gold":1},"stealTarget":2,"points":70}
  ]'::jsonb;
$$;

-- ---------------------------------------------------------------------------
-- Deterministically pick a distinct objective pair for a round seed.
-- Returns {"p1": {...}, "p2": {...}}
-- ---------------------------------------------------------------------------
create or replace function duo_objective_pair(seed text)
returns jsonb
language plpgsql
immutable
as $$
declare
  pool jsonb := duo_objective_pool();
  ordered jsonb;
  first_obj jsonb;
  second_obj jsonb;
begin
  -- Order the pool by hash(seed:id) so both clients agree without randomness.
  select jsonb_agg(elem order by duo_fnv1a(seed || ':' || (elem->>'id')))
    into ordered
    from jsonb_array_elements(pool) as elem;

  first_obj := ordered->0;
  select elem into second_obj
    from jsonb_array_elements(ordered) as elem
    where elem->>'id' <> (first_obj->>'id')
    limit 1;

  if second_obj is null then second_obj := first_obj; end if;

  return jsonb_build_object('p1', first_obj, 'p2', second_obj);
end;
$$;

-- ---------------------------------------------------------------------------
-- Coin value — mirrors getCoinValue() in lib/config.ts
-- ---------------------------------------------------------------------------
create or replace function duo_coin_value(
  p_type duo_coin_type,
  p_chaos duo_chaos_event,
  p_objective jsonb
)
returns int
language plpgsql
immutable
as $$
declare
  is_target boolean := false;
  base int;
begin
  if p_type = 'diamond' then return 50; end if;

  if p_objective is not null then
    if (p_objective->'requirements') ? p_type::text then
      is_target := true;
    elsif (p_objective->>'coinType') = p_type::text then
      is_target := true;
    end if;
  end if;

  base := case
    when p_type = 'emerald' then 25
    when is_target then 15
    else 5
  end;

  if p_chaos = 'gold-rush' and p_type = 'gold' then
    return base + 25;
  end if;
  return base;
end;
$$;

-- ---------------------------------------------------------------------------
-- Base coin layout — mirrors spawnCoins() (14 coins, deterministic)
-- ---------------------------------------------------------------------------
create or replace function duo_spawn_coins(p_room text)
returns void
language plpgsql
as $$
declare
  types duo_coin_type[] := array['gold','blue','red','emerald']::duo_coin_type[];
  i int;
begin
  delete from duo_coins where room_code = p_room;
  for i in 0..13 loop
    insert into duo_coins (room_code, coin_id, x, y, type)
    values (
      p_room,
      i,
      8 + ((i * 31) % 84),
      12 + ((i * 47) % 76),
      types[(i % 4) + 1]
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resource wave — mirrors spawnResourceWave(round, wave)
-- ---------------------------------------------------------------------------
create or replace function duo_spawn_wave(p_room text, p_round int, p_wave int)
returns void
language plpgsql
as $$
declare
  types duo_coin_type[] := array['gold','blue','red','emerald']::duo_coin_type[];
  anchor int := (p_round * 17 + p_wave * 23) % 76;
  i int;
begin
  for i in 0..1 loop
    insert into duo_coins (room_code, coin_id, x, y, type)
    values (
      p_room,
      1000 + p_round * 100 + p_wave * 10 + i,
      12 + ((anchor + i * 37) % 76),
      16 + ((anchor * 2 + i * 29) % 68),
      types[((p_round + p_wave + i) % 4) + 1]
    )
    on conflict (room_code, coin_id) do nothing;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Progression math — mirrors profileForXp() in app/page.tsx
-- ---------------------------------------------------------------------------
create or replace function duo_profile_for_xp(p_xp int)
returns jsonb
language plpgsql
immutable
as $$
declare
  lvl int := greatest(1, floor(p_xp / 250.0)::int + 1);
  ttl text;
  unlocks jsonb;
begin
  ttl := case
    when p_xp >= 1500 then 'Chaos Master'
    when p_xp >= 1000 then 'Risk Taker'
    when p_xp >= 650  then 'Coin Thief'
    when p_xp >= 300  then 'Chaos Rookie'
    else 'Rookie'
  end;

  unlocks := jsonb_build_array('Rookie badge');
  if p_xp >= 300  then unlocks := unlocks || '["Chaos Rookie title","Confetti emote"]'::jsonb; end if;
  if p_xp >= 650  then unlocks := unlocks || '["Coin Thief title","Neon trail"]'::jsonb; end if;
  if p_xp >= 1000 then unlocks := unlocks || '["Risk Taker title","Victory burst"]'::jsonb; end if;
  if p_xp >= 1500 then unlocks := unlocks || '["Chaos Master title"]'::jsonb; end if;

  return jsonb_build_object('xp', p_xp, 'level', lvl, 'title', ttl, 'unlocks', unlocks);
end;
$$;

-- ---------------------------------------------------------------------------
-- Resolve the calling player from a room code + token. Raises on failure.
-- ---------------------------------------------------------------------------
create or replace function duo_require_player(p_code text, p_token text)
returns duo_players
language plpgsql
security definer
set search_path = public
as $$
declare
  pl duo_players;
begin
  select * into pl
    from duo_players
    where room_code = upper(p_code) and token = p_token;

  if not found then
    raise exception 'not_a_player' using errcode = 'P0001';
  end if;
  return pl;
end;
$$;

-- ---------------------------------------------------------------------------
-- Mission completion check — mirrors objectiveSatisfied() in lib/display.ts
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

  return resources_met and steals_met and progress >= target;
end;
$$;
