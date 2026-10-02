'use client'

/**
 * ORTAK GİRDİ SIFIRLAMA YARDIMCILARI.
 *
 * KÖK SORUN (kullanıcı raporu):
 *   "Round bittiğinde basılı olan son tuşun / joystick yönünün input state'i
 *    temizlenmiyor. Yeni round başladığında oyuncu hiçbir tuşa basmıyor olsa
 *    bile son input hâlâ aktif kabul ediliyor ve karakter otomatik hareket
 *    etmeye devam ediyor."
 *
 * NEDEN OLUYOR:
 *   Hareket girdisi React state'inde DEĞİL, 60Hz döngünün render'sız çalışması
 *   için uzun ömürlü ref'lerde / modül seviyesinde tutulur (`keys`, `joystick`).
 *   Bu değerler yalnızca `keydown`/`keyup` ve pointer olaylarıyla güncellenir.
 *   Round geçişi sırasında:
 *     * `keyup` kaçırılabilir (round tam tuş basılıyken biter, sekme odağı
 *       değişir, tarayıcı olayı düşürür) → `keys.up` sonsuza dek `true` kalır.
 *     * Joystick parmağı ekranda kalmışsa vektör sıfırlanmaz.
 *   Sonuç: yeni round'da oyuncu hiçbir şeye basmasa da hareket devam eder.
 *
 * ÇÖZÜM:
 *   Round geçişinde, faz çıkışında ve sekme görünürlük/odak değişiminde TÜM
 *   girdi durumunu (klavye + joystick + gamepad) TEK bir yerden sıfırlarız.
 *   Böylece yeni round KESİNLİKLE NEUTRAL (0) girdiyle başlar.
 */

/** Klavye hareket bayrakları. `useGameLoop` ve `useBotGame` bunu paylaşır. */
export type KeyState = {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

/** Sıfırlanabilir joystick vektörü. */
export type JoystickState = { x: number; y: number }

/** Yeni, tamamen nötr bir klavye durumu üretir. */
export const neutralKeys = (): KeyState => ({
  up: false,
  down: false,
  left: false,
  right: false,
})

/**
 * Klavye bayraklarını YERİNDE sıfırlar (referansı korur; ref.current'a yazmak
 * için uygundur). `keys.up = keys.down = ... = false` ile aynıdır.
 */
export const resetKeys = (keys: KeyState): void => {
  keys.up = false
  keys.down = false
  keys.left = false
  keys.right = false
}

/** Joystick vektörünü YERİNDE sıfırlar (referansı korur). */
export const resetJoystick = (joystick: JoystickState): void => {
  joystick.x = 0
  joystick.y = 0
}

/**
 * Bağlı gamepad'lerin (varsa) analog çubuklarını nötrler.
 *
 * NOT: Tarayıcı gamepad API'si "reset" sunmaz; ancak `navigator.getGamepads()`
 * her karede canlı okunur. Yine de round geçişinde eski bir `axes` örneğinin
 * döngüye taşınmaması için çağıran taraf gamepad okumasını bu bayrakla
 * atlayabilir. Burada yalnızca güvenli bir no-op/guard sağlarız; asıl sıfırlama
 * `gamepadResetAt` zaman damgasıyla yapılır.
 */
export const resetGamepads = (): void => {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return
  try {
    // `getGamepads()` çağrısı, tarayıcının iç gamepad durumunu tazelemesini
    // tetikler. Bağlantı kopmuş bir gamepad'in bayat `axes` değerini okumayı
    // bırakmak için çağıran taraf `gamepadResetAt` sonrası ilk kareyi atlar.
    navigator.getGamepads()
  } catch {
    /* gamepad API yoksa yok say */
  }
}

/**
 * TÜM hareket girdisini sıfırlar: klavye + joystick + gamepad.
 *
 * Round geçişi, faz çıkışı, `blur` ve `visibilitychange` için TEK giriş
 * noktasıdır. Çağıran taraf yalnızca elindeki ref'leri geçirir.
 */
export const resetAllInput = (input: {
  keys?: KeyState | null
  joystick?: JoystickState | null
}): void => {
  if (input.keys) resetKeys(input.keys)
  if (input.joystick) resetJoystick(input.joystick)
  resetGamepads()
}

/**
 * Sekme görünürlük/odak olaylarını dinler ve her geri dönüşte girdiyi sıfırlar.
 *
 * NEDEN: Sekme arka plana düşünce tarayıcı `keyup` olayını GÖNDERMEZ. Oyuncu
 * `W` basılıyken sekmeyi değiştirirse, geri döndüğünde `keys.up` hâlâ `true`
 * kalır ve karakter kendi kendine hareket eder ("stuck key"). `blur` +
 * `visibilitychange` + `pagehide` üçlüsü bu durumu kapatır.
 *
 * @returns temizleme (cleanup) fonksiyonu.
 */
export const installInputResetListeners = (reset: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined
  const onVisibility = () => {
    // Yalnızca sekme GÖRÜNÜR olduğunda değil, gizlenirken de sıfırlarız:
    // gizlenme anında tuş bırakma olayı gelmeyeceği için bayrağı hemen
    // temizlemek en güvenlisidir.
    reset()
  }
  const onBlur = () => reset()
  const onPageHide = () => reset()
  window.addEventListener('blur', onBlur)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
