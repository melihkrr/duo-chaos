-- ============================================================================
-- DUO CHAOS — 0008 grants
-- Expose only the RPC surface to the anon/authenticated roles. Direct table
-- access stays blocked by RLS (no policies were created in 0001).
-- ============================================================================

-- Revoke any accidental direct table access.
revoke all on duo_rooms       from anon, authenticated;
revoke all on duo_players     from anon, authenticated;
revoke all on duo_coins       from anon, authenticated;
revoke all on duo_events      from anon, authenticated;
revoke all on duo_progression from anon, authenticated;

-- Room lifecycle
grant execute on function duo_create_room(text, text)          to anon, authenticated;
grant execute on function duo_join_room(text, text)            to anon, authenticated;
grant execute on function duo_leave(text, text)                to anon, authenticated;
grant execute on function duo_rematch(text, text)              to anon, authenticated;
grant execute on function duo_public_state(text, text)         to anon, authenticated;

-- Gameplay
grant execute on function duo_move(text, text, numeric, numeric) to anon, authenticated;
grant execute on function duo_collect(text, text, int)           to anon, authenticated;
grant execute on function duo_steal(text, text)                  to anon, authenticated;
grant execute on function duo_start_round(text, text)            to anon, authenticated;
grant execute on function duo_advance_phase(text, text)          to anon, authenticated;
grant execute on function duo_tick(text, text)                   to anon, authenticated;

-- Guess/Read
grant execute on function duo_scout(text, text) to anon, authenticated;

-- Progression & cosmetics
grant execute on function duo_get_progress(text)                 to anon, authenticated;
grant execute on function duo_award_progress(text, int)          to anon, authenticated;
grant execute on function duo_set_cosmetics(text, text, text)    to anon, authenticated;
grant execute on function duo_apply_cosmetics(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Housekeeping: drop rooms that have been idle for more than 2 hours.
-- Schedule with pg_cron if available, e.g.:
--   select cron.schedule('duo-cleanup', '*/15 * * * *', $$select duo_cleanup()$$);
-- ---------------------------------------------------------------------------
create or replace function duo_cleanup()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted int;
begin
  with gone as (
    delete from duo_rooms
    where updated_at < now() - interval '2 hours'
    returning 1
  )
  select count(*) into v_deleted from gone;
  return v_deleted;
end;
$$;

grant execute on function duo_cleanup() to anon, authenticated;
