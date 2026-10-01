'use client'

import type { ReactNode } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'
import { useI18n } from '../../lib/i18n'

type Props = {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  children?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as a destructive action. */
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * A small confirmation dialog built on top of {@link Modal}.
 *
 * Replaces native `window.confirm` so the app keeps a consistent look and the
 * dialog is fully keyboard accessible (Escape cancels, focus is trapped).
 */
export function ConfirmDialog({
  open,
  title,
  subtitle,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n()
  return (
    <Modal
      open={open}
      title={title}
      subtitle={subtitle}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t(cancelLabel)}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
            data-autofocus
          >
            {busy ? t('Working…') : t(confirmLabel)}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
