-- ============================================================================
-- DUO CHAOS — 0006 RPC: Guess/Read mechanic
-- duo_scout — spend a limited charge to reveal a partial hint about the
-- opponent's secret objective. This is the "Tahmin et" (Guess) step of the
-- core loop: it turns hidden information into a tactical decision.
--
-- Design:
--   * Each player starts a round with 2 scout charges.
--   * Scouting costs a charge and has a cooldown (8s) to prevent spamming.
--   * The hint is PARTIAL: it reveals the objective's kind and target, and
--     either the coin type or one requirement — never the full label.
--   * The revealed hint is stored on the caller and surfaced through
--     duo_public_state as `revealedHint`.
-- ============================================================================

create or replace function duo_scout(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_opp duo_players;
  v_room duo_rooms;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
  v_obj jsonb;
  v_hint jsonb;
  v_req_key text;
  v_req_val int;
begin
  v_pl := duo_require_player(v_code, p_token);

  select * into v_room from duo_rooms where code = v_code;
  if v_room.phase <> 'battle' then
    return jsonb_build_object('ok', false, 'reason', 'not_battle');
  end if;

  if v_pl.scout_charges <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_charges');
  end if;

  if v_now - v_pl.scout_used_at < 8000 then
    return jsonb_build_object('ok', false, 'reason', 'cooldown');
  end if;

  select * into v_opp
    from duo_players
    where room_code = v_code and slot <> v_pl.slot;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_opponent');
  end if;

  v_obj := v_opp.objective;
  if v_obj is null then
    return jsonb_build_object('ok', false, 'reason', 'no_objective');
  end if;

  -- Build a partial hint. Never expose the full label.
  v_hint := jsonb_build_object(
    'kind', v_obj->>'kind',
    'target', (v_obj->>'target')::int
  );

  if v_obj->'requirements' is not null and jsonb_typeof(v_obj->'requirements') = 'object' then
    -- Reveal exactly one required resource (the first by key order).
    select key, (value)::text::int
      into v_req_key, v_req_val
      from jsonb_each(v_obj->'requirements')
      order by key
      limit 1;
    v_hint := v_hint || jsonb_build_object(
      'coinType', v_req_key,
      'requirement', jsonb_build_object(v_req_key, v_req_val)
    );
  elsif (v_obj->>'coinType') is not null and (v_obj->>'coinType') <> 'mixed' then
    v_hint := v_hint || jsonb_build_object('coinType', v_obj->>'coinType');
  end if;

  if (v_obj->>'kind') = 'steal' then
    v_hint := v_hint || jsonb_build_object(
      'stealTarget', coalesce((v_obj->>'stealTarget')::int, (v_obj->>'target')::int)
    );
  end if;

  update duo_players
    set scout_charges = scout_charges - 1,
        scout_used_at = v_now,
        revealed_hint = v_hint
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object(
    'ok', true,
    'hint', v_hint,
    'chargesLeft', v_pl.scout_charges - 1
  );
end;
$$;
