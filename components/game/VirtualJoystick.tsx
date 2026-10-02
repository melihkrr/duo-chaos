'use client'

import { useRef } from 'react'

type Props = {
  onChange: (dx: number, dy: number) => void
  size?: number
}

/**
 * DİNAMİK (YÜZEN) SANAL JOYSTICK.
 *
 * ÖNCEKİ DAVRANIŞ: Joystick ekranda SABİT bir konumda duruyordu; oyuncu yalnızca
 * o daireye dokunarak hareket edebiliyordu.
 *
 * YENİ DAVRANIŞ: Joystick'in kalıcı bir konumu YOKTUR. Oyuncu oyun alanında
 * (arena) HERHANGİ bir yere dokunduğunda joystick TAM O DOKUNMA NOKTASINDA
 * oluşur; parmağını sürükleyerek yön verir; parmağını kaldırdığında kaybolur.
 * Bir sonraki dokunma yeni bir konumda yeni bir joystick başlatır.
 *
 * TASARIM NOTLARI:
 *   - Yakalama katmanı (`.joystick-layer`) arena'yı kaplar; yalnızca oyun
 *     alanındaki dokunmaları yakalar. Butonlar/menüler/HUD bu katmanın
 *     DIŞINDA kaldığı için onlara dokunmak joystick'i tetiklemez.
 *   - `touch-action: none` + `preventDefault` ile sayfa kaydırma/zoom gibi
 *     tarayıcı hareketleri oyun sırasında engellenir.
 *   - Knob konumu React state yerine DOĞRUDAN DOM'a (`transform`) yazılır;
 *     `onChange` da oyun döngüsünün ref'ine yazar. Böylece pointer olayı →
 *     girdi vektörü yolu render'sız, senkron ve gecikmesizdir (joystick lag yok).
 *   - ÇOK DOKUNMATİK GÜVENLİĞİ: Yalnızca İLK dokunan pointer kimliği
 *     (`pointerId`) takip edilir. İkinci bir parmak yok sayılır; böylece
 *     yanlışlıkla ikinci bir joystick oluşmaz veya girdi ikiye katlanmaz.
 *   - Yarıçap/deadzone/maksimum mesafe davranışı KORUNUR: vektör, dokunma
 *     noktasından olan uzaklığın `size/2` yarıçapına bölünmesiyle -1..1
 *     aralığına normalize edilir ve uzunluk 1'i aşarsa kırpılır.
 */
export function VirtualJoystick({ onChange, size = 132 }: Props) {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const baseRef = useRef<HTMLDivElement | null>(null)
  const knobRef = useRef<HTMLSpanElement | null>(null)
  // Etkin pointer kimliği. `null` ise joystick kapalıdır.
  const pointerId = useRef<number | null>(null)
  // Dokunmanın başladığı ekran koordinatları (joystick merkezi).
  const originX = useRef(0)
  const originY = useRef(0)
  const radius = size / 2

  // Knob'u doğrudan DOM'a uygula (React render'ı yok).
  const paintKnob = (x: number, y: number) => {
    const knob = knobRef.current
    if (knob) knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`
  }

  // Joystick tabanını dokunma noktasına yerleştir ve görünür yap.
  const showBaseAt = (clientX: number, clientY: number) => {
    const layer = layerRef.current
    const base = baseRef.current
    if (!layer || !base) return
    const rect = layer.getBoundingClientRect()
    // Tabanı katman içindeki yerel koordinatlara yerleştir.
    base.style.left = `${clientX - rect.left}px`
    base.style.top = `${clientY - rect.top}px`
    base.style.opacity = '1'
  }

  const hideBase = () => {
    const base = baseRef.current
    if (base) base.style.opacity = '0'
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
        // ÇOK DOKUNMATİK: Zaten etkin bir pointer varsa yeni dokunmayı yok say.
        if (pointerId.current !== null) return
        // Yalnızca birincil (sol) fare düğmesi / dokunma kabul edilir.
        if (event.pointerType === 'mouse' && event.button !== 0) return
        pointerId.current = event.pointerId
        originX.current = event.clientX
        originY.current = event.clientY
        // Dokunma noktasını tam merkez al: joystick orada oluşur.
        showBaseAt(event.clientX, event.clientY)
        paintKnob(0, 0)
        // Pointer'ı yakala: parmak katmanın dışına çıksa bile olaylar bize gelir.
        event.currentTarget.setPointerCapture(event.pointerId)
        // Tarayıcı jestlerini (kaydırma/zoom) engelle.
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
      <div ref={baseRef} className="joystick" style={{ width: size, height: size }}>
        <span ref={knobRef} className="joystick-knob" style={{ transform: 'translate(0px, 0px)' }} />
      </div>
    </div>
  )
}
