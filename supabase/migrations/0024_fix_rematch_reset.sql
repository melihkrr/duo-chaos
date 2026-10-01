-- ============================================================================
-- 0024_fix_rematch_reset.sql
--
-- SORUN (eksik sıfırlama — rövanş sonrası tutarsız durum):
--
--   `duo_rematch` (0003_rpc_lifecycle.sql) hâlâ 0003'teki ESKİ sıfırlama
--   mantığını kullanıyor. 0012/0021 ile gelen `objectives_done` sütununu
--   SIFIRLAMIYOR:
--
--       update duo_players
--         set coins = 0, stolen = 0, collected_types = '{}'::jsonb,
--             score = 0, round_score = 0, total_score = 0,
--             mission_done = false, rematch = false,
--             scout_charges = 2, scout_used_at = 0, revealed_hint = null,
--             slowed_until = 0, x = ..., y = 50
--         where room_code = v_code;
--
--   Oysa `duo_start_round` (0023) tur başında `objectives_done = 0` yapıyor.
--   Rövanşta oda `lobby`'ye dönerken `objectives_done` ESKİ maçtan kalıyor;
--   `duo_public_state` bu alanı istemciye `objectivesDone` olarak verdiği için
--   yeni maçın ilk turu başlamadan önce HUD/sonuç ekranı yanlış görev sayısı
--   gösterebiliyor. Ayrıca `objective` alanı da eski maçtan kalıyor (bir
--   sonraki `duo_start_round` düzeltene kadar), bu da lobide yanlış hedef
--   göstermeye yol açıyor.
--
-- ÇÖZÜM:
--   `duo_rematch`'i yeniden tanımlar; iki oyuncu da hazır olduğunda odayı
--   `lobby`'ye çekerken `duo_start_round` ile AYNI tam sıfırlamayı uygular:
--     * `objectives_done = 0`
--     * `objective = null` (yeni maçın görevleri `duo_start_round`'da atanır)
--   Böylece rövanş sonrası durum, taze bir maçla birebir tutarlı olur.
--
-- Idempotent: güvenle tekrar çalıştırılabilir. 0003'ten SONRA çalışır, bu
-- yüzden nihai `duo_rematch` tanımı buradadır.
-- ============================================================================

create or replace function duo_rematch(p_code text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(p_code));
  v_pl duo_players;
  v_ready int;
begin
  v_pl := duo_require_player(v_code, p_token);

  update duo_players set rematch = true
    where room_code = v_code and slot = v_pl.slot;

  select count(*) into v_ready
    from duo_players where room_code = v_code and rematch = true;

  if v_ready >= 2 then
    update duo_rooms
      set phase = 'lobby',
          round = 1,
          countdown_ends_at = 0,
          ends_at = 0,
          chaos_event = null,
          chaos_ends_at = 0,
          winner = null,
          round_scores = '{}'::jsonb,
          match_scores = '{}'::jsonb,
          round_seed = v_code || ':1',
          updated_at = now()
      where code = v_code;

    -- `duo_start_round` ile AYNI tam sıfırlama. `objectives_done` ve
    -- `objective` dahil; böylece rövanş sonrası durum taze maçla tutarlıdır.
    update duo_players
      set coins = 0, stolen = 0, collected_types = '{}'::jsonb,
          score = 0, round_score = 0, total_score = 0,
          objectives_done = 0,
          objective = null,
          mission_done = false, rematch = false,
          scout_charges = 2, scout_used_at = 0, revealed_hint = null,
          slowed_until = 0,
          x = case when slot = 1 then 18 else 82 end,
          y = 50
      where room_code = v_code;

    perform duo_spawn_coins(v_code);
  end if;

  return jsonb_build_object('ok', true, 'ready', v_ready);
end;
$$;

grant execute on function duo_rematch(text, text) to anon, authenticated;

-- PostgREST şema önbelleğini tazele.
notify pgrst, 'reload schema';
