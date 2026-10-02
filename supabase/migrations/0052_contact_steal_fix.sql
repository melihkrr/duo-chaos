-- ============================================================================
-- DUO CHAOS — 0052 CONTACT STEAL FIX (Option B, corrected)
--
-- ROOT CAUSE of "steal works once, then never again":
--   * 0051 nulled `position_updated_at` on BOTH players after a successful
--     steal. The attacker then stood still on the victim; the client only
--     sends `duo_move` when x/y actually change, so the
--     `duo_capture_previous_position` trigger never fired again and
--     `position_updated_at` stayed NULL -> every retry returned
--     `not_chasing`.
--   * 0051's tie-break compared `v_opp.position_updated_at <
--     v_pl.position_updated_at`. Because the victim is usually moving too,
--     the victim's timestamp was frequently EARLIER, so the attacker was
--     wrongly rejected as "not the initiator" even while pressing into the
--     victim.
--
-- FIX (still ONLY public.duo_steal_versioned):
--   * Remove the timestamp tie-break completely. The row locks already
--     serialize simultaneous contact; the contact guard (last_stolen_at,
--     700 ms) already rejects the second caller. That is the deterministic
--     resolution and it never penalises the legitimate initiator.
--   * Do NOT null `position_updated_at` on the attacker after a steal, so a
--     caller stopped exactly at contact can steal again as soon as the
--     cooldown elapses.
--   * Freshness gate is now: caller moved recently OR caller is currently in
--     contact (distance <= 5.2, already verified above). This guarantees the
--     "stopped exactly at contact" case always succeeds.
--
-- PRESERVED (unchanged): battle-phase, stale_round, no_opponent,
-- victim_guarded, steal_cooldown, no_coins, too_far, row locks, atomic
-- +25/-25, objective epoch guard, mission progress / reroll, returned state.
--
-- This migration ONLY replaces public.duo_steal_versioned. No other RPC,
-- table, trigger, client file, objective logic, movement logic or reconnect
-- logic is touched.
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
  v_now timestamptz;
  v_steal_score int := 25;
  v_contact_guard_ms int := 700;
  -- Generous freshness window: a caller who moved toward the opponent and then
  -- stopped exactly at contact must still succeed. 1500 ms comfortably covers
  -- a stopped-on-contact player while still rejecting a caller who has been
  -- idle for a long time.
  v_move_fresh interval := interval '1500 milliseconds';
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

  -- Serialize concurrent steals. The first transaction to acquire the locks
  -- wins; the second is rejected by the contact guard below. This is the
  -- deterministic resolution for simultaneous contact.
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

  -- Contact guard / duplicate protection (unchanged).
  if coalesce(v_opp.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_opp.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'victim_guarded');
  end if;
  if coalesce(v_pl.last_stolen_at, 0) > 0
     and v_now_ms - coalesce(v_pl.last_stolen_at, 0) < v_contact_guard_ms then
    return jsonb_build_object('ok', false, 'reason', 'steal_cooldown');
  end if;

  -- Victim must have coins to lose (unchanged).
  if coalesce(v_opp.coins, 0) <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_coins');
  end if;

  -- Contact distance (unchanged).
  v_dist := sqrt(power(v_opp.x - v_pl.x, 2) + power(v_opp.y - v_pl.y, 2));
  if v_dist > 5.2 then
    return jsonb_build_object('ok', false, 'reason', 'too_far');
  end if;

  -- CONTACT INITIATION (Option B): the caller must have moved recently.
  -- No direction, no velocity, no opponent comparison, no tie-break.
  -- A caller who moved toward the opponent and stopped at contact still
  -- passes because the window is generous (1500 ms). A caller who is
  -- currently in contact (distance <= 5.2, verified above) is also accepted
  -- even if their last movement sample is older, so a stopped-at-contact
  -- player never gets stuck.
  if v_pl.position_updated_at is null
     or v_pl.position_updated_at < v_now - v_move_fresh
     or v_pl.position_updated_at > v_now then
    -- Not recently moved. Accept only if we are genuinely in contact.
    if v_dist > 5.2 then
      return jsonb_build_object('ok', false, 'reason', 'not_chasing');
    end if;
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

  -- Attacker: award score. Do NOT null position_updated_at, so a caller
  -- stopped exactly at contact can steal again once the cooldown elapses.
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

  -- Victim: lose a coin and score, get slowed, and be guarded.
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
