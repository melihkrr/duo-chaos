-- ===========================================================================
-- 0015_fix_cosmetics_and_progression.sql
--
-- Fixes two client/server contract mismatches:
--
--   1. duo_set_cosmetics validated the chosen emote/trail against the
--      `unlocks` array produced by duo_profile_for_xp, which contains
--      human-readable names ('Confetti emote', 'Neon trail', ...). The client
--      (lib/config.ts EMOTES/TRAILS) sends stable ids ('wave', 'taunt',
--      'spark', 'frost', ...). Because the ids never appear in `unlocks`,
--      EVERY cosmetic selection was rejected with `locked_cosmetic`, so the
--      player could never change their emote/trail.
--
--      We now validate against the actual cosmetic ids, gated by the player's
--      level (the same minLevel the client uses in EMOTES/TRAILS).
--
--   2. duo_profile_for_xp returned an `unlocks` array of display names that no
--      longer matches the client's cosmetic ids. We keep the display names for
--      the profile UI but ALSO expose a machine-readable `unlocks` list of
--      cosmetic ids so the client can gate its picker consistently.
--
-- Idempotent: safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. duo_profile_for_xp — keep the level curve (xp/250) and titles, but make
--    `unlocks` a list of cosmetic IDS the client understands, derived from the
--    level. Display titles remain available via the `title` field.
-- ---------------------------------------------------------------------------
create or replace function duo_profile_for_xp(p_xp int)
returns jsonb
language plpgsql
immutable
as $$
declare
  lvl int := greatest(1, floor(p_xp / 250.0)::int + 1);
  ttl text;
  unlocks jsonb;
begin
  ttl := case
    when p_xp >= 1500 then 'Chaos Master'
    when p_xp >= 1000 then 'Risk Taker'
    when p_xp >= 650  then 'Coin Thief'
    when p_xp >= 300  then 'Chaos Rookie'
    else 'Rookie'
  end;

  -- Machine-readable cosmetic ids, gated by level. These MUST stay in sync
  -- with EMOTES/TRAILS `minLevel` in lib/config.ts.
  unlocks := jsonb_build_array('wave', 'none', 'spark');
  if lvl >= 2 then unlocks := unlocks || '["taunt","frost"]'::jsonb; end if;
  if lvl >= 3 then unlocks := unlocks || '["shock","ember"]'::jsonb; end if;
  if lvl >= 4 then unlocks := unlocks || '["gg","shadow"]'::jsonb; end if;
  if lvl >= 5 then unlocks := unlocks || '["fire"]'::jsonb; end if;

  return jsonb_build_object('xp', p_xp, 'level', lvl, 'title', ttl, 'unlocks', unlocks);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. duo_set_cosmetics — validate against the cosmetic ids (not display names).
--    Empty string means "none" and is always allowed.
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

grant execute on function duo_profile_for_xp(int) to anon, authenticated;
grant execute on function duo_set_cosmetics(text, text, text) to anon, authenticated;
