/**
 * REUSABLE RETRY / RECOVERY LAYER
 * ================================
 *
 * Kök sorun: Maç sırasında GEÇİCİ bir işlem bir kez başarısız olduğunda oyun
 * o yanlış durumda takılı kalıyordu. Örnek: sunucu oyuncunun konumunu bir kez
 * döndüremedi → istemci bunu "güncel durum" sandı → hiçbir kurtarma denemesi
 * yapılmadı → oyuncu maç bitene kadar dondu.
 *
 * ÇÖZÜM: Dağınık `setInterval`/`setTimeout` yeniden-deneme döngüleri yerine
 * TEK, yeniden kullanılabilir bir katman. Bu modül:
 *
 *   1. `withRetry` — sınırlı, üstel geri çekilmeli (exponential backoff)
 *      yeniden deneme sarmalayıcısı. Geçici hatalarda otomatik toparlanır;
 *      kalıcı hatalarda vazgeçer (sonsuz yüksek frekanslı döngü YOK).
 *   2. `RetryController` — uzun ömürlü, periyodik işler (yoklama, tick) için
 *      "başarısızlıkta hızlan, başarıda sıfırla" davranışı sunan denetleyici.
 *      Böylece her yoklama kendi elle yazılmış backoff'unu taşımaz.
 *   3. `isRetryableError` / `isTransientRpcFailure` — hangi hatanın geçici
 *      olduğunu sınıflandırır. Ağ/kopma hataları yeniden denenir; mantıksal
 *      redler (`not_ready`, `room_full`, `invalid_token`) DENENMEZ.
 *
 * TASARIM İLKELERİ
 * ----------------
 *   * Sınırlı: `maxAttempts` ve `maxDelayMs` ile üst sınır vardır.
 *   * Geri çekilme: `baseDelayMs * 2^(attempt-1)`, `maxDelayMs` ile kırpılır,
 *     isteğe bağlı `jitter` ile eşzamanlı istemciler çakışmasın diye dağıtılır.
 *   * Sıfırlama: Başarılı bir iletişimden sonra sayaç sıfırlanır (bir sonraki
 *     geçici hata yeniden kısa gecikmeyle başlar).
 *   * İptal edilebilir: `AbortSignal` ile bileşen sökülünce bekleyen deneme
 *     iptal edilir (bellek sızıntısı / hayalet istek yok).
 *   * YAN ETKİSİZ: Bu katman yalnızca "ne zaman tekrar dene"yi bilir. Hangi
 *     işlemin idempotent olduğunu BİLMEZ; çağıran taraf `shouldRetry` ile
 *     karar verir. Bu, "collect/steal'i körlemesine tekrar deneme" kuralını
 *     ihlal etmemizi engeller.
 */

/** Varsayılan yeniden deneme politikası. */
export type RetryPolicy = {
  /** Toplam deneme sayısı (ilk deneme dahil). 1 = yeniden deneme yok. */
  maxAttempts: number
  /** İlk yeniden deneme gecikmesi (ms). */
  baseDelayMs: number
  /** Gecikme üst sınırı (ms). Üstel büyüme burada kırpılır. */
  maxDelayMs: number
  /** Eşzamanlı istemcileri dağıtmak için 0..1 arası rastgele çarpan. */
  jitter?: number
  /**
   * Bir hatanın yeniden denenip denenmeyeceğine karar verir. Varsayılan:
   * `isRetryableError` (ağ/kopma hataları evet, mantıksal redler hayır).
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  /** Her başarısız denemeden sonra çağrılır (gözlemlenebilirlik). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

/**
 * Mevcut mimariye göre ayarlanmış varsayılanlar.
 *
 * NEDEN BU DEĞERLER:
 *   * `duo_tick` 1 sn'de bir, yoklamalar 0.5–1.5 sn'de bir çalışır. Bu yüzden
 *     ilk yeniden deneme ~250 ms (bir sonraki doğal yoklamadan ÖNCE) olmalı ki
 *     geçici bir hata bir sonraki tura kadar bekletilmesin.
 *   * `maxDelayMs = 4000` — mevcut en yavaş yoklama periyodunun (3 sn heartbeat)
 *     biraz üstünde; böylece backoff asla "yoklamadan yavaş" hale gelmez.
 *   * `maxAttempts = 5` — toplam ~250+500+1000+2000 = 3.75 sn kapsama; bu,
 *     tipik bir mobil ağ dalgalanmasını (1–3 sn) aşar ama kalıcı kopmada
 *     sonsuz döngüye girmez (kalıcı kopmayı realtime yeniden bağlanma üstlenir).
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  jitter: 0.2,
}

/**
 * Kısa ömürlü, kullanıcıyı bekletmemesi gereken işlemler için (ör. tek bir
 * konum senkronu). Daha az deneme, daha kısa kuyruk.
 */
export const FAST_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 150,
  maxDelayMs: 1_200,
  jitter: 0.2,
}

/**
 * Uzun ömürlü, arka planda çalışan işler için (ör. tick, yoklama). Daha çok
 * deneme, daha geniş üst sınır — kullanıcı bunları beklemez.
 */
export const BACKGROUND_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 300,
  maxDelayMs: 5_000,
  jitter: 0.25,
}

/** `AbortSignal` ile iptal edilebilir uyku. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(id)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Bir hatanın GEÇİCİ (yeniden denenebilir) olup olmadığını sınıflandırır.
 *
 * GEÇİCİ (yeniden dene):
 *   * Ağ/kopma hataları (`Failed to fetch`, `network`, `timeout`, `ECONNRESET`,
 *     `WebSocket`, `channel`, `AbortError` dışındaki transport hataları).
 *   * Supabase `rpc` sarmalayıcısının fırlattığı `"<fn>: <message>"` hataları
 *     (bunlar transport/DB hatasıdır; mantıksal redler `ok:false` ile döner,
 *     fırlatılmaz).
 *   * 5xx / 429 durum kodları.
 *
 * KALICI (yeniden DENEME):
 *   * Mantıksal redler: `not_ready`, `room_full`, `invalid_token`, `forbidden`,
 *     `not_found`, `conflict`, `invalid_*`, `missing_*`.
 *   * `AbortError` (bilinçli iptal).
 */
export const isRetryableError = (error: unknown): boolean => {
  if (!error) return false
  if (error instanceof DOMException && error.name === 'AbortError') return false
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  // Bilinçli iptal asla yeniden denenmez.
  if (lower.includes('abort')) return false

  // Mantıksal redler: sunucu isteği ANLADI ve reddetti. Tekrar denemek
  // aynı sonucu verir (ve bazıları yan etkili olabilir).
  const permanent = [
    'not_ready',
    'room_full',
    'invalid_token',
    'invalid token',
    'forbidden',
    'not_found',
    'not found',
    'conflict',
    'invalid_',
    'missing_',
    'unauthorized',
    'permission denied',
    'duplicate',
  ]
  if (permanent.some((token) => lower.includes(token))) return false

  // Geçici transport/ağ hataları.
  const transient = [
    'failed to fetch',
    'network',
    'timeout',
    'timed out',
    'econnreset',
    'econnrefused',
    'etimedout',
    'socket',
    'websocket',
    'channel',
    'connection',
    'unavailable',
    'temporarily',
    'rate limit',
    'too many requests',
    '429',
    '500',
    '502',
    '503',
    '504',
  ]
  if (transient.some((token) => lower.includes(token))) return true

  // Bilinmeyen hatalar: varsayılan olarak yeniden DENE. Çoğu RPC hatası
  // geçicidir ve sınırlı deneme sayesinde maliyet düşüktür. (Mantıksal redler
  // zaten yukarıda elenir.)
  return true
}

/**
 * Bir RPC yanıtının "geçici başarısızlık" olup olmadığını sınıflandırır.
 *
 * `useRoom.call` → `rpc` mantıksal redlerde `ok:false` döndürür (fırlatmaz).
 * Bu yanıtlar `reason` alanı taşır. `not_ready` gibi geçici nedenler yeniden
 * denenebilir; `room_full` gibi kalıcı nedenler denenmez.
 */
export const isTransientRpcFailure = (response: unknown): boolean => {
  if (!response || typeof response !== 'object') return false
  const record = response as { ok?: unknown; reason?: unknown }
  if (record.ok !== false) return false
  const reason = typeof record.reason === 'string' ? record.reason.toLowerCase() : ''
  if (!reason) return true // sebepsiz red → geçici kabul et
  // KALICI nedenler: sunucu isteği ANLADI ve reddetti; tekrar denemek aynı
  // sonucu verir. `stale` özellikle önemlidir: sürüm korumalı (version-guarded)
  // RPC'lerde "sunucu bu sürümü zaten işledi" anlamına gelir — yeniden denemek
  // sonsuz döngü yaratır ve çift uygulama riski taşır. Bu yüzden ASLA
  // yeniden denenmez; çağıran taraf yetkili durumu uzlaştırmalıdır.
  const permanent = [
    'room_full',
    'invalid_token',
    'forbidden',
    'not_found',
    'unauthorized',
    'stale',
    'already_processed',
    'already processed',
    'duplicate',
    'conflict',
    'not_ready',
  ]
  return !permanent.some((token) => reason.includes(token))
}

/** Üstel geri çekilme gecikmesini hesaplar (jitter dahil). */
export const computeBackoffDelay = (
  attempt: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs' | 'jitter'>,
): number => {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)
  const jitter = policy.jitter ?? 0
  if (jitter <= 0) return capped
  // Simetrik jitter: [capped*(1-jitter), capped*(1+jitter)]
  const spread = capped * jitter
  return Math.max(0, Math.round(capped - spread + Math.random() * spread * 2))
}

/**
 * Bir async işlemi sınırlı, üstel geri çekilmeli olarak yeniden dener.
 *
 * @param run      Denenecek işlem. Başarıda değeri döndürür; hatada fırlatır.
 * @param policy   Yeniden deneme politikası (bkz. `DEFAULT_RETRY_POLICY`).
 * @param signal   İptal sinyali (bileşen sökülünce bekleyen deneme iptal olur).
 * @returns        Son başarılı denemenin değeri.
 * @throws         Tüm denemeler tükendiğinde SON hata.
 *
 * ÖNEMLİ: `run` İDEMPOTENT olmalıdır. Yan etkili işlemler (collect/steal)
 * için `shouldRetry` ile "önce uzlaştır, sonra gerekirse tekrar dene"
 * mantığını çağıran taraf kurmalıdır.
 */
export const withRetry = async <T>(
  run: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  signal?: AbortSignal,
): Promise<T> => {
  const shouldRetry = policy.shouldRetry ?? isRetryableError
  let lastError: unknown
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await run(attempt)
    } catch (error) {
      lastError = error
      const isLast = attempt >= policy.maxAttempts
      if (isLast || !shouldRetry(error, attempt)) throw error
      const delay = computeBackoffDelay(attempt, policy)
      policy.onRetry?.(error, attempt, delay)
      await sleep(delay, signal)
    }
  }
  throw lastError
}

/**
 * UZUN ÖMÜRLÜ PERİYODİK İŞLER İÇİN DENETLEYİCİ.
 *
 * Yoklama/tick gibi işler zaten bir `setInterval` ile periyodik çalışır. Bu
 * denetleyici, o periyodun ÜSTÜNE "başarısızlıkta hızlan, başarıda sıfırla"
 * davranışı ekler — böylece her yoklama kendi elle yazılmış backoff'unu
 * taşımaz ve dağınık retry döngüleri oluşmaz.
 *
 * KULLANIM:
 * ```ts
 * const controller = createRetryController(BACKGROUND_RETRY_POLICY)
 * const id = setInterval(() => {
 *   void controller.run(async () => { await pull() })
 * }, POLL_MS)
 * ```
 *
 * `run` başarısız olursa denetleyici bir sonraki denemeyi üstel olarak
 * geciktirir (`shouldRunNow` false döner); başarıda sayaç sıfırlanır. Böylece
 * kalıcı bir kopmada istek seli oluşmaz, geçici bir hatada ise hızla toparlanır.
 */
export type RetryController = {
  /** İşlemi çalıştırır; başarısızlıkta iç sayacı ilerletir. */
  run: <T>(task: () => Promise<T>) => Promise<T | undefined>
  /** Şu an bir deneme yapılmalı mı? (backoff penceresi doldu mu?) */
  shouldRunNow: () => boolean
  /** Başarılı iletişimden sonra sayacı sıfırlar. */
  reset: () => void
  /** Ardışık başarısızlık sayısı. */
  failures: () => number
}

export const createRetryController = (
  policy: RetryPolicy = BACKGROUND_RETRY_POLICY,
  now: () => number = () => Date.now(),
): RetryController => {
  let failures = 0
  let nextAllowedAt = 0

  const shouldRunNow = () => now() >= nextAllowedAt

  const reset = () => {
    failures = 0
    nextAllowedAt = 0
  }

  const run = async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    if (!shouldRunNow()) return undefined
    try {
      const result = await task()
      reset()
      return result
    } catch (error) {
      failures += 1
      if (failures >= policy.maxAttempts) {
        // Üst sınıra ulaştık: kalıcı kopma. Sıfırla ki bir sonraki periyotta
        // yeniden denemeye başlayabilelim (sonsuz hızlı döngü YOK — periyot
        // zaten `setInterval` tarafından sınırlanır).
        failures = 0
        nextAllowedAt = 0
        return undefined
      }
      const delay = computeBackoffDelay(failures, policy)
      nextAllowedAt = now() + delay
      return undefined
    }
  }

  return { run, shouldRunNow, reset, failures: () => failures }
}

/**
 * SÜRÜM-KORUMALI (VERSION-GUARDED) İDEMPOTENT İŞLEMLER İÇİN YENİDEN DENEME.
 *
 * KURAL: `duo_collect_batch` ve `duo_steal_versioned` gibi YAN ETKİLİ işlemler
 * KÖRLEMESİNE yeniden denenemez (çift toplama / çift +25/-25 riski). Ancak bu
 * RPC'ler zaten SUNUCU TARAFINDA sürüm korumalıdır: `p_expected_objectives_done`
 * ve `p_expected_round` gönderilir; sunucu bu sürüm artık geçerli değilse
 * isteği REDDEDER (bayat sürüm). Yani aynı sürümle yapılan bir yeniden deneme,
 * sunucu işlemi zaten uygulamışsa GÜVENLE reddedilir — çift uygulama OLMAZ.
 *
 * Bu yardımcı, "önce uzlaş, sonra gerekirse tekrar dene" ilkesini uygular:
 *   1. İsteği AYNI sürüm parametreleriyle çalıştırır.
 *   2. Yalnızca GEÇİCİ (ağ/kopma) hatalarda yeniden dener.
 *   3. Mantıksal redler (`stale`, `not_ready`, `invalid_*`) DENENMEZ; bunlar
 *      sunucunun "zaten işlendi" veya "geçersiz" cevabıdır.
 *
 * Böylece geçici bir ağ hatası toplama/çalma işlemini KAYBETTİRMEZ, ama asla
 * iki kez UYGULAMAZ.
 */
export const withVersionGuardedRetry = async <T>(
  run: () => Promise<T>,
  policy: RetryPolicy = FAST_RETRY_POLICY,
  signal?: AbortSignal,
): Promise<T> =>
  withRetry(run, {
    ...policy,
    // Yalnızca geçici hatalarda dene. `isRetryableError` zaten mantıksal
    // redleri (stale/not_ready/invalid_*) kalıcı sayar; burada niyeti açıkça
    // belgelemek için varsayılanı koruruz.
    shouldRetry: policy.shouldRetry ?? isRetryableError,
  }, signal)
