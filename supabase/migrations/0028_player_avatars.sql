-- ============================================================================
-- 0028_player_avatars.sql
--
-- KULLANICI SEÇİLEBİLİR HAYVAN AVATARI.
--
-- İsim nasıl serbestçe yazılıp değiştirilebiliyorsa, oyuncunun arena/HUD/sonuç
-- ekranlarında görünen HAYVAN YÜZÜ de kullanıcı tarafından seçilebilir olmalı.
-- Bu migration avatar kozmetiğini uçtan uca ekler:
--
--   1. `duo_progression.avatar` — kalıcı seçim (client_id bazlı).
--   2. `duo_players.avatar`     — maç içi satır (rakip görebilsin diye).
--   3. `duo_avatar_ids()`       — geçerli avatar id listesi (tek doğruluk
--      kaynağı; istemcideki `AVATARS` ile BİREBİR aynı olmalı).
--   4. `duo_set_cosmetics`      — 4 argümanlı yeni imza (p_avatar eklendi).
--      Eski 3 argümanlı imza KORUNUR (geriye dönük uyumluluk).
--   5. `duo_apply_cosmetics`    — 5 argümanlı yeni imza; seçimi oyuncu satırına
--      kopyalar ki rakip görebilsin. Eski 4 argümanlı imza KORUNUR.
--   6. `duo_get_progress` / `duo_award_progress` — avatar alanını döndürür.
--   7. `duo_public_state`       — her oyuncu için `avatar` döndürür.
--
-- Idempotent: tekrar çalıştırılabilir.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Sütunlar
-- ---------------------------------------------------------------------------
alter table duo_progression
  add column if not exists avatar text not null default '';

alter table duo_players
  add column if not exists avatar text not null default '';

-- ---------------------------------------------------------------------------
-- 2. duo_avatar_ids() — geçerli avatar id listesi.
--    İstemcideki `AVATARS` (lib/config.ts) ile BİREBİR aynı olmalıdır.
-- ---------------------------------------------------------------------------
create or replace function duo_avatar_ids()
returns text[]
language sql
immutable
as $$
  select array[
    'rabbit', 'bear', 'fox', 'panda', 'cat', 'dog',
    'frog', 'penguin', 'koala', 'tiger', 'unicorn', 'dragon'
  ]::text[];
$$;

-- ---------------------------------------------------------------------------
-- 3. duo_avatar_min_level(id) — avatarın açıldığı seviye.
--    İstemcideki `AVATARS[].minLevel` ile BİREBİR aynı olmalıdır.
-- ---------------------------------------------------------------------------
create or replace function duo_avatar_min_level(p_id text)
returns int
language sql
immutable
as $$
  select case p_id
    when 'rabbit'  then 1
    when 'bear'    then 1
    when 'fox'     then 1
    when 'panda'   then 1
    when 'cat'     then 1
    when 'dog'     then 1
    when 'frog'    then 2
    when 'penguin' then 2
    when 'koala'   then 3
    when 'tiger'   then 3
    when 'unicorn' then 4
    when 'dragon'  then 5
    else 99
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. duo_set_cosmetics(p_client_id, p_emote, p_trail, p_avatar)
--    Avatarı da doğrular ve kaydeder. Boş string "seçim yok" demektir ve her
--    zaman geçerlidir. Seviye kilidi uygulanır.
-- ---------------------------------------------------------------------------
create or replace function duo_set_cosmetics(
  p_client_id text,
  p_emote text,
  p_trail text,
  p_avatar text
)
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
  v_avatar text := coalesce(p_avatar, '');
  v_level int;
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
  v_level := coalesce((v_profile->>'level')::int, 1);

  -- Empty means "none" and is always allowed.
  if v_emote <> '' and not (v_unlocks ? v_emote) then
    raise exception 'locked_cosmetic' using errcode = 'P0001';
  end if;
  if v_trail <> '' and not (v_unlocks ? v_trail) then
    raise exception 'locked_cosmetic' using errcode = 'P0001';
  end if;

  -- Avatar: geçerli bir id olmalı VE seviye kilidi açık olmalı.
  if v_avatar <> '' then
    if not (v_avatar = any (duo_avatar_ids())) then
      raise exception 'invalid_avatar' using errcode = 'P0001';
    end if;
    if v_level < duo_avatar_min_level(v_avatar) then
      raise exception 'locked_cosmetic' using errcode = 'P0001';
    end if;
  end if;

  update duo_progression
    set emote = v_emote,
        trail = v_trail,
        avatar = v_avatar,
        updated_at = now()
    where client_id = p_client_id;

  return jsonb_build_object(
    'ok', true,
    'emote', v_emote,
    'trail', v_trail,
    'avatar', v_avatar
  );
end;
$$;

-- Geriye dönük uyumluluk: eski 3 argümanlı imza avatarı DEĞİŞTİRMEZ.
create or replace function duo_set_cosmetics(
  p_client_id text,
  p_emote text,
  p_trail text
)
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
-- 5. duo_apply_cosmetics(p_code, p_token, p_emote, p_trail, p_avatar)
--    Seçimi oyuncu satırına kopyalar (rakip görebilsin).
-- ---------------------------------------------------------------------------
create or replace function duo_apply_cosmetics(
  p_code text,
  p_token text,
  p_emote text,
  p_trail text,
  p_avatar text
)
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
        trail = coalesce(p_trail, ''),
        avatar = coalesce(p_avatar, '')
    where room_code = v_code and slot = v_pl.slot;

  return jsonb_build_object('ok', true);
end;
$$;

-- Geriye dönük uyumluluk: eski 4 argümanlı imza avatarı DEĞİŞTİRMEZ.
create or replace function duo_apply_cosmetics(
  p_code text,
  p_token text,
  p_emote text,
  p_trail text
)
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

-- ---------------------------------------------------------------------------
-- 6. duo_get_progress / duo_award_progress — avatar alanını da döndür.
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
    || jsonb_build_object(
      'emote', v_row.emote,
      'trail', v_row.trail,
      'avatar', v_row.avatar
    );
end;
$$;

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

  return v_profile || jsonb_build_object(
    'emote', v_row.emote,
    'trail', v_row.trail,
    'avatar', v_row.avatar
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. duo_public_state — her oyuncu için `avatar` döndür.
--    Gövde 0027 ile aynıdır; yalnızca 'avatar' alanı eklenmiştir.
-- ---------------------------------------------------------------------------
create or replace function duo_public_state(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_room duo_rooms;
  v_me duo_players;
  v_players jsonb;
  v_coins jsonb;
  v_count int;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  select * into v_room from duo_rooms where code = v_code;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;

  v_me := duo_require_player(v_code, p_token);

  update duo_players set last_seen_at = now()
    where room_code = v_code and slot = v_me.slot;

  perform duo_respawn_coins(v_code);

  select count(*) into v_count from duo_players where room_code = v_code;

  select jsonb_agg(
    jsonb_build_object(
      'id', p.player_id,
      'name', p.name,
      'x', p.x,
      'y', p.y,
      'coins', p.coins,
      'stolen', p.stolen,
      'roundCoins', p.round_coins,
      'roundStolen', p.round_stolen,
      'collectedTypes', p.collected_types,
      'score', p.score,
      'roundScore', p.round_score,
      'totalScore', p.total_score,
      'objectivesDone', p.objectives_done,
      'objective', p.objective,
      'missionDone', p.mission_done,
      'rematch', p.rematch,
      'emote', p.emote,
      'trail', p.trail,
      'avatar', p.avatar,
      'slowedUntil', p.slowed_until,
      'scoutCharges', case when p.player_id = v_me.player_id then p.scout_charges else null end,
      'scoutUsedAt', case when p.player_id = v_me.player_id then p.scout_used_at else null end,
      'revealedHint', case when p.player_id = v_me.player_id then v_me.revealed_hint else null end
    )
    order by p.slot
  )
  into v_players
  from duo_players p
  where p.room_code = v_code;

  select jsonb_agg(
    jsonb_build_object(
      'id', c.coin_id,
      'x', c.x,
      'y', c.y,
      'type', c.type,
      'collectedBy', c.collected_by,
      'respawnAt', c.respawn_at
    )
    order by c.coin_id
  )
  into v_coins
  from duo_coins c
  where c.room_code = v_code;

  return jsonb_build_object(
    'phase', v_room.phase,
    'round', v_room.round,
    'playerCount', v_count,
    'serverNow', v_now,
    'countdownEndsAt', v_room.countdown_ends_at,
    'endsAt', v_room.ends_at,
    'chaosEvent', case when v_room.chaos_event is null then null else jsonb_build_object(
        'id', v_room.chaos_event,
        'name', case v_room.chaos_event
          when 'gold-rush' then 'Gold Rush'
          when 'blackout'  then 'Blackout'
          when 'magnet'    then 'Magnet Storm'
          when 'swap'      then 'Chaos Swap'
          when 'jackpot'   then 'Jackpot'
        end,
        'description', case v_room.chaos_event
          when 'gold-rush' then 'Gold spawns are boosted for 15s.'
          when 'blackout'  then 'The arena dims and nearby resources become more valuable.'
          when 'magnet'    then 'Coins drift toward the center and pressure rises.'
          when 'swap'      then 'One of your targets is swapped mid-round.'
          when 'jackpot'   then 'A single Diamond appears. First player gets +50.'
        end,
        'boost', case v_room.chaos_event
          when 'gold-rush' then 'Gold reward x3'
          when 'blackout'  then 'Risky visibility'
          when 'magnet'    then 'Resource control'
          when 'swap'      then 'Plans break'
          when 'jackpot'   then 'Diamond +50'
        end
      ) end,
    'chaosEventEndsAt', v_room.chaos_ends_at,
    'winner', v_room.winner,
    'roundScores', v_room.round_scores,
    'matchScores', v_room.match_scores,
    'players', coalesce(v_players, '[]'::jsonb),
    'coins', coalesce(v_coins, '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function duo_avatar_ids() to anon, authenticated;
grant execute on function duo_avatar_min_level(text) to anon, authenticated;
grant execute on function duo_set_cosmetics(text, text, text, text) to anon, authenticated;
grant execute on function duo_set_cosmetics(text, text, text) to anon, authenticated;
grant execute on function duo_apply_cosmetics(text, text, text, text, text) to anon, authenticated;
grant execute on function duo_apply_cosmetics(text, text, text, text) to anon, authenticated;
grant execute on function duo_get_progress(text) to anon, authenticated;
grant execute on function duo_award_progress(text, int) to anon, authenticated;
grant execute on function duo_public_state(text, text) to anon, authenticated;
