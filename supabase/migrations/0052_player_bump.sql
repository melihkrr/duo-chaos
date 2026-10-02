-- 0052_player_bump.sql
--
-- PLAYER BUMP / KNOCKBACK — server-authoritative contact resolution.
--
-- BEHAVIOUR
--   When the two players physically enter each other's contact range, BOTH are
--   pushed a short distance apart along the line connecting their centres. The
--   bump is purely positional:
--     * it does NOT change score, coins, objectives or the round,
--     * it does NOT end or interrupt the round,
--     * it does NOT introduce a second movement system — it reuses the existing
--       authoritative position pipeline (`duo_step_ok` anti-teleport guard,
--       `duo_clamp_pos` arena clamp) and writes the SAME `x`/`y` columns that
--       `duo_move` writes.
--
-- ANTI-SPAM
--   A per-pair cooldown (`duo_players.last_bump_at`) prevents continuous contact
--   from re-pushing every frame. After the cooldown elapses a NEW genuine
--   contact may bump again.
--
-- DETERMINISM / SAFETY
--   The push direction is the normalised vector between the two players. If the
--   centres are (almost) exactly coincident the direction is ambiguous, so we
--   fall back to a deterministic +x axis. The result is always finite and
--   clamped to the arena, so NaN/Infinity can never be produced.
--
-- The RPC is idempotent-safe: it only writes positions, so a transient retry
-- cannot double-apply any scoring side effect (there is none).

-- ---------------------------------------------------------------------------
-- 1. Per-pair bump cooldown clock.
-- ---------------------------------------------------------------------------
alter table public.duo_players
  add column if not exists last_bump_at timestamptz not null default to_timestamp(0);

-- ---------------------------------------------------------------------------
-- 2. `duo_bump` — resolve a contact between the two players.
--
--    Returns:
--      { ok: true,  bumped: true,  x, y, rivalX, rivalY }  on a resolved bump
--      { ok: true,  bumped: false, x, y, rivalX, rivalY }  when no bump applied
--      { ok: false, reason: 'not_live' | 'not_a_player' | 'no_rival' }
--
--    `x`/`y` are the CALLER's authoritative position after resolution;
--    `rivalX`/`rivalY` are the opponent's. Both clients reconcile from these.
-- ---------------------------------------------------------------------------
create or replace function public.duo_bump(p_code text, p_token text, p_x numeric, p_y numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_rival duo_players;
  v_room duo_rooms;
  v_pos jsonb;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_new_x numeric;
  v_new_y numeric;

  -- Contact radius (arena-%): two player hit radii (2.6 each) plus a small
  -- tolerance so a genuine touch registers. Mirrors lib/config.ts.
  v_contact_r numeric := 5.6;
  -- Knockback distance (arena-%): ~2.5 "metres" of separation per player.
  v_knockback numeric := 2.5;
  -- Per-pair cooldown (ms): continuous contact must not push every frame.
  v_cooldown_ms bigint := 600;

  v_dx numeric;
  v_dy numeric;
  v_dist numeric;
  v_nx numeric;
  v_ny numeric;
  v_me_x numeric;
  v_me_y numeric;
  v_rival_x numeric;
  v_rival_y numeric;
  v_elapsed_ms bigint;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase not in ('countdown', 'battle') then
    return jsonb_build_object('ok', false, 'reason', 'not_live');
  end if;

  -- Validate the caller's requested position through the SAME anti-teleport
  -- guard used by `duo_move`. If it is not reachable we ignore the client
  -- coordinates and use the server-stored position instead (never trust a
  -- client-supplied knockback position).
  v_pos := duo_clamp_pos(p_x, p_y);
  v_new_x := (v_pos->>'x')::numeric;
  v_new_y := (v_pos->>'y')::numeric;

  if duo_step_ok(
    v_pl.x, v_pl.y, v_pl.last_move_at, v_new_x, v_new_y, v_pl.slowed_until, v_now_ms
  ) then
    v_pl.x := v_new_x;
    v_pl.y := v_new_y;
  end if;

  -- Lock both players in a STABLE order (by slot) to avoid deadlocks when both
  -- clients call `duo_bump` in the same instant.
  select * into v_pl
    from duo_players
    where room_code = v_code and slot = v_pl.slot
    for update;

  select * into v_rival
    from duo_players
    where room_code = v_code and slot <> v_pl.slot
    order by slot
    limit 1
    for update;

  if not found then
    return jsonb_build_object(
      'ok', false, 'reason', 'no_rival',
      'x', v_pl.x, 'y', v_pl.y
    );
  end if;

  v_me_x := v_pl.x;
  v_me_y := v_pl.y;
  v_rival_x := v_rival.x;
  v_rival_y := v_rival.y;

  v_dx := v_me_x - v_rival_x;
  v_dy := v_me_y - v_rival_y;
  v_dist := sqrt(power(v_dx, 2) + power(v_dy, 2));

  -- Cooldown gate: a bump may only resolve once per cooldown window.
  v_elapsed_ms := v_now_ms - (extract(epoch from v_pl.last_bump_at) * 1000)::bigint;

  if v_dist > v_contact_r or v_elapsed_ms < v_cooldown_ms then
    return jsonb_build_object(
      'ok', true, 'bumped', false,
      'x', v_me_x, 'y', v_me_y,
      'rivalX', v_rival_x, 'rivalY', v_rival_y
    );
  end if;

  -- Direction: normalised vector from rival -> me. Deterministic fallback when
  -- the centres coincide (ambiguous): push along +x.
  if v_dist < 1e-6 then
    v_nx := 1;
    v_ny := 0;
  else
    v_nx := v_dx / v_dist;
    v_ny := v_dy / v_dist;
  end if;

  -- Push both players apart by the same distance along the connecting line.
  v_me_x := v_me_x + v_nx * v_knockback;
  v_me_y := v_me_y + v_ny * v_knockback;
  v_rival_x := v_rival_x - v_nx * v_knockback;
  v_rival_y := v_rival_y - v_ny * v_knockback;

  -- Clamp to the arena. (Obstacle push-out is applied client-side by
  -- `resolveMove`/`pushOut` on the next frame; the server keeps the same arena
  -- clamp contract as `duo_move`.)
  v_pos := duo_clamp_pos(v_me_x, v_me_y);
  v_me_x := (v_pos->>'x')::numeric;
  v_me_y := (v_pos->>'y')::numeric;

  v_pos := duo_clamp_pos(v_rival_x, v_rival_y);
  v_rival_x := (v_pos->>'x')::numeric;
  v_rival_y := (v_pos->>'y')::numeric;

  -- Write BOTH positions. `last_move_at` is advanced so the anti-teleport guard
  -- treats the knockback as a legitimate (server-authored) step.
  update duo_players
    set x = v_me_x,
        y = v_me_y,
        last_move_at = now(),
        last_seen_at = now(),
        last_bump_at = now()
    where room_code = v_code and slot = v_pl.slot;

  update duo_players
    set x = v_rival_x,
        y = v_rival_y,
        last_move_at = now(),
        last_seen_at = now(),
        last_bump_at = now()
    where room_code = v_code and slot = v_rival.slot;

  return jsonb_build_object(
    'ok', true, 'bumped', true,
    'x', v_me_x, 'y', v_me_y,
    'rivalX', v_rival_x, 'rivalY', v_rival_y
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Client RPC surface.
-- ---------------------------------------------------------------------------
grant execute on function public.duo_bump(text, text, numeric, numeric)
  to anon, authenticated;

notify pgrst, 'reload schema';
