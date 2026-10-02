-- ============================================================================
-- 0053_remove_player_bump.sql
--
-- PLAYER BUMP / KNOCKBACK mekaniği TAMAMEN KALDIRILDI.
--
-- Neden: Kullanıcı geri bildirimi — "birbirini itme" davranışı istenmedi.
-- Bunun yerine oyuncular yalnızca birbirlerinin İÇİNDEN GEÇEMEZ (solid
-- çarpışma). Bu, tamamen İSTEMCİ tarafında, mevcut hareket çözümleyicisi
-- (`resolveMove`) ile yapılır; sunucuda ek bir RPC GEREKMEZ.
--
-- Bu migration:
--   1. `duo_bump` RPC'sini siler.
--   2. `duo_players.last_bump_at` sütununu siler.
--
-- NOT: Skor/coin/görev/tur ile ilgili HİÇBİR şeye dokunulmaz.
-- ============================================================================

drop function if exists public.duo_bump(text, text, numeric, numeric);

alter table public.duo_players
  drop column if exists last_bump_at;

notify pgrst, 'reload schema';
