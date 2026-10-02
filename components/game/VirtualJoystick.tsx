'use client'

import { useRef } from 'react'

type Props = {
  onChange: (dx: number, dy: number) => void
  size?: number
}

/**
 * DİNAMİK (YÜZEN) SANAL JOYSTICK.
 *
 * Başlangıçta görünmez. Oyuncu arena'nın herhangi bir yerine dokunduğunda
 * joystick orada belirir ve parmak kalkınca kaybolur.
 *
 * TASARIM NOTLARI:
 *   - Şeffaf katman arena'yı kaplar ve arena dokunuşlarını yakalar. HUD/menü
 *     kontrolleri arena dışında kaldığından joystick girdisini tetiklemez.
 *   - `touch-action: none` + `preventDefault` ile sayfa kaydırma/zoom gibi
 *     tarayıcı hareketleri oyun sırasında engellenir.
 *   - Knob konumu React state yerine DOĞRUDAN DOM'a (`transform`) yazılır;
 *     `onChange` da oyun döngüsünün ref'ine yazar. Böylece pointer olayı →
 *     girdi vektörü yolu render'sız, senkron ve gecikmesizdir (joystick lag yok).
 *   - ÇOK DOKUNMATİK GÜVENLİĞİ: Yalnızca İLK dokunan pointer kimliği
 *     (`pointerId`) takip edilir. İkinci bir parmak yok sayılır; böylece
 *     yanlışlıkla ikinci bir joystick oluşmaz veya girdi ikiye katlanmaz.
 *   - Girdi yarıçapı tabandan küçüktür; böylece kısa başparmak hareketleri
 *     yönü daha çabuk etkiler. Azami hız değişmez.
 */
export function VirtualJoystick({ onChange, size = 132 }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const baseRef = useRef<HTMLDivElement | null>(null)
  const knobRef = useRef<HTMLSpanElement | null>(null)
  // Etkin pointer kimliği. `null` ise joystick kullanılmıyordur.
  const pointerId = useRef<number | null>(null)
  // Joystick merkezinin ekran koordinatları.
  const originX = useRef(0)
  const originY = useRef(0)
  const radius = size * 0.36

  const showBaseAt = (clientX: number, clientY: number) => {
    const layer = layerRef.current
    const base = baseRef.current
    if (!layer || !base) return
    const rect = layer.getBoundingClientRect()
    const inset = size / 2 + 8
    const centerX = Math.max(inset, Math.min(rect.width - inset, clientX - rect.left))
    const centerY = Math.max(inset, Math.min(rect.height - inset, clientY - rect.top))
    base.style.left = `${centerX}px`
    base.style.top = `${centerY}px`
    base.style.opacity = '0.8'
  }

  const hideBase = () => {
    const base = baseRef.current
    if (base) base.style.opacity = '0'
  }

  // Knob'u doğrudan DOM'a uygula (React render'ı yok).
  const paintKnob = (x: number, y: number) => {
    const knob = knobRef.current
    if (knob) knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`
  }

  const update = (clientX: number, clientY: number) => {
    let dx = (clientX - originX.current) / radius
    let dy = (clientY - originY.current) / radius
    const length = Math.hypot(dx, dy)
    if (length > 1) {
      dx /= length
      dy /= length
    }
    paintKnob(dx, dy)
    onChange(dx, dy)
  }

  const end = () => {
    pointerId.current = null
    paintKnob(0, 0)
    hideBase()
    onChange(0, 0)
  }

  return (
    <div
      ref={layerRef}
      className="joystick-layer"
      onPointerDown={(event) => {
        if (pointerId.current !== null) return
        if (event.pointerType === 'mouse' && event.button !== 0) return
        pointerId.current = event.pointerId
        originX.current = event.clientX
        originY.current = event.clientY
        showBaseAt(event.clientX, event.clientY)
        paintKnob(0, 0)
        event.currentTarget.setPointerCapture(event.pointerId)
        update(event.clientX, event.clientY)
        event.preventDefault()
      }}
      onPointerMove={(event) => {
        if (pointerId.current !== event.pointerId) return
        update(event.clientX, event.clientY)
        event.preventDefault()
      }}
      onPointerUp={(event) => {
        if (pointerId.current !== event.pointerId) return
        end()
      }}
      onPointerCancel={(event) => {
        if (pointerId.current !== event.pointerId) return
        end()
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={baseRef}
        className="joystick"
        style={{ width: size, height: size }}
      >
        <span ref={knobRef} className="joystick-knob" style={{ transform: 'translate(0px, 0px)' }} />
      </div>
    </div>
  )
}
