/**
 * Sunucudan (Postgres / PostgREST) veya ağdan dönen ham hata mesajlarını
 * oyuncunun anlayacağı sade İngilizce metinlere çevirir.
 *
 * Sunucu tarafı `raise exception 'room_full'` gibi teknik kodlar fırlatır;
 * bunları doğrudan ekrana basmak yerine burada eşleyip gösteririz.
 */

/** Sunucunun fırlattığı bilinen hata kodları → kullanıcı dostu mesaj. */
const MESSAGES: Record<string, string> = {
  // --- Oda yaşam döngüsü ---
  room_full: 'This room already has two players. Ask your friend to leave, or create a new game.',
  room_not_found: 'We could not find that room. Check the code and try again.',
  room_exists: 'A room with that code already exists. Please try creating a new game.',
  invalid_code: 'That room code looks wrong. Codes are 6 letters/numbers (e.g. ABC123).',
  not_member: 'You are not part of this room anymore. Please rejoin with the invite link.',
  not_a_player: 'You are not part of this room anymore. Please rejoin with the invite link.',
  not_host: 'Only the host can start the match.',
  not_ready: 'Your rival is still connecting — try again in a moment.',
  already_started: 'This match has already started.',
  // --- Ağ / altyapı ---
  failed_to_fetch: 'We could not reach the game server. Check your internet connection and try again.',
  network_error: 'Connection lost. Check your internet and try again.',
  timeout: 'The server took too long to respond. Please try again.',
}

/** Bilinen bir kod mu? (ham mesajın içinde geçiyor olabilir) */
const findKnown = (raw: string): string | null => {
  const lower = raw.toLowerCase()
  for (const [code, message] of Object.entries(MESSAGES)) {
    if (lower.includes(code)) return message
  }
  return null
}

/**
 * Ham hatayı kullanıcı dostu bir metne çevirir.
 *
 * @param err   Yakalanan hata (Error, string veya bilinmeyen).
 * @param fallback Eşleşme bulunamazsa gösterilecek genel mesaj.
 */
export const friendlyError = (err: unknown, fallback = 'Something went wrong. Please try again.'): string => {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : ''

  if (!raw) return fallback

  const known = findKnown(raw)
  if (known) return known

  // PostgREST bazen "PGRST202" / "schema cache" gibi mesajlar döner; bunlar
  // geliştiriciye hitap eder, oyuncuya anlam ifade etmez.
  const lower = raw.toLowerCase()
  if (lower.includes('pgrst') || lower.includes('schema cache') || lower.includes('function')) {
    return 'The game server is updating. Please refresh the page and try again.'
  }
  if (lower.includes('jwt') || lower.includes('permission') || lower.includes('denied')) {
    return 'You do not have permission to do that. Please refresh the page and try again.'
  }

  return fallback
}
