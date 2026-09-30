-- ============================================================================
-- DUO CHAOS — 0007 RPC: progression & cosmetics
-- duo_get_progress, duo_award_progress, duo_set_cosmetics
-- Long-term XP / level / title / unlocks are persisted server-side, keyed by a
-- stable client id the browser stores locally. Cosmetics (emote, trail) are
-- chosen here and copied onto the player row when a round starts.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- duo_get_progress(p_client_id) — fetch (or lazily create) a profile.
-- ---------------------------------------------------------------------------
create or replace function duo_get_progress(p_client_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row duo_progression;
begin
  if p_client_id is null or length(trim(p_client_id)) = 0 then
    raise exception 'invalid_client' using errcode = 'P0001';
  end if;

  select * into v_row from duo_progression where client_id = p_client_id;
  if not found then
    insert into duo_progression (client_id) values (p_client_id)
    returning * into v_row;
  end if;

  return duo_profile_for_xp(v_row.xp)
    || jsonb_build_object('emote', v_row.emote, 'trail', v_row.trail);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_award_progress(p_client_id, p_xp) — add XP and return the new profile.
-- XP is clamped to a sane per-call range to limit abuse.
-- ---------------------------------------------------------------------------
create or replace function duo_award_progress(p_client_id text, p_xp int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row duo_progression;
  v_gain int := greatest(0, least(coalesce(p_xp, 0), 500));
  v_new_xp int;
  v_profile jsonb;
begin
  if p_client_id is null or length(trim(p_client_id)) = 0 then
    raise exception 'invalid_client' using errcode = 'P0001';
  end if;

  insert into duo_progression (client_id, xp)
  values (p_client_id, v_gain)
  on conflict (client_id) do update
    set xp = duo_progression.xp + v_gain,
        updated_at = now()
  returning * into v_row;

  v_new_xp := v_row.xp;
  v_profile := duo_profile_for_xp(v_new_xp);

  update duo_progression
    set level = (v_profile->>'level')::int,
        title = v_profile->>'title',
        unlocks = v_profile->'unlocks',
        updated_at = now()
    where client_id = p_client_id;

  return v_profile || jsonb_build_object('emote', v_row.emote, 'trail', v_row.trail);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_set_cosmetics(p_client_id, p_emote, p_trail) — choose cosmetics.
-- Only cosmetics present in the player's unlocks are accepted.
-- ---------------------------------------------------------------------------
create or replace function duo_set_cosmetics(p_client_id text, p_emote text, p_trail text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row duo_progression;
  v_profile jsonb;
  v_unlocks jsonb;
  v_emote text := coalesce(p_emote, '');
  v_trail text := coalesce(p_trail, '');
begin
  if p_client_id is null or length(trim(p_client_id)) = 0 then
    raise exception 'invalid_client' using errcode = 'P0001';
  end if;

  insert into duo_progression (client_id)
  values (p_client_id)
  on conflict (client_id) do nothing;

  select * into v_row from duo_progression where client_id = p_client_id;
  v_profile := duo_profile_for_xp(v_row.xp);
  v_unlocks := v_profile->'unlocks';

  -- Empty means "none" and is always allowed.
  if v_emote <> '' and not (v_unlocks ? v_emote) then
    raise exception 'locked_cosmetic' using errcode = 'P0001';
  end if;
  if v_trail <> '' and not (v_unlocks ? v_trail) then
    raise exception 'locked_cosmetic' using errcode = 'P0001';
  end if;

  update duo_progression
    set emote = v_emote, trail = v_trail, updated_at = now()
    where client_id = p_client_id;

  return jsonb_build_object('ok', true, 'emote', v_emote, 'trail', v_trail);
end;
$$;

-- ---------------------------------------------------------------------------
-- duo_apply_cosmetics(p_code, p_token, p_emote, p_trail) — copy the chosen
-- cosmetics onto the player row so the opponent can render them.
-- ---------------------------------------------------------------------------
create or replace function duo_apply_cosmetics(p_code text, p_token text, p_emote text, p_trail text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
begin
  v_pl := duo_require_player(v_code, p_token);

  update duo_players
    set emote = coalesce(p_emote, ''),
        trail = coalesce(p_trail, '')
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object('ok', true);
end;
$$;
