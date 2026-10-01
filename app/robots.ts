import type { MetadataRoute } from 'next'
import { SITE_URL } from '../lib/seo'

/**
 * Dinamik `robots.txt`. Arama motorlarına tüm herkese açık sayfaları
 * tarama izni verir; oyun içi API/oda yollarını ve Supabase fonksiyonlarını
 * taramadan hariç tutar. Sitemap konumu burada bildirilir.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/play/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
