'use client'

import { useRef } from 'react'

type Props = {
  onChange: (dx: number, dy: number) => void
  size?: number
}

/**
 * Dokunmatik/pointer için sanal joystick. -1..1 aralığında vektör üretir.
 *
 * KÖK SORUN (JOYSTICK GECİKMESİ): Önceden her `pointermove` olayında
 * `setKnob(...)` (React state) çağrılıyordu. Bu, saniyede onlarca kez React
 * render'ı tetikliyor; render kuyruğu biriktiğinde girdi işleme gecikiyor ve
 * karakter joystick'e geç tepki veriyordu ("joystick lag").
 *
 * ÇÖZÜM: Knob konumunu React state yerine DOĞRUDAN DOM'a (`transform`) yazarız.
 * `onChange` da zaten oyun döngüsünün ref'ine yazar (render tetiklemez). Böylece
 * pointer olayı → girdi vektörü yolu tamamen render'sız, senkron ve gecikmesiz
 * olur. Bileşen artık pointer hareketinde HİÇ yeniden render edilmez.
 */
export function VirtualJoystick({ onChange, size = 132 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)
  const knobRef = useRef<HTMLSpanElement | null>(null)
  const active = useRef(false)

  // Knob'u doğrudan DOM'a uygula (React render'ı yok).
  const paintKnob = (x: number, y: number) => {
    const knob = knobRef.current
    if (knob) knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`
  }

  const update = (clientX: number, clientY: number) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const radius = rect.width / 2
    let dx = (clientX - cx) / radius
    let dy = (clientY - cy) / radius
    const length = Math.hypot(dx, dy)
    if (length > 1) {
      dx /= length
      dy /= length
    }
    paintKnob(dx, dy)
    onChange(dx, dy)
  }

  const end = () => {
    active.current = false
    paintKnob(0, 0)
    onChange(0, 0)
  }

  return (
    <div
      ref={ref}
      className="joystick"
      style={{ width: size, height: size }}
      onPointerDown={(event) => {
        active.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        update(event.clientX, event.clientY)
      }}
      onPointerMove={(event) => {
        if (active.current) update(event.clientX, event.clientY)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={() => {
        if (active.current) end()
      }}
    >
      <span ref={knobRef} className="joystick-knob" style={{ transform: 'translate(0px, 0px)' }} />
    </div>
  )
}
