'use client'

import { useCallback, useRef, useState } from 'react'
import type { ToastMessage, ToastTone } from '../components/ui/Toast'

export type ToastApi = {
  toasts: ToastMessage[]
  /** Show a toast; returns its id. */
  push: (text: string, tone?: ToastTone) => number
  dismiss: (id: number) => void
}

/**
 * Minimal toast queue. Keeps user feedback inside the app instead of using
 * native `alert`/`prompt` dialogs.
 */
export const useToast = (): ToastApi => {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback((text: string, tone: ToastTone = 'info') => {
    const id = nextId.current++
    setToasts((prev) => [...prev, { id, text, tone }])
    return id
  }, [])

  return { toasts, push, dismiss }
}
