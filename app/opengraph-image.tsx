import { ImageResponse } from 'next/og'

/**
 * Dinamik OpenGraph/Twitter paylaşım görseli (1200×630).
 *
 * `next/og` ile sunucuda üretilir; harici bir statik görsel dosyasına ihtiyaç
 * duymadan marka tutarlı bir önizleme sağlar. `app/opengraph-image.tsx`
 * konvansiyonu sayesinde Next.js bunu otomatik olarak `og:image` ve
 * `twitter:image` meta etiketlerine bağlar.
 */
export const alt = 'DUO CHAOS — a two-player party game of secret objectives and chaos'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #fff7fb 0%, #ffe9f4 45%, #e9f0ff 100%)',
          fontFamily: 'sans-serif',
          padding: '72px',
          position: 'relative',
        }}
      >
        {/* Dekoratif renk lekeleri */}
        <div
          style={{
            position: 'absolute',
            top: -120,
            left: -80,
            width: 420,
            height: 420,
            borderRadius: 9999,
            background: 'rgba(255, 122, 182, 0.28)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: -140,
            right: -60,
            width: 460,
            height: 460,
            borderRadius: 9999,
            background: 'rgba(122, 162, 255, 0.26)',
          }}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            padding: '10px 26px',
            borderRadius: 9999,
            background: '#ffffff',
            border: '3px solid #2b2440',
            fontSize: 26,
            fontWeight: 800,
            color: '#2b2440',
            letterSpacing: 1,
          }}
        >
          <span>2 PLAYERS</span>
          <span style={{ opacity: 0.4 }}>•</span>
          <span>FREE TO PLAY</span>
        </div>

        <div
          style={{
            marginTop: 34,
            fontSize: 132,
            fontWeight: 900,
            color: '#2b2440',
            letterSpacing: -3,
            lineHeight: 1,
            textAlign: 'center',
          }}
        >
          DUO CHAOS
        </div>

        <div
          style={{
            marginTop: 26,
            fontSize: 44,
            fontWeight: 800,
            color: '#7a3fb8',
            textAlign: 'center',
          }}
        >
          See it. Steal it. Win it.
        </div>

        <div
          style={{
            marginTop: 30,
            fontSize: 28,
            fontWeight: 600,
            color: '#5b5470',
            textAlign: 'center',
            maxWidth: 900,
          }}
        >
          Secret objectives, shared resources, and chaos events — a fast,
          replayable two-player party game in your browser.
        </div>
      </div>
    ),
    { ...size },
  )
}
