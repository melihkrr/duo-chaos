-- ============================================================================
-- DUO CHAOS — 0009 player names
-- Let players choose a display name when creating/joining a room, and expose
-- both names in the public snapshot so each side sees the other's name.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- duo_create_room(p_code, p_token, p_name) — host creates the room (slot 1).
-- p_name is optional; falls back to 'PLAYER 1' when blank.
-- ---------------------------------------------------------------------------
create or replace function duo_create_room(p_code text, p_token text, p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_name text := coalesce(nullif(trim(coalesce(p_name, '')), ''), 'PLAYER 1');
  v_existing duo_rooms;
begin
  if v_code !~ '^[A-Z0-9]{6}$' then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;

  -- Cap the display name so a client cannot store an unbounded string.
  v_name := left(v_name, 16);

  select * into v_existing from duo_rooms where code = v_code;
  if found then
    raise exception 'room_exists' using errcode = 'P0001';
  end if;

  insert into duo_rooms (code, phase, round, round_seed)
  values (v_code, 'lobby', 1, v_code || ':1');

  insert into duo_players (room_code, slot, player_id, token, name, x, y)
  values (v_code, 1, 'p1', p_token, v_name, 18, 50);

  perform duo_spawn_coins(v_code);

  return jsonb_build_object('code', v_code, 'slot', 1, 'player_id', 'p1', 'name', v_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_join_room(p_code, p_token, p_name) — second player joins (slot 2).
-- Idempotent: if the token already belongs to a slot, return that slot and
-- refresh the stored name when a new one is supplied.
-- ---------------------------------------------------------------------------
create or replace function duo_join_room(p_code text, p_token text, p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_name text := coalesce(nullif(trim(coalesce(p_name, '')), ''), 'PLAYER 2');
  v_room duo_rooms;
  v_existing duo_players;
  v_count int;
begin
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  v_name := left(v_name, 16);

  -- Already a member? Return the existing slot (reconnect path).
  select * into v_existing
    from duo_players
    where room_code = v_code and token = p_token;
  if found then
    update duo_players
      set last_seen_at = now(),
          name = case
            when nullif(trim(coalesce(p_name, '')), '') is not null then v_name
            else name
          end
      where room_code = v_code and slot = v_existing.slot;
    return jsonb_build_object(
      'code', v_code,
      'slot', v_existing.slot,
      'player_id', v_existing.player_id,
      'name', case
        when nullif(trim(coalesce(p_name, '')), '') is not null then v_name
        else v_existing.name
      end
    );
  end if;

  select count(*) into v_count from duo_players where room_code = v_code;
  if v_count >= 2 then
    raise exception 'room_full' using errcode = 'P0001';
  end if;

  insert into duo_players (room_code, slot, player_id, token, name, x, y)
  values (v_code, 2, 'p2', p_token, v_name, 82, 50);

  return jsonb_build_object('code', v_code, 'slot', 2, 'player_id', 'p2', 'name', v_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_set_name(p_code, p_token, p_name) — update the caller's display name.
-- Used when a player changes their name while already in a room.
-- ---------------------------------------------------------------------------
create or replace function duo_set_name(p_code text, p_token text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_name text := left(coalesce(nullif(trim(coalesce(p_name, '')), ''), 'PLAYER'), 16);
  v_pl duo_players;
begin
  v_pl := duo_require_player(v_code, p_token);

  update duo_players
    set name = v_name, last_seen_at = now()
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object('ok', true, 'name', v_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the new 3-arg signatures plus the name setter.
-- ---------------------------------------------------------------------------
grant execute on function duo_create_room(text, text, text) to anon, authenticated;
grant execute on function duo_join_room(text, text, text)   to anon, authenticated;
grant execute on function duo_set_name(text, text, text)    to anon, authenticated;
