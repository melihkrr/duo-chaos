/**
 * SEO sabitleri ve yardımcıları.
 *
 * Tek bir kaynaktan (single source of truth) beslenir; `app/layout.tsx`,
 * `app/robots.ts`, `app/sitemap.ts` ve JSON-LD yapılandırılmış verisi bu
 * dosyayı kullanır. Böylece başlık/açıklama/URL tutarsızlıkları oluşmaz.
 */

/**
 * Üretim alan adı. Vercel'de `NEXT_PUBLIC_SITE_URL` tanımlıysa o kullanılır;
 * aksi halde makul bir varsayılana düşülür. `metadataBase` göreli OG/Twitter
 * görsel URL'lerini mutlak URL'lere çevirmek için ZORUNLUDUR.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://duo-chaos.vercel.app'
).replace(/\/$/, '')

export const SITE_NAME = 'DUO CHAOS'

export const SITE_TITLE = 'DUO CHAOS — See it. Grab it. Win it.'

export const SITE_DESCRIPTION =
  'DUO CHAOS is a fast, replayable two-player party game. Race your rival for shared resources, complete secret objectives, and survive chaos events. Play free in your browser — no download required.'

export const SITE_KEYWORDS = [
  'DUO CHAOS',
  'two player game',
  '2 player party game',
  'local multiplayer',
  'online party game',
  'browser game',
  'free online game',
  'secret objectives',
  'chaos events',
  'risky coins',
  'competitive arcade game',
  'play with friends',
  'no download game',
  'Roblox style party game',
]

export const SITE_LOCALE = 'en_US'

/** Sosyal paylaşım görseli (OpenGraph/Twitter). */
export const OG_IMAGE = {
  url: '/opengraph-image',
  width: 1200,
  height: 630,
  alt: 'DUO CHAOS — a two-player party game of secret objectives and chaos',
}

/**
 * JSON-LD yapılandırılmış verisi (schema.org VideoGame + WebApplication).
 * Google'ın zengin sonuçlarında ve sosyal önizlemelerde oyunun doğru
 * sınıflandırılmasını sağlar.
 */
export const structuredData = () => ({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': ['VideoGame', 'WebApplication'],
      '@id': `${SITE_URL}/#game`,
      name: SITE_NAME,
      alternateName: 'Duo Chaos Party Game',
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      applicationCategory: 'GameApplication',
      applicationSubCategory: 'Party Game',
      operatingSystem: 'Web browser',
      browserRequirements: 'Requires JavaScript and WebGL',
      genre: ['Party', 'Arcade', 'Competitive'],
      gamePlatform: ['Web browser', 'Mobile web'],
      playMode: ['MultiPlayer', 'CoOp'],
      numberOfPlayers: {
        '@type': 'QuantitativeValue',
        minValue: 2,
        maxValue: 2,
      },
      inLanguage: 'en',
      isAccessibleForFree: true,
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
        availability: 'https://schema.org/InStock',
      },
      image: `${SITE_URL}${OG_IMAGE.url}`,
      publisher: {
        '@type': 'Organization',
        name: SITE_NAME,
        url: SITE_URL,
      },
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      inLanguage: 'en',
      publisher: { '@id': `${SITE_URL}/#game` },
    },
  ],
})
