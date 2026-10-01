import type { MetadataRoute } from 'next'
import { SITE_URL } from '../lib/seo'

/**
 * Dinamik `sitemap.xml`. Yalnızca herkese açık, indekslenebilir giriş
 * noktası olan ana sayfayı listeler. `/play/[code]` oda sayfaları kişiye
 * özel ve geçicidir; bu yüzden sitemap'e DAHİL EDİLMEZ (robots.txt'te de
 * taranmaz).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()

  return [
    {
      url: `${SITE_URL}/`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 1,
    },
  ]
}
