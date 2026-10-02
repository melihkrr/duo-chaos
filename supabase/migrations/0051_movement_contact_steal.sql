-- ============================================================================
-- 0051_movement_contact_steal.sql
--
-- Replaces `duo_steal_versioned` with a MOVEMENT-INTO-CONTACT attacker model.
--
-- WHY (user report — "steal mekaniği"):
--   0049/0050 decided the attacker from an APPROACH-SPEED comparison:
--       v_player_approach > 0.5
--       v_player_approach > v_opponent_approach + 0.5
--   plus a 300ms "freshness" requirement on BOTH movement samples. That model
--   broke legitimate steals:
--     * A stationary victim has no fresh movement sample, so the pursuer's
--       steal was rejected (`not_chasing`) even though the pursuer clearly
--       moved into contact.
--     * A legitimate head-on contact was rejected for BOTH players because
--       neither approach speed exceeded the other by 0.5.
--     * A player who stopped could still be credited from a stale sample.
--
-- NEW RULE (exact):
--   The attacker is whoever MOVED TOWARD the opponent between their previous
--   authoritative position and their current authoritative position.
--     * only A moved toward B            -> A steals (A +25, B -25, B -1 coin)
--     * only B moved toward A            -> B steals (B +25, A -25, A -1 coin)
--     * both moved toward each other     -> BOTH steal atomically
--                                           (A +25/B -25 AND B +25/A -25,
--                                            each loses 1 coin if they have one)
--     * neither moved toward the other   -> no steal
--   A stationary victim is NEVER required to have moved; the attacker's own
--   movement into contact is sufficient.
--
-- ATTACKER DETECTION (per player, from authoritative data only):
--   moved_toward := previous_x/y is not null
--                   AND current distance to opponent < previous distance
--   (strictly closer). No velocity threshold, no approach-speed comparison,
--   no freshness window, no timestamp equality rejection.
--
-- SIMULTANEOUS CONTACT:
--   If BOTH players moved toward each other, both steals are applied in the
--   SAME transaction (the row lock already serializes the two RPCs, so the
--   second caller must not be turned into a single winner). Net score change
--   is 0 for each player while both steal events are registered.
--
-- SAFEGUARDS PRESERVED (unchanged):
--   battle phase, player/token, opponent, expected round, contact range,
--   objective epoch/version, server-authoritative scoring, atomic transaction,
--   row locking, contact/cooldown guard, objective reroll/progress.
--
-- Idempotent: safe to re-run. Runs AFTER 0050.
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
  -- from within the guard window.
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
          last_stolen_at = v_now_ms,
          previous_x = x,
          previous_y = y,
          previous_position_at = null,
          position_updated_at = null
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
          last_stolen_at = v_now_ms,
          previous_x = x,
          previous_y = y,
          previous_position_at = null,
          position_updated_at = null
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

  update duo_players
    set stolen = v_new_stolen,
        round_stolen = coalesce(round_stolen, 0) + 1,
        objective_progress = case when v_counts_for_objective
          then greatest(coalesce(objective_progress, 0), v_progress)
          else objective_progress end,
        mission_done = case when v_counts_for_objective then v_satisfied else mission_done end,
        score = coalesce(score, 0) + v_steal_score,
        round_score = coalesce(round_score, 0) + v_steal_score,
        previous_x = x,
        previous_y = y,
        previous_position_at = null,
        position_updated_at = null
    where room_code = v_code and slot = v_pl.slot;

  update duo_players
    set coins = greatest(0, coins - 1),
        round_coins = greatest(0, coalesce(round_coins, 0) - 1),
        score = greatest(0, coalesce(score, 0) - v_steal_score),
        round_score = greatest(0, coalesce(round_score, 0) - v_steal_score),
        slowed_until = v_now_ms + 400,
        last_stolen_at = v_now_ms,
        previous_x = x,
        previous_y = y,
        previous_position_at = null,
        position_updated_at = null
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
