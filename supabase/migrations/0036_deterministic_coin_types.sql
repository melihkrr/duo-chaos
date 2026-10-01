-- ============================================================================
-- DUO CHAOS — 0036 deterministic coin types (objectives always completable)
--
-- ROOT CAUSE
-- ----------
-- `duo_spawn_coins` (and the client `spawnCoins()`) assigned each coin a
-- RANDOM type:
--
--     v_type := v_types[floor(v_r * 4)::int + 1];
--
-- The type distribution therefore varied per round seed. A round could spawn
-- only 1 emerald or only 3 blues, while the objective pool contains
-- "Collect 3 Emerald" (target 3) and "Collect 4 Blue" (target 4). When the
-- map did not contain enough coins of the required type the objective was
-- LITERALLY IMPOSSIBLE to complete — the player could never reach the target,
-- which is exactly the "3 tane topla diyor, 3 tane topluyorum" complaint.
--
-- FIX
-- ---
-- Assign types ROUND-ROBIN over the shuffled cells instead of randomly:
--
--     v_type := v_types[(v_i % 4) + 1];
--
-- With 14 coins and 4 types this guarantees a distribution of 4/4/3/3 — every
-- type appears at least 3 times. The largest single-type requirement in the
-- pool is 4 (blue) and the largest mixed requirement is 2+2, so EVERY
-- objective is now always completable. Positions remain deterministic and
-- identical to the client (lib/config.ts spawnCoins), which is updated in the
-- same change so client and server stay byte-for-byte in sync.
-- ============================================================================

create or replace function duo_spawn_coins(p_room text)
returns void
language plpgsql
as $$
declare
  v_seed text;
  v_state bigint;
  v_cells int[] := array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14];
  v_i int;
  v_j int;
  v_tmp int;
  v_r double precision;
  v_cell int;
  v_col int;
  v_row int;
  v_x double precision;
  v_y double precision;
  v_type duo_coin_type;
  v_types duo_coin_type[] := array['gold','blue','red','emerald']::duo_coin_type[];
  v_len int;
begin
  -- The client seeds with `round-${round}` for the very first round and with
  -- `CODE:round` for every round started by `duo_start_round`. We prefer the
  -- room's stored `round_seed` (authoritative) and fall back to `round-N`.
  select coalesce(nullif(round_seed, ''), 'round-' || round::text)
    into v_seed
    from duo_rooms
    where code = p_room;

  if v_seed is null then
    v_seed := 'round-1';
  end if;

  -- FNV-1a 32-bit hash of the seed (matches the JS implementation).
  v_state := 2166136261;
  v_len := length(v_seed);
  for v_i in 1..v_len loop
    v_state := (v_state # (ascii(substr(v_seed, v_i, 1)))) & 4294967295;
    v_state := (v_state * 16777619) & 4294967295;
  end loop;
  if v_state = 0 then
    v_state := 1;
  end if;

  -- Fisher–Yates shuffle of the 15 grid cells (deterministic).
  for v_i in reverse 14..1 loop
    -- next(): xorshift32
    v_state := (v_state # ((v_state << 13) & 4294967295)) & 4294967295;
    v_state := (v_state # (v_state >> 17)) & 4294967295;
    v_state := (v_state # ((v_state << 5) & 4294967295)) & 4294967295;
    v_r := (v_state & 4294967295)::double precision / 4294967296.0;
    v_j := floor(v_r * (v_i + 1))::int;
    v_tmp := v_cells[v_i + 1];
    v_cells[v_i + 1] := v_cells[v_j + 1];
    v_cells[v_j + 1] := v_tmp;
  end loop;

  delete from duo_coins where room_code = p_room;

  for v_i in 0..13 loop
    v_cell := v_cells[(v_i % 15) + 1];
    v_col := v_cell % 5;
    v_row := v_cell / 5;

    -- x = 12 + col*19 + (next()*6 - 3)
    v_state := (v_state # ((v_state << 13) & 4294967295)) & 4294967295;
    v_state := (v_state # (v_state >> 17)) & 4294967295;
    v_state := (v_state # ((v_state << 5) & 4294967295)) & 4294967295;
    v_r := (v_state & 4294967295)::double precision / 4294967296.0;
    v_x := 12 + v_col * 19 + (v_r * 6 - 3);

    -- y = 16 + row*30 + (next()*8 - 4)
    v_state := (v_state # ((v_state << 13) & 4294967295)) & 4294967295;
    v_state := (v_state # (v_state >> 17)) & 4294967295;
    v_state := (v_state # ((v_state << 5) & 4294967295)) & 4294967295;
    v_r := (v_state & 4294967295)::double precision / 4294967296.0;
    v_y := 16 + v_row * 30 + (v_r * 8 - 4);

    -- type = COIN_TYPES[i % 4]  (round-robin, NOT random) — guarantees every
    -- type appears at least 3 times so no objective is ever impossible.
    v_type := v_types[(v_i % 4) + 1];

    insert into duo_coins (room_code, coin_id, x, y, type)
    values (p_room, v_i, round(v_x::numeric, 4), round(v_y::numeric, 4), v_type);
  end loop;
end;
$$;
