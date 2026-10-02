-- 0051_simple_contact_steal.sql
--
-- ROOT CAUSE (why steal was flaky / sometimes credited the wrong player):
--
--   0049/0050 tried to INFER who was the "chaser" from server-recorded movement
--   samples (`previous_x/previous_y` + `position_updated_at`) with a 300ms
--   freshness window and an approach-velocity comparison. That inference is
--   fundamentally unreliable for this game:
--
--     * The client triggers a steal when the player is already WITHIN
--       `STEAL_RADIUS` of the rival — i.e. the player has typically STOPPED.
--       `duo_move` only writes a row when the position actually changes, so the
--       movement sample is stale by the time the steal RPC arrives →
--       `not_chasing` → the steal silently fails ("sometimes works").
--     * The client triggers on `liveRivalPos`, which is DEAD-RECKONED and can
--       LEAD the true server position by a frame or two. The server's stored
--       distance check could then reject a legitimate contact as `too_far`.
--     * When both players are in contact, whichever RPC arrives first wins the
--       velocity comparison — so the point could be awarded to the player who
--       was actually being chased ("sometimes gives the point to the wrong
--       player").
--
-- THE FIX (simple + deterministic):
--
--   The INITIATOR is the stealer. There is no direction inference and no
--   movement-history requirement. The server only:
--     1. validates the caller's claimed position with `duo_step_ok`
--        (anti-teleport; falls back to the stored position on violation),
--     2. checks real contact against the opponent's stored position with a
--        small slack that absorbs client prediction lead, and
--     3. applies +25 / -25 atomically under a row lock.
--
--   The response carries `victimState` so the victim's client can apply the
--   -25 immediately instead of waiting for a possibly-stale public-state poll.
--
-- This migration REPLACES the 0051 deterministic functions that were applied to
-- the live database (the repo had been reverted to 0050 while the DB still ran
-- the deterministic 6-arg version — a client/server desync that made the live
-- behaviour non-deterministic).

-- ---------------------------------------------------------------------------
-- Core: 6-arg versioned steal. The caller supplies its own position.
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
  v_dist numeric;
  v_now timestamptz;
  v_steal_score int := 25;
  v_contact_guard_ms int := 700;
  -- Contact slack (arena-%): the client triggers on its PREDICTED position,
  -- which can lead the server-stored position by a frame or two. A small slack
  -- keeps legitimate contact from being rejected as `too_far` without allowing
  -- a remote steal.
  v_contact_slack numeric := 2.0;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
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

  -- Serialise concurrent steal attempts for the room (stable slot order).
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

  v_now := clock_timestamp();

  -- Contact guard: serialises simultaneous contact and prevents double-steal.
  if coalesce(v_opp.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_opp.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'victim_guarded');
  end if;
  if coalesce(v_pl.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_pl.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'steal_cooldown');
  end if;
  if coalesce(v_opp.coins, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_coins');
  end if;

  -- Validate the caller-supplied position (anti-teleport). On violation fall
  -- back to the server-stored position — never trust an unreachable claim.
  v_pos := duo_clamp_pos(p_x, p_y);
  v_new_x := (v_pos->>'x')::numeric;
  v_new_y := (v_pos->>'y')::numeric;
  if not duo_step_ok(
    v_pl.x, v_pl.y, v_pl.last_move_at, v_new_x, v_new_y, v_pl.slowed_until, v_now_ms
  ) then
    v_new_x := v_pl.x;
    v_new_y := v_pl.y;
  end if;

  -- Contact check against the opponent's stored position. No direction
  -- inference: the initiator is the stealer.
  v_dist := sqrt(power(v_opp.x - v_new_x, 2) + power(v_opp.y - v_new_y, 2));
  if v_dist > 5.2 + v_contact_slack then
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

  -- Stealer: +25, write the validated position and advance the move clock.
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

  -- Victim: -25, slowed, contact-guarded.
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
    -- Authoritative victim delta so the victim's client applies -25 at once
    -- instead of waiting for a possibly-stale public-state poll.
    'victimState', jsonb_build_object(
      'coins', v_victim_after.coins,
      'roundCoins', coalesce(v_victim_after.round_coins, 0),
      'score', coalesce(v_victim_after.score, 0),
      'roundScore', coalesce(v_victim_after.round_score, 0)
    )
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Backward-compatible 4-arg wrapper (delegates with the stored position).
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
  return public.duo_steal_versioned(
    p_code, p_token, p_expected_objectives_done, p_expected_round, v_pl.x, v_pl.y
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Backward-compatible 2-arg wrapper.
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
  return public.duo_steal_versioned(
    p_code, p_token, coalesce(v_pl.objectives_done, 0), null, v_pl.x, v_pl.y
  );
end;
$function$;

grant execute on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric)
  to anon, authenticated;
grant execute on function public.duo_steal_versioned(text, text, integer, integer)
  to anon, authenticated;
grant execute on function public.duo_steal(text, text)
  to anon, authenticated;

notify pgrst, 'reload schema';
