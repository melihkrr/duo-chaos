'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { isMuted, toggleMuted, unlockAudio } from '../../lib/sound'

type Props = {
  code: string | null
  onLeave: () => void
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
export function TopBar({ code, onLeave }: Props) {
  const [muted, setMuted] = useState(() => isMuted())
  // Üç öğe tek satıra sığmıyor mu? True iken oda kodu alt satıra iner.
  const [wrapped, setWrapped] = useState(false)
  const barRef = useRef<HTMLElement | null>(null)
  const brandRef = useRef<HTMLDivElement | null>(null)
  const metaRef = useRef<HTMLDivElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)

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
          <span className="room-code">Room {code}</span>
        </div>
      )}

      <div className="topbar-actions" ref={actionsRef}>
        <Button
          variant="ghost"
          className="icon-btn"
          onClick={() => {
            unlockAudio()
            setMuted(toggleMuted())
          }}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🔊'}
        </Button>
        {code && (
          <Button variant="ghost" onClick={onLeave}>
            Leave
          </Button>
        )}
      </div>
    </header>
  )
}
