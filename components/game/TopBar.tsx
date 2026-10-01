'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { isMuted, toggleMuted, unlockAudio } from '../../lib/sound'
import { useI18n } from '../../lib/i18n'

type Props = {
  code: string | null
  onLeave: () => void
  /**
   * Oda kodu olmasa bile "Leave" butonunu göster. Tek oyunculu (bot) modda
   * oda kodu YOKTUR ama kullanıcı yine de maçtan ayrılabilmelidir; bu yüzden
   * bot modunda `true` geçirilir.
   */
  showLeave?: boolean
  showLanguage?: boolean
}

/**
 * Üst çubuk. Yalnızca oda kodu (varsa) gösterilir.
 *
 * YERLEŞİM KURALI (kullanıcı isteği):
 *   - SIĞDIĞINDA: marka (DUO CHAOS) solda, oda kodu TAM ORTADA, butonlar sağda
 *     — hepsi TEK satırda.
 *   - SIĞMADIĞINDA: marka (solda) + butonlar (sağda) AYNI satırda kalır; oda
 *     kodu ALT satıra iner ve ORTALANIR.
 *
 * Neden JS ölçümü? Saf CSS `flex-wrap` ile "sadece ortadaki öğeyi alta al"
 * davranışı GÜVENİLİR değildir: tarayıcı taşan öğeyi (bazen butonları) alta
 * alabilir. Bu yüzden üç öğenin doğal genişliklerini ölçüp sığıp sığmadığına
 * KESİN karar veririz ve `topbar-wrapped` sınıfını buna göre uygularız.
 */
export function TopBar({ code, onLeave, showLeave = false, showLanguage = false }: Props) {
  const { language, setLanguage, t } = useI18n()
  const [muted, setMuted] = useState(() => isMuted())
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
  // Üç öğe tek satıra sığmıyor mu? True iken oda kodu alt satıra iner.
  const [wrapped, setWrapped] = useState(false)
  const barRef = useRef<HTMLElement | null>(null)
  const brandRef = useRef<HTMLDivElement | null>(null)
  const metaRef = useRef<HTMLDivElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const languagePickerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!languageMenuOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!languagePickerRef.current?.contains(event.target as Node)) setLanguageMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLanguageMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [languageMenuOpen])

  // Ölçüm: marka + oda kodu + butonların doğal genişlikleri + aralarındaki
  // boşluklar, çubuğun iç genişliğine sığıyor mu? Sığmıyorsa `wrapped = true`.
  //
  // `useLayoutEffect` ile boyamadan ÖNCE ölçeriz; böylece ilk karede yanlış
  // (sığmış gibi) görünüp sonra zıplama olmaz. `ResizeObserver` ile pencere ve
  // içerik değişimlerinde yeniden ölçeriz.
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return

    // Bir flex konteynerinin DOĞAL (içerik) genişliğini hesaplar. Konteynerin
    // kendi `scrollWidth`'i GÜVENİLMEZ: `flex: 1 1 auto` ile esnediğinde
    // ESKİMİŞ (tüm satırı kaplayan) genişliği döndürür ve öğeler sığsa bile
    // "sığmıyor" sonucu çıkar. Bu yüzden çocukların genişliklerini + aralarındaki
    // boşlukları toplayarak gerçek içerik genişliğini buluruz.
    const naturalWidth = (el: HTMLElement): number => {
      const styles = window.getComputedStyle(el)
      const gap = parseFloat(styles.columnGap || styles.gap) || 0
      const children = Array.from(el.children) as HTMLElement[]
      if (children.length === 0) return 0
      const sum = children.reduce((total, child) => total + child.getBoundingClientRect().width, 0)
      return sum + gap * (children.length - 1)
    }

    const measure = () => {
      const brand = brandRef.current
      const meta = metaRef.current
      const actions = actionsRef.current
      if (!brand || !actions) return

      // Çubuğun içerik kutusu genişliği (padding hariç).
      const styles = window.getComputedStyle(bar)
      const padLeft = parseFloat(styles.paddingLeft) || 0
      const padRight = parseFloat(styles.paddingRight) || 0
      const gap = parseFloat(styles.columnGap || styles.gap) || 0
      const available = bar.clientWidth - padLeft - padRight

      // Her öğenin DOĞAL içerik genişliği (esnemiş genişlik DEĞİL).
      const brandW = naturalWidth(brand)
      const actionsW = naturalWidth(actions)
      const metaW = meta ? naturalWidth(meta) : 0

      // Tek satırda gereken toplam genişlik: 3 öğe + 2 boşluk.
      const needed = brandW + metaW + actionsW + gap * 2
      setWrapped(needed > available + 1)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    if (brandRef.current) observer.observe(brandRef.current)
    if (metaRef.current) observer.observe(metaRef.current)
    if (actionsRef.current) observer.observe(actionsRef.current)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [code])

  // Yazı tipi yüklendikten sonra genişlikler değişebilir; bir kez daha ölç.
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      window.dispatchEvent(new Event('resize'))
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <header
      ref={barRef}
      className={['topbar', code ? 'topbar-sticky' : '', wrapped ? 'topbar-wrapped' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {/* ÜÇ ÖĞE: marka (sol), oda kodu (TAM ORTA), aksiyonlar (sağ).
          Sığdığında tek satırda kalırlar. Sığmadığında (`topbar-wrapped`)
          oda kodu `flex-basis: 100%` ile ALT satıra iner ve ortalanır; marka
          ile aksiyonlar üst satırda (solda/sağda) kalır. */}
      <div className="brand" ref={brandRef}>
        <span className="brand-mark">DC</span>
        <strong>DUO CHAOS</strong>
      </div>

      {code && (
        <div className="topbar-meta" ref={metaRef}>
          <span className="room-code">{t('Room {code}', { code })}</span>
        </div>
      )}

      <div className="topbar-actions" ref={actionsRef}>
        {showLanguage && (
          <div className="language-picker" ref={languagePickerRef}>
            <button
              type="button"
              className="language-trigger"
              aria-label={t('Select language')}
              aria-expanded={languageMenuOpen}
              aria-haspopup="listbox"
              onClick={() => setLanguageMenuOpen((open) => !open)}
            >
              <LanguageFlag language={language} />
              <span>{language.toUpperCase()}</span>
              <svg className="language-chevron" viewBox="0 0 12 8" aria-hidden="true">
                <path d="m1 1 5 5 5-5" />
              </svg>
            </button>
            {languageMenuOpen && (
              <div className="language-menu" role="listbox" aria-label={t('Select language')}>
                {(['tr', 'en'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="option"
                    aria-selected={language === option}
                    className={`language-option${language === option ? ' selected' : ''}`}
                    onClick={() => {
                      setLanguage(option)
                      setLanguageMenuOpen(false)
                    }}
                  >
                    <LanguageFlag language={option} />
                    <span>{option === 'tr' ? t('Turkish') : t('English')}</span>
                    <span className="language-option-code">{option.toUpperCase()}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <Button
          variant="ghost"
          className="icon-btn"
          onClick={() => {
            unlockAudio()
            setMuted(toggleMuted())
          }}
          aria-label={muted ? t('Unmute') : t('Mute')}
        >
          {muted ? '🔇' : '🔊'}
        </Button>
        {(code || showLeave) && (
          <Button variant="ghost" onClick={onLeave}>
            {t('Leave')}
          </Button>
        )}
      </div>
    </header>
  )
}

function LanguageFlag({ language }: { language: 'en' | 'tr' }) {
  return language === 'tr' ? (
    <svg className="language-flag" viewBox="0 0 24 16" aria-hidden="true">
      <rect width="24" height="16" rx="2" fill="#e30a17" />
      <circle cx="10" cy="8" r="4.2" fill="#fff" />
      <circle cx="11.3" cy="8" r="3.35" fill="#e30a17" />
      <path d="m15.1 5.35.8 1.86 2-.15-1.53 1.3.5 1.94-1.77-1.05-1.7 1.16.42-1.96-1.58-1.21 2 .04z" fill="#fff" />
    </svg>
  ) : (
    <svg className="language-flag" viewBox="0 0 24 16" aria-hidden="true">
      <rect width="24" height="16" rx="2" fill="#012169" />
      <path d="m0 0 24 16M24 0 0 16" stroke="#fff" strokeWidth="4" />
      <path d="m0 0 24 16M24 0 0 16" stroke="#c8102e" strokeWidth="1.7" />
      <path d="M12 0v16M0 8h24" stroke="#fff" strokeWidth="6" />
      <path d="M12 0v16M0 8h24" stroke="#c8102e" strokeWidth="3" />
    </svg>
  )
}
