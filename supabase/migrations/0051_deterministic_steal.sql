-- 0051_deterministic_steal.sql
--
-- ROOT CAUSE OF THE FLAKY STEAL ("bazen çalışıyor bazen çalışmıyor,
-- bazen puanı çalana bazen çalınana veriyor"):
--
--   0049/0050 tried to INFER which player was the "chaser" from a single pair
--   of server-observed movement samples (`previous_x/previous_y` vs the current
--   position). That heuristic is inherently non-deterministic:
--
--     * Both players move constantly, so the last sample pair is noisy. When
--       the victim happened to be running toward the stealer at the moment of
--       contact, the victim's approach velocity could exceed the stealer's and
--       the legitimate steal was rejected (`not_chasing`).
--     * A player who STOPS to press steal has `position_updated_at <=
--       previous_position_at` (no new sample) or a sample older than the 300 ms
--       freshness window -> `not_chasing` -> the steal silently failed.
--     * Because the winner depended on sub-second movement history, the same
--       physical action produced different results on different attempts.
--
-- FIX — DETERMINISTIC, INITIATOR-AUTHORITATIVE STEAL:
--
--   The player who INITIATES the steal is the stealer. The client that detects
--   contact calls `duo_steal_versioned` and supplies its own position. The
--   server no longer guesses intent; it only validates that contact is REAL:
--
--     1. The caller-supplied position is validated with `duo_step_ok` against
--        the last server-stored position (anti-teleport). If the step is not
--        reachable we fall back to the stored position — a lying client cannot
--        teleport next to the rival.
--     2. Contact is `distance(validated_caller_pos, opponent_stored_pos) <=
--        STEAL_RADIUS + CONTACT_SLACK`. No approach/velocity inference.
--     3. The 700 ms contact guard is kept. It serialises simultaneous contact
--        (both clients detecting each other): whichever RPC commits first is
--        the stealer, the other is rejected as `victim_guarded`. This is
--        deterministic and fair — the faster/earlier initiator wins.
--
--   The function returns BOTH the stealer `state` (+25) and the victim
--   `victimState` (-25) so each client applies the authoritative delta
--   immediately, without waiting for the ~1 s `duo_public_state` poll (which
--   can return a stale pre-commit snapshot and make the point appear on the
--   wrong player).
--
--   The noisy `previous_x/previous_y` columns are no longer read here. They are
--   left in place (other migrations reference them) but are irrelevant to the
--   steal decision.

-- ---------------------------------------------------------------------------
-- 1. Deterministic steal — 6-arg signature with caller-supplied position.
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

grant execute on function public.duo_steal_versioned(text, text, integer, integer, numeric, numeric)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Backward-compatible 4-arg wrapper.
--    Older clients (and the legacy `duo_steal` wrapper) call the 4-arg form.
--    It delegates using the caller's STORED position, so behaviour is
--    identical to the pre-0051 signature but with the deterministic rules.
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

grant execute on function public.duo_steal_versioned(text, text, integer, integer)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Legacy `duo_steal(p_code, p_token)` wrapper — unchanged contract.
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

grant execute on function public.duo_steal(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
