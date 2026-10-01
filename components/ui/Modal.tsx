'use client'

import { useCallback, useEffect, useRef, type ReactNode } from 'react'

type Props = {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  /** Optional footer actions (rendered right-aligned). */
  footer?: ReactNode
  /**
   * Arka plan (backdrop) görünümü:
   *   - `dim` (varsayılan): koyu + blur'lu arka plan (oyun içi/lobi).
   *   - `light`: neredeyse şeffaf arka plan (ana sayfa). Koyu arka plan
   *     ana sayfada "ekran karardı/siyah oldu" hissi veriyordu.
   */
  backdrop?: 'dim' | 'light'
}

/**
 * Accessible, styled modal dialog.
 *
 * Replaces native `window.prompt`/`alert` so the app keeps a consistent,
 * professional look. Handles:
 *   - Escape to close
 *   - backdrop click to close
 *   - focus trap + initial focus
 *   - body scroll lock
 *   - `role="dialog"` + `aria-modal`
 */
export function Modal({ open, title, subtitle, onClose, children, footer, backdrop = 'dim' }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  const focusFirst = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    // Prefer an explicitly marked element (e.g. the code input), otherwise
    // fall back to the first focusable node.
    const target =
      panel.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.querySelector<HTMLElement>(
        'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
      )
    target?.focus()
  }, [])

  // Escape to close + focus trap.
  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const nodes = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => !node.hasAttribute('disabled'))
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    const raf = window.requestAnimationFrame(focusFirst)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.cancelAnimationFrame(raf)
      previouslyFocused.current?.focus?.()
    }
  }, [open, onClose, focusFirst])

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className={['modal-backdrop', backdrop === 'light' ? 'modal-backdrop-light' : '']
        .filter(Boolean)
        .join(' ')}
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close dialog">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}
