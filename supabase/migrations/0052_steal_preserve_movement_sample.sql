-- ============================================================================
-- 0052_steal_preserve_movement_sample.sql
--
-- REGRESSION FIX for 0051 (movement-into-contact steal).
--
-- SYMPTOM (live report):
--   "bir çalıyor 5 çalmıyor 6 defa sorunsuz çalıyor 3 defa çalmıyor"
--   = the steal lands once, then misses many times, then lands several times,
--     then misses again — intermittent / unreliable during a chase.
--
-- ROOT CAUSE:
--   0051's `duo_steal_versioned` reset the movement sample on BOTH players
--   after every successful steal:
--       previous_x = x, previous_y = y,
--       previous_position_at = null, position_updated_at = null
--   Attacker detection compares the distance from `previous_x/y` to the
--   opponent with the current contact distance. After a steal, `previous_x/y`
--   equals the CURRENT position, so the next attempt (still in contact, before
--   a fresh `duo_move` lands) computes:
--       prev_dist == dist  ->  moved_toward = false  ->  'not_chasing'
--   The client had already consumed its 700ms cooldown before the RPC, so it
--   missed repeatedly until a new server-recorded move arrived. That is exactly
--   the "1 hit / 5 miss / 6 hit" pattern.
--
-- FIX:
--   Do NOT touch `previous_x/y` (or the position timestamps) in the steal RPC.
--   The movement sample must survive the steal so that continuous contact keeps
--   a stable "moved toward" verdict. Anti-spam is ALREADY handled correctly by
--   the contact guard (`last_stolen_at`, 700ms) — destroying the movement
--   sample was both unnecessary and the source of the intermittency.
--
--   Attacker detection, simultaneous-contact handling, scoring (+25/-25, -1
--   coin), and every safeguard are otherwise IDENTICAL to 0051.
--
-- Idempotent: safe to re-run. Runs AFTER 0051.
-- ============================================================================

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
  v_opp duo_players;
  v_room duo_rooms;
  v_dist numeric;
  v_prev_dist numeric;
  v_opp_prev_dist numeric;
  v_pl_toward boolean := false;
  v_opp_toward boolean := false;
  v_now timestamptz;
  v_steal_score int := 25;
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
  -- not acquire the same rows in reverse order (deadlock-free).
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

  -- CONTACT / COOLDOWN GUARD (unchanged): the same continuous contact cannot
  -- generate unlimited steals. `last_stolen_at` is stamped on the VICTIM when
  -- a steal lands; a new steal is rejected while either participant was stolen
  -- from within the guard window. This is the ONLY anti-spam mechanism — the
  -- movement sample is intentionally left intact (see header).
  if coalesce(v_opp.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_opp.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'victim_guarded');
  end if;
  if coalesce(v_pl.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_pl.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'steal_cooldown');
  end if;

  -- CONTACT RANGE (unchanged): both avatars must actually touch.
  v_dist := sqrt(power(v_opp.x - v_pl.x, 2) + power(v_opp.y - v_pl.y, 2));
  if v_dist > 5.2 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  -- ATTACKER DETECTION — MOVEMENT INTO CONTACT.
  --
  -- For each player: did their latest authoritative movement bring them
  -- strictly closer to the opponent? We compare the distance from their
  -- PREVIOUS authoritative position to the opponent's CURRENT position with
  -- the CURRENT contact distance. A stationary player has no previous sample
  -- (or an unchanged one) and is therefore never treated as the attacker.
  --
  -- No freshness window, no velocity threshold, no approach-speed comparison.
  if v_pl.previous_x is not null and v_pl.previous_y is not null then
    v_prev_dist := sqrt(
      power(v_opp.x - v_pl.previous_x, 2) + power(v_opp.y - v_pl.previous_y, 2)
    );
    v_pl_toward := v_prev_dist > v_dist;
  end if;

  if v_opp.previous_x is not null and v_opp.previous_y is not null then
    v_opp_prev_dist := sqrt(
      power(v_pl.x - v_opp.previous_x, 2) + power(v_pl.y - v_opp.previous_y, 2)
    );
    v_opp_toward := v_opp_prev_dist > v_dist;
  end if;

  -- NEITHER moved toward the other -> no new steal.
  if not v_pl_toward and not v_opp_toward then
    return jsonb_build_object('ok', false, 'reason', 'not_chasing');
  end if;

  -- SIMULTANEOUS CONTACT: both players legitimately moved toward each other.
  -- Apply BOTH steals atomically in this single transaction. Each player
  -- gains +25 and loses 25 (net 0) and loses 1 coin if they have one. Both
  -- steal events are registered (stolen/round_stolen +1 for each).
  if v_pl_toward and v_opp_toward then
    -- Objective progress for the caller (v_pl) — same epoch/version rules.
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

    -- Caller (v_pl): +25 score, +1 stolen, -1 coin (if any), slowed.
    -- NOTE: previous_x/y are NOT reset — the movement sample must survive so
    -- continuous contact keeps a stable "moved toward" verdict.
    update duo_players
      set stolen = v_new_stolen,
          round_stolen = coalesce(round_stolen, 0) + 1,
          objective_progress = case when v_counts_for_objective
            then greatest(coalesce(objective_progress, 0), v_progress)
            else objective_progress end,
          mission_done = case when v_counts_for_objective then v_satisfied else mission_done end,
          score = coalesce(score, 0) + v_steal_score,
          round_score = coalesce(round_score, 0) + v_steal_score,
          coins = greatest(0, coins - 1),
          round_coins = greatest(0, coalesce(round_coins, 0) - 1),
          slowed_until = v_now_ms + 400,
          last_stolen_at = v_now_ms
      where room_code = v_code and slot = v_pl.slot;

    -- Opponent (v_opp): +25 score, +1 stolen, -1 coin (if any), slowed.
    -- Objective progress for the opponent uses their own objective/epoch.
    update duo_players
      set stolen = coalesce(stolen, 0) + 1,
          round_stolen = coalesce(round_stolen, 0) + 1,
          objective_progress = greatest(
            coalesce(objective_progress, 0),
            duo_mission_progress(
              objective, collected_types, coalesce(stolen, 0) + 1, coins
            )
          ),
          mission_done = duo_mission_satisfied(
            objective, collected_types, coalesce(stolen, 0) + 1, coins
          ),
          score = coalesce(score, 0) + v_steal_score,
          round_score = coalesce(round_score, 0) + v_steal_score,
          coins = greatest(0, coins - 1),
          round_coins = greatest(0, coalesce(round_coins, 0) - 1),
          slowed_until = v_now_ms + 400,
          last_stolen_at = v_now_ms
      where room_code = v_code and slot = v_opp.slot;

    -- Objective reroll for the caller if their mission completed.
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
      'mutual', true,
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
  end if;

  -- SINGLE ATTACKER. If the caller (v_pl) is not the one who moved toward the
  -- opponent, the opponent is the attacker; the caller's request is rejected
  -- so the opponent's own RPC (or a later one) performs the steal.
  if not v_pl_toward then
    return jsonb_build_object('ok', false, 'reason', 'not_chasing');
  end if;

  -- The caller is the attacker. The victim must have a coin to steal.
  if coalesce(v_opp.coins, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_coins');
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

  -- NOTE: previous_x/y are NOT reset (see header). Only the steal outcome is
  -- written; the movement sample is preserved for the next contact window.
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
    'mutual', false,
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
$function$;

grant execute on function public.duo_steal_versioned(text, text, integer, integer)
  to anon, authenticated;

notify pgrst, 'reload schema';
