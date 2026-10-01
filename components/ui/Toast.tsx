'use client'

import { useEffect } from 'react'
import { localizedText, useI18n } from '../../lib/i18n'

export type ToastTone = 'info' | 'success' | 'error'

export type ToastMessage = {
  id: number
  text: string
  tone: ToastTone
}

type Props = {
  toasts: ToastMessage[]
  onDismiss: (id: number) => void
}

const ICON: Record<ToastTone, string> = {
  info: 'ℹ️',
  success: '✅',
  error: '⚠️',
}

/**
 * Non-blocking toast stack. Replaces native `alert`/`prompt` feedback so the
 * app never interrupts the player with a browser dialog.
 */
export function ToastStack({ toasts, onDismiss }: Props) {
  const { language } = useI18n()
  if (toasts.length === 0) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={{ ...toast, text: localizedText(toast.text, language) }}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  )
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  const { t } = useI18n()
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 4000)
    return () => window.clearTimeout(timer)
  }, [toast.id, onDismiss])

  return (
    <div className={`toast toast-${toast.tone}`}>
      <span className="toast-icon" aria-hidden>
        {ICON[toast.tone]}
      </span>
      <span className="toast-text">{toast.text}</span>
      <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label={t('Dismiss')}>
        ✕
      </button>
    </div>
  )
}
